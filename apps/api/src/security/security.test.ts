import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { secureHarness, SyntheticDevice, type Harness } from '../testing/secure-harness';
import { sha } from './primitives';
let h: Harness;
const password = 'isolated synthetic account password';
let owner: { cookie: string; csrfToken: string }, profileId: string;
beforeAll(async () => {
  h = await secureHarness();
  await h.security.bootstrap('owner', password);
  owner = await h.login('owner', password);
  const profile = await h.web(
    'POST',
    '/api/v1/profiles',
    owner,
    { name: 'Synthetic workspace' },
    { 'idempotency-key': randomUUID() },
  );
  expect(profile.status).toBe(200);
  profileId = profile.body.id as string;
});
afterAll(async () => {
  await h.close();
});
async function enroll(permission: 'read' | 'write' = 'write') {
  const device = new SyntheticDevice();
  const start = await device.send(
    h,
    'POST',
    '/api/v1/auth/enrollments',
    {
      deviceName: 'Synthetic client',
      os: 'macos',
      clientVersion: '0.1.0',
      codeChallenge: sha(device.verifier),
      state: device.state,
    },
    randomUUID(),
  );
  expect(start.status).toBe(200);
  const enrollmentId = start.body.enrollmentId as string;
  const approval = await h.web('POST', `/api/v1/auth/enrollments/${enrollmentId}/decision`, owner, {
    approve: true,
    grants: [{ profileId, permission }],
  });
  expect(approval.status).toBe(200);
  const uri = new URL(approval.body.redirectUri as string);
  const body = {
    grantType: 'authorization_code',
    enrollmentId,
    code: uri.searchParams.get('code')!,
    codeVerifier: device.verifier,
  };
  const key = randomUUID(),
    tokens = await device.send(h, 'POST', '/api/v1/auth/token', body, key, '');
  device.accept(tokens);
  return { device, body, key };
}
it('bootstraps once; web cookies, origin and CSRF are enforced', async () => {
  await expect(h.security.bootstrap('another', password)).rejects.toThrow('ALREADY_BOOTSTRAPPED');
  const noCookie = await h.send('GET', '/api/v1/auth/session');
  expect(noCookie.status).toBe(401);
  const session = await h.web('GET', '/api/v1/auth/session', owner);
  expect(session.body.user).toMatchObject({ username: 'owner' });
  expect(owner.cookie).not.toContain(password);
  const csrf = await h.send(
    'POST',
    '/api/v1/profiles',
    { name: 'Rejected' },
    { cookie: owner.cookie, origin: h.origin },
  );
  expect(csrf.body.code).toBe('CSRF_REJECTED');
  const cross = await h.send(
    'POST',
    '/api/v1/profiles',
    { name: 'Rejected' },
    { cookie: owner.cookie, origin: 'https://attacker.invalid', 'x-csrf-token': owner.csrfToken },
  );
  expect(cross.body.code).toBe('ORIGIN_REJECTED');
  const wrong = await h.send(
    'POST',
    '/api/v1/auth/login',
    { username: 'owner', password: 'wrong' },
    { origin: h.origin },
  );
  expect(wrong.body.code).toBe('LOGIN_FAILED');
  expect(
    (await h.send('POST', '/api/v1/auth/register', { username: 'public', password })).status,
  ).toBe(501);
});
it('enrolls a proof-bound device and recovers a lost token response idempotently', async () => {
  const { device, body, key } = await enroll();
  const retry = await device.send(h, 'POST', '/api/v1/auth/token', body, key, '');
  expect(retry.body.accessToken === device.accessToken).toBe(true);
  expect(retry.body.refreshToken === device.refreshToken).toBe(true);
  const profiles = await device.send(h, 'GET', '/api/v1/profiles');
  expect(profiles.status).toBe(200);
  expect(profiles.body.profiles).toHaveLength(1);
  const wrongKeyDevice = new SyntheticDevice();
  wrongKeyDevice.accessToken = device.accessToken;
  expect((await wrongKeyDevice.send(h, 'GET', '/api/v1/profiles')).status).toBe(401);
  const path = '/api/v1/profiles',
    proof = device.proof(h, 'GET', path);
  const first = await h.send('GET', path, undefined, {
    authorization: 'DPoP ' + device.accessToken,
    dpop: proof,
  });
  expect(first.status).toBe(200);
  const replay = await h.send('GET', path, undefined, {
    authorization: 'DPoP ' + device.accessToken,
    dpop: proof,
  });
  expect(replay.body.code).toBe('DPOP_REPLAY');
  const mismatched = await h.send('GET', path, undefined, {
    authorization: 'DPoP ' + device.accessToken,
    dpop: device.proof(h, 'GET', path, { htm: 'POST' }),
  });
  expect(mismatched.body.code).toBe('INVALID_DPOP');
  const data =
    JSON.stringify(await h.db.query('SELECT * FROM token_deliveries')) +
    JSON.stringify(await h.db.query('SELECT * FROM device_credentials')) +
    JSON.stringify(await h.db.query('SELECT * FROM audit_events'));
  for (const value of [device.accessToken, device.refreshToken, password, body.code])
    expect(data.includes(value)).toBe(false);
});
it('rotates refresh credentials, retries delivery, and rejects reuse', async () => {
  const { device } = await enroll(),
    old = device.refreshToken,
    key = randomUUID(),
    body = { grantType: 'refresh_token', refreshToken: old };
  const refresh = await device.send(h, 'POST', '/api/v1/auth/token', body, key, '');
  expect(refresh.status).toBe(200);
  expect(
    JSON.stringify((await device.send(h, 'POST', '/api/v1/auth/token', body, key, '')).body) ===
      JSON.stringify(refresh.body),
  ).toBe(true);
  device.accept(refresh);
  expect((await device.send(h, 'GET', '/api/v1/profiles')).status).toBe(200);
  const reused = await device.send(h, 'POST', '/api/v1/auth/token', body, randomUUID(), '');
  expect(reused.body.code).toBe('CREDENTIAL_REUSED');
  expect((await device.send(h, 'GET', '/api/v1/profiles')).status).toBe(401);
});
it('revokes active credentials and rejects cached delivery after revocation', async () => {
  const { device, body, key } = await enroll();
  const revoked = await h.web('POST', `/api/v1/devices/${device.deviceId}/revocations`, owner, {});
  expect(revoked.status).toBe(200);
  expect((await device.send(h, 'GET', '/api/v1/profiles')).body.code).toBe('DEVICE_REVOKED');
  expect((await device.send(h, 'POST', '/api/v1/auth/token', body, key, '')).status).toBe(401);
});
it('requires recent authentication for sensitive management actions', async () => {
  const { device } = await enroll();
  h.advance(301);
  const rejected = await h.web('POST', `/api/v1/devices/${device.deviceId}/revocations`, owner, {});
  expect(rejected.body.code).toBe('RECENT_AUTH_REQUIRED');
  expect((await h.web('POST', '/api/v1/auth/reauthenticate', owner, { password })).status).toBe(
    200,
  );
  expect(
    (await h.web('POST', `/api/v1/devices/${device.deviceId}/revocations`, owner, {})).status,
  ).toBe(200);
});
it('serializes concurrent retries without creating duplicate resources or credentials', async () => {
  const key = randomUUID(),
    body = { name: 'One concurrent profile' };
  const profiles = await Promise.all(
    Array.from({ length: 3 }, () =>
      h.web('POST', '/api/v1/profiles', owner, body, { 'idempotency-key': key }),
    ),
  );
  expect(profiles.map((r) => r.status)).toEqual([200, 200, 200]);
  expect(new Set(profiles.map((r) => r.body.id)).size).toBe(1);
  const mismatch = await h.web(
    'POST',
    '/api/v1/profiles',
    owner,
    { name: 'Different' },
    { 'idempotency-key': key },
  );
  expect(mismatch.body.code).toBe('IDEMPOTENCY_MISMATCH');
  const { device } = await enroll();
  const refreshBody = { grantType: 'refresh_token', refreshToken: device.refreshToken },
    refreshKey = randomUUID();
  const replies = await Promise.all(
    Array.from({ length: 3 }, () =>
      device.send(h, 'POST', '/api/v1/auth/token', refreshBody, refreshKey, ''),
    ),
  );
  expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
  expect(new Set(replies.map((r) => sha(JSON.stringify(r.body)))).size).toBe(1);
  device.accept(replies[0]!);
  expect((await device.send(h, 'GET', '/api/v1/profiles')).status).toBe(200);
});
it('enforces profile grants and rechecks revocation inside the mutation transaction', async () => {
  const { device } = await enroll('read');
  // Capture the authenticated principal through the real HTTPS handler.
  const credentials = await h.db.query<{ id: string }>(
    'SELECT id FROM device_credentials WHERE token_hash=?',
    [sha(device.accessToken)],
  );
  const owners = await h.db.query<{ user_id: string }>(
    'SELECT user_id FROM device_owners WHERE device_id=?',
    [device.deviceId],
  );
  const keys = await h.db.query<{ thumbprint: string }>(
    'SELECT thumbprint FROM device_keys WHERE device_id=?',
    [device.deviceId],
  );
  const principal = {
    id: device.deviceId,
    userId: owners[0]!.user_id,
    thumbprint: keys[0]!.thumbprint,
    credentialId: credentials[0]!.id,
  };
  await expect(h.security.member(principal, profileId, true)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await expect(h.security.member(principal, randomUUID())).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await h.security.member(principal, profileId);
  const guard = h.security.deviceGuard(principal, profileId);
  await h.web('POST', `/api/v1/devices/${device.deviceId}/revocations`, owner, {});
  await expect(h.db.transaction(guard)).rejects.toThrow('DEVICE_REVOKED');
});
it('rejects stale proofs and signs a device out explicitly', async () => {
  const { device } = await enroll();
  const stale = await h.send('GET', '/api/v1/profiles', undefined, {
    authorization: 'DPoP ' + device.accessToken,
    dpop: device.proof(h, 'GET', '/api/v1/profiles', { iat: h.now() - 61 }),
  });
  expect(stale.body.code).toBe('INVALID_DPOP');
  expect(stale.headers['www-authenticate']).toContain('DPoP');
  expect((await device.send(h, 'POST', '/api/v1/auth/device-logout', {})).status).toBe(200);
  expect((await device.send(h, 'GET', '/api/v1/profiles')).status).toBe(401);
  const session = await h.login('owner', password);
  expect((await h.web('POST', '/api/v1/auth/logout', session, {})).status).toBe(200);
  expect((await h.web('GET', '/api/v1/auth/session', session)).status).toBe(401);
});
