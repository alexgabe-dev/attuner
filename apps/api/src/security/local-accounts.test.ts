import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { secureHarness, SyntheticDevice, type Harness } from '../testing/secure-harness.ts';
import { LocalAccounts } from './local-accounts.ts';
import { sha } from './primitives.ts';
const password = 'isolated synthetic operator password',
  replacement = 'new isolated synthetic account password';
async function approval(
  h: Harness,
  session: { cookie: string; csrfToken: string },
  profileId: string,
  redeem: boolean,
) {
  const device = new SyntheticDevice();
  const start = await device.send(
    h,
    'POST',
    '/api/v1/auth/enrollments',
    {
      deviceName: 'Isolated account test',
      os: 'windows',
      clientVersion: '0.1.0',
      codeChallenge: sha(device.verifier),
      state: device.state,
    },
    randomUUID(),
  );
  expect(start.status).toBe(200);
  const enrollmentId = start.body.enrollmentId as string;
  const decision = await h.web(
    'POST',
    `/api/v1/auth/enrollments/${enrollmentId}/decision`,
    session,
    { approve: true, grants: [{ profileId, permission: 'write' }] },
  );
  expect(decision.status).toBe(200);
  const exchange = () =>
    device.send(
      h,
      'POST',
      '/api/v1/auth/token',
      {
        grantType: 'authorization_code',
        enrollmentId,
        code: new URL(decision.body.redirectUri as string).searchParams.get('code'),
        codeVerifier: device.verifier,
      },
      randomUUID(),
      '',
    );
  if (redeem) device.accept(await exchange());
  return { device, exchange };
}
it('creates only ordinary accounts with no inherited profiles and a secret-free bounded listing', async () => {
  const h = await secureHarness();
  try {
    const accounts = new LocalAccounts(h.security);
    await expect(accounts.create('before-bootstrap', password)).rejects.toThrow(
      'RECOVER_ADMINISTRATOR_FIRST',
    );
    await h.security.bootstrap('owner', password);
    const owner = await h.login('owner', password);
    const profile = await h.web(
      'POST',
      '/api/v1/profiles',
      owner,
      { name: 'Private owner profile' },
      { 'idempotency-key': randomUUID() },
    );
    expect(profile.status).toBe(200);
    await accounts.create('Beta.User', password);
    const user = await h.login('beta.user', password);
    expect((await h.web('GET', '/api/v1/profiles', user)).body.profiles).toEqual([]);
    expect((await h.web('GET', `/api/v1/profiles/${profile.body.id}/head`, user)).status).toBe(404);
    const list = await accounts.list();
    expect(list.users.map((u) => [u.username, u.role])).toEqual([
      ['beta.user', 'user'],
      ['owner', 'administrator'],
    ]);
    expect(Object.keys(list.users[0]!).sort()).toEqual([
      'createdAt',
      'disabledAt',
      'role',
      'username',
    ]);
    const stored = JSON.stringify(await h.db.query('SELECT password_hash FROM web_users'));
    expect(stored).not.toContain(password);
    expect(stored).toContain('argon2id$');
    const audit = await h.db.query<{ actor_kind: string; payload: string }>(
      "SELECT d.actor_kind,e.payload FROM audit_events e JOIN audit_details d ON d.event_id=e.id WHERE e.type='user.created'",
    );
    expect(audit[0]?.actor_kind).toBe('operator');
    expect(audit[0]?.payload).not.toContain(password);
    await expect(accounts.create('BETA.USER', password)).rejects.toThrow();
    await expect(accounts.create('../escape', password)).rejects.toThrow();
    await expect(accounts.create('short-password', 'short')).rejects.toThrow();
    expect((await accounts.list('beta.user')).users.map((u) => u.username)).toEqual(['owner']);
  } finally {
    await h.close();
  }
});
it('disables and recovers an account without reviving sessions, devices or approved enrollment codes', async () => {
  const h = await secureHarness();
  try {
    await h.security.bootstrap('owner', password);
    const accounts = new LocalAccounts(h.security);
    await accounts.create('beta', password);
    const user = await h.login('beta', password);
    const profile = await h.web(
      'POST',
      '/api/v1/profiles',
      user,
      { name: 'Retained history' },
      { 'idempotency-key': randomUUID() },
    );
    const id = profile.body.id as string;
    const enrolled = await approval(h, user, id, true),
      pending = await approval(h, user, id, false);
    expect((await enrolled.device.send(h, 'GET', '/api/v1/profiles')).status).toBe(200);
    await accounts.change('beta', 'disable');
    expect((await h.web('GET', '/api/v1/auth/session', user)).status).toBe(401);
    expect((await enrolled.device.send(h, 'GET', '/api/v1/profiles')).status).toBe(401);
    expect((await pending.exchange()).status).toBe(401);
    await accounts.change('beta', 'reset', replacement);
    expect((await h.web('GET', '/api/v1/auth/session', user)).status).toBe(401);
    expect((await enrolled.device.send(h, 'GET', '/api/v1/profiles')).status).toBe(401);
    expect((await pending.exchange()).status).toBe(401);
    expect(
      (
        await h.send(
          'POST',
          '/api/v1/auth/login',
          { username: 'beta', password },
          { origin: h.origin },
        )
      ).status,
    ).toBe(401);
    const recovered = await h.login('beta', replacement);
    expect((await h.web('GET', '/api/v1/profiles', recovered)).body.profiles).toHaveLength(1);
    expect(await h.db.query('SELECT * FROM profile_members WHERE profile_id=?', [id])).toHaveLength(
      1,
    );
    expect(await h.db.query('SELECT id FROM devices WHERE revoked_at IS NULL')).toHaveLength(0);
    expect(
      await h.db.query('SELECT id FROM device_credentials WHERE revoked_at IS NULL'),
    ).toHaveLength(0);
  } finally {
    await h.close();
  }
});
it('refuses administrator alteration and rolls back account changes when the audit insert fails', async () => {
  const h = await secureHarness();
  try {
    await h.security.bootstrap('owner', password);
    const accounts = new LocalAccounts(h.security);
    await accounts.create('beta', password);
    const user = await h.login('beta', password);
    await expect(accounts.change('owner', 'disable')).rejects.toThrow('ordinary local account');
    await expect(accounts.change('owner', 'reset', replacement)).rejects.toThrow(
      'ordinary local account',
    );
    await h.db.run(
      "CREATE TRIGGER refuse_account_audit BEFORE INSERT ON audit_events WHEN NEW.type IN ('user.disabled','user.recovered','user.created') BEGIN SELECT RAISE(ABORT,'injected audit failure'); END",
    );
    await expect(accounts.change('beta', 'disable')).rejects.toThrow('injected audit failure');
    expect((await h.web('GET', '/api/v1/auth/session', user)).status).toBe(200);
    await expect(accounts.create('must-rollback', password)).rejects.toThrow(
      'injected audit failure',
    );
    expect(
      await h.db.query("SELECT id FROM web_users WHERE username='must-rollback'"),
    ).toHaveLength(0);
    await h.db.run("UPDATE user_security SET disabled_at=1 WHERE role='administrator'");
    await expect(accounts.change('beta', 'reset', replacement)).rejects.toThrow(
      'RECOVER_ADMINISTRATOR_FIRST',
    );
  } finally {
    await h.close();
  }
});
it('administrator recovery invalidates approved enrollment as well as active sessions', async () => {
  const h = await secureHarness();
  try {
    await h.security.bootstrap('owner', password);
    const owner = await h.login('owner', password);
    const profile = await h.web(
      'POST',
      '/api/v1/profiles',
      owner,
      { name: 'Owner recovery test' },
      { 'idempotency-key': randomUUID() },
    );
    const pending = await approval(h, owner, profile.body.id as string, false);
    await h.security.recoverAdministrator('owner', replacement);
    expect((await h.web('GET', '/api/v1/auth/session', owner)).status).toBe(401);
    expect((await pending.exchange()).status).toBe(401);
    await h.login('owner', replacement);
  } finally {
    await h.close();
  }
});
