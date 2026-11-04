import { z } from 'zod';
import {
  profileGrantsSchema,
  enrollmentRequestSchema,
  enrollmentDecisionSchema,
  tokenRequestSchema,
  profileRenameSchema,
} from '@attuner/sync-protocol';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Statement } from '@attuner/database';
import { Security, type User } from './service.ts';
import { ApiError, sha, secret, passwordMatches, encrypt, decrypt } from './primitives.ts';
const prefix = '/api/v1';
const id = z.uuid();
const name = z.string().trim().min(1).max(80);
const loginBody = z.strictObject({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});
const grants = profileGrantsSchema;
const requestKey = (r: FastifyRequest) => id.parse(r.headers['idempotency-key']);
const actor = (u: User) => ({ kind: 'user' as const, id: u.id });
export function securityRoutes(app: FastifyInstance, security: Security) {
  app.post(prefix + '/auth/login', async (request, reply) => {
    const body = loginBody.parse(request.body);
    return security.login(request, reply, body.username, body.password);
  });
  app.get(prefix + '/auth/session', async (request) => {
    const u = await security.user(request);
    return { user: { id: u.id, username: u.username, role: u.role }, csrfToken: u.csrfToken };
  });
  app.post(prefix + '/auth/logout', async (request, reply) => {
    const u = await security.user(request, true);
    await security.db.transaction([
      { sql: 'DELETE FROM web_session_security WHERE token_hash=?', params: [u.tokenHash] },
      { sql: 'DELETE FROM web_sessions WHERE token_hash=?', params: [u.tokenHash] },
      ...security.auditStatements(actor(u), 'logout', request.id),
    ]);
    reply.header(
      'Set-Cookie',
      '__Host-attuner=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
    );
    return { signedOut: true };
  });
  app.post(prefix + '/auth/reauthenticate', async (request) => {
    const u = await security.user(request, true),
      body = z.strictObject({ password: z.string().min(1).max(1024) }).parse(request.body);
    security.limit('reauth:' + u.id, 5);
    const rows = await security.db.query<{ password_hash: string }>(
      'SELECT password_hash FROM web_users WHERE id=?',
      [u.id],
    );
    if (!(await passwordMatches(body.password, rows[0]!.password_hash)))
      throw new ApiError(401, 'LOGIN_FAILED', 'Password was not accepted.');
    await security.db.transaction([
      {
        sql: 'UPDATE web_session_security SET authenticated_at=? WHERE token_hash=?',
        params: [security.now(), u.tokenHash],
      },
      ...security.auditStatements(actor(u), 'reauthenticated', request.id),
    ]);
    return { confirmed: true };
  });
  app.get(prefix + '/profiles', async (request, reply) => {
    if (request.headers.authorization) {
      const d = await security.device(request, reply);
      return {
        profiles: await security.db.query(
          'SELECT p.*,s.permission FROM profiles p JOIN profile_members m ON m.profile_id=p.id JOIN device_profile_scopes s ON s.profile_id=p.id WHERE m.user_id=? AND s.device_id=? ORDER BY p.name LIMIT 200',
          [d.userId, d.id],
        ),
      };
    }
    const u = await security.user(request);
    return {
      profiles: await security.db.query(
        'SELECT p.*,m.role FROM profiles p JOIN profile_members m ON m.profile_id=p.id WHERE m.user_id=? ORDER BY p.name LIMIT 200',
        [u.id],
      ),
    };
  });
  app.post(prefix + '/profiles', async (request) => {
    const u = await security.user(request, true, true),
      body = z.strictObject({ name }).parse(request.body),
      profileId = randomUUID(),
      key = requestKey(request),
      payloadHash = sha(JSON.stringify(body));
    const prior = await security.receipt(u.id, 'profile.create', key, payloadHash);
    if (prior) return prior;
    const result = {
      id: profileId,
      name: body.name,
      adapter: 'attuner-synthetic',
      policyVersion: 1,
      roots: ['account', 'addons'],
    };
    try {
      await security.db.transaction([
        security.userGuard(u),
        {
          sql: "INSERT INTO profiles VALUES(?,?,'attuner-synthetic',1,NULL,1,?)",
          params: [profileId, body.name, security.now()],
        },
        { sql: "INSERT INTO profile_members VALUES(?,?,'owner')", params: [profileId, u.id] },
        {
          sql: 'INSERT INTO profile_policies VALUES(?,?,1,10737418240)',
          params: [profileId, JSON.stringify(result.roots)],
        },
        {
          sql: 'INSERT INTO request_receipts VALUES(?,?,?,?,?,?)',
          params: [
            u.id,
            'profile.create',
            key,
            payloadHash,
            JSON.stringify(result),
            security.now(),
          ],
        },
        ...security.auditStatements(actor(u), 'profile.created', request.id, profileId),
      ]);
    } catch (error) {
      const prior = await security.receipt(u.id, 'profile.create', key, payloadHash);
      if (prior) return prior;
      throw error;
    }
    return result;
  });
  app.post(prefix + '/profiles/:profileId/renames', async (request) => {
    const user = await security.user(request, true, true),
      profileId = id.parse((request.params as { profileId: string }).profileId),
      body = profileRenameSchema.parse(request.body);
    if ((await security.member(user, profileId)) !== 'owner')
      throw new ApiError(404, 'NOT_FOUND', 'Resource not found.');
    const scope = 'profile.rename:' + profileId,
      key = requestKey(request),
      payloadHash = sha(JSON.stringify(body)),
      result = { id: profileId, name: body.name };
    const prior = await security.receipt(user.id, scope, key, payloadHash);
    if (prior) return prior;
    try {
      await security.db.transaction([
        security.userGuard(user),
        {
          sql: "SELECT 1 FROM profile_members WHERE profile_id=? AND user_id=? AND role='owner'",
          params: [profileId, user.id],
          expect: 1,
          code: 'NOT_FOUND',
        },
        {
          sql: 'SELECT 1 FROM profiles WHERE id=? AND name=?',
          params: [profileId, body.expectedName],
          expect: 1,
          code: 'PROFILE_CHANGED',
        },
        { sql: 'UPDATE profiles SET name=? WHERE id=?', params: [body.name, profileId] },
        {
          sql: 'INSERT INTO request_receipts VALUES(?,?,?,?,?,?)',
          params: [user.id, scope, key, payloadHash, JSON.stringify(result), security.now()],
        },
        ...security.auditStatements(actor(user), 'profile.renamed', request.id, profileId),
      ]);
    } catch (error) {
      const prior = await security.receipt(user.id, scope, key, payloadHash);
      if (prior) return prior;
      if (error instanceof Error && error.message === 'PROFILE_CHANGED')
        throw new ApiError(
          409,
          'PROFILE_CHANGED',
          'This profile was renamed elsewhere. Refresh and try again.',
        );
      throw error;
    }
    return result;
  });
  app.post(prefix + '/auth/enrollments', async (request, reply) => {
    const proof = await security.proof(request, reply);
    security.limit('enrollment:' + request.ip, 20);
    const body = enrollmentRequestSchema.parse(request.body);
    const enrollmentId = randomUUID(),
      key = requestKey(request),
      payloadHash = sha(JSON.stringify(body));
    const prior = await security.receipt(proof.thumbprint, 'enrollment.start', key, payloadHash);
    if (prior) return prior;
    const result = {
      enrollmentId,
      authorizationUrl: security.options.origin() + '/enroll/' + enrollmentId,
      expiresIn: 600,
    };
    try {
      await security.db.transaction([
        {
          sql: "INSERT INTO enrollments VALUES(?,?,?,?,?,?,?,?,'pending',NULL,NULL,NULL,?,?)",
          params: [
            enrollmentId,
            proof.thumbprint,
            JSON.stringify(proof.jwk),
            body.codeChallenge,
            body.state,
            body.deviceName,
            body.os,
            body.clientVersion,
            security.now() + 600,
            security.now(),
          ],
        },
        ...security.auditStatements(
          { kind: 'anonymous', id: null },
          'enrollment.started',
          request.id,
          null,
          { enrollmentId, thumbprint: proof.thumbprint },
        ),
        {
          sql: 'INSERT INTO request_receipts VALUES(?,?,?,?,?,?)',
          params: [
            proof.thumbprint,
            'enrollment.start',
            key,
            payloadHash,
            JSON.stringify(result),
            security.now(),
          ],
        },
      ]);
    } catch (error) {
      const prior = await security.receipt(proof.thumbprint, 'enrollment.start', key, payloadHash);
      if (prior) return prior;
      throw error;
    }
    return result;
  });
  app.get(prefix + '/auth/enrollments/:id', async (request) => {
    await security.user(request);
    const enrollmentId = id.parse((request.params as { id: string }).id);
    const rows = await security.db.query(
      'SELECT id,device_name AS deviceName,os,client_version AS clientVersion,thumbprint,state,expires_at AS expiresAt FROM enrollments WHERE id=? AND expires_at>?',
      [enrollmentId, security.now()],
    );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Enrollment not found.');
    return rows[0];
  });
  app.post(prefix + '/auth/enrollments/:id/decision', async (request) => {
    const u = await security.user(request, true, true),
      enrollmentId = id.parse((request.params as { id: string }).id);
    const body = enrollmentDecisionSchema.parse(request.body);
    const payloadHash = sha(JSON.stringify(body)),
      aad = enrollmentId + '\0' + u.id + '\0' + payloadHash;
    async function priorDecision() {
      const records = await security.db.query<{
        user_id: string;
        payload_hash: string;
        ciphertext: string;
        expires_at: number;
      }>('SELECT * FROM enrollment_decisions WHERE enrollment_id=?', [enrollmentId]);
      const record = records[0];
      if (!record) return null;
      if (record.user_id !== u.id || record.payload_hash !== payloadHash)
        throw new ApiError(409, 'IDEMPOTENCY_MISMATCH', 'Enrollment already has another decision.');
      if (record.expires_at <= security.now())
        throw new ApiError(409, 'ENROLLMENT_CLOSED', 'Restart the expired enrollment.');
      return decrypt<Record<string, unknown>>(security.options.key, record.ciphertext, aad);
    }
    const prior = await priorDecision();
    if (prior) return prior;
    const rows = await security.db.query<{ state: string; client_state: string }>(
      'SELECT state,client_state FROM enrollments WHERE id=? AND expires_at>?',
      [enrollmentId, security.now()],
    );
    if (!rows[0] || rows[0].state !== 'pending')
      throw new ApiError(409, 'ENROLLMENT_CLOSED', 'Enrollment is expired or already decided.');
    if (body.approve) {
      if (!body.grants) throw new ApiError(400, 'SCOPES_REQUIRED', 'Choose profile permissions.');
      for (const grant of body.grants)
        await security.member(u, grant.profileId, grant.permission === 'write');
    }
    const code = secret();
    const result = body.approve
      ? {
          approved: true,
          redirectUri: `app.attuner.desktop:/enrollment?code=${code}&state=${rows[0].client_state}&enrollmentId=${enrollmentId}`,
        }
      : { approved: false };
    try {
      await security.db.transaction([
        security.userGuard(u),
        {
          sql: "UPDATE enrollments SET state=?,user_id=?,profile_ids=?,code_hash=? WHERE id=? AND state='pending' AND expires_at>?",
          params: [
            body.approve ? 'approved' : 'denied',
            u.id,
            JSON.stringify(body.grants ?? []),
            body.approve ? sha(code) : null,
            enrollmentId,
            security.now(),
          ],
          expect: 1,
          code: 'ENROLLMENT_CLOSED',
        },
        ...security.auditStatements(
          actor(u),
          body.approve ? 'enrollment.approved' : 'enrollment.denied',
          request.id,
          null,
          { enrollmentId },
        ),
        {
          sql: 'INSERT INTO enrollment_decisions VALUES(?,?,?,?,?)',
          params: [
            enrollmentId,
            u.id,
            payloadHash,
            encrypt(security.options.key, result, aad),
            security.now() + 300,
          ],
        },
      ]);
    } catch (error) {
      const prior = await priorDecision();
      if (prior) return prior;
      throw error;
    }
    return result;
  });
  app.post(prefix + '/auth/token', async (request, reply) => {
    const proof = await security.proof(request, reply),
      key = requestKey(request);
    const body = tokenRequestSchema.parse(request.body);
    const principal = proof.thumbprint,
      payloadHash = sha(JSON.stringify(body));
    const prior = await security.delivered(key, principal, payloadHash);
    if (prior) return prior;
    if (body.grantType === 'authorization_code') {
      type Enrollment = {
        id: string;
        state: string;
        thumbprint: string;
        challenge: string;
        code_hash: string;
        user_id: string;
        profile_ids: string;
        device_name: string;
        os: string;
        client_version: string;
        jwk: string;
        expires_at: number;
      };
      const rows = await security.db.query<Enrollment>('SELECT * FROM enrollments WHERE id=?', [
        body.enrollmentId,
      ]);
      const e = rows[0];
      if (
        !e ||
        e.state !== 'approved' ||
        e.expires_at <= security.now() ||
        e.thumbprint !== proof.thumbprint ||
        e.challenge !== sha(body.codeVerifier) ||
        e.code_hash !== sha(body.code)
      )
        throw new ApiError(401, 'ENROLLMENT_REJECTED', 'Enrollment could not be redeemed.');
      const permissions = grants.parse(JSON.parse(e.profile_ids)),
        deviceId = randomUUID(),
        issued = security.issue(deviceId, proof.thumbprint);
      const statements: Statement[] = [
        {
          sql: "UPDATE enrollments SET state='redeemed' WHERE id=? AND state='approved' AND expires_at>?",
          params: [e.id, security.now()],
          expect: 1,
          code: 'ENROLLMENT_CLOSED',
        },
        {
          sql: 'SELECT 1 FROM user_security WHERE user_id=? AND disabled_at IS NULL',
          params: [e.user_id],
          expect: 1,
          code: 'AUTH_REQUIRED',
        },
        {
          sql: 'INSERT INTO devices VALUES(?,?,?,?,?,NULL)',
          params: [deviceId, e.device_name, e.os, e.client_version, security.now()],
        },
        { sql: 'INSERT INTO device_owners VALUES(?,?)', params: [deviceId, e.user_id] },
        {
          sql: 'INSERT INTO device_keys VALUES(?,?,?,?)',
          params: [deviceId, proof.thumbprint, e.jwk, security.now()],
        },
      ];
      for (const g of permissions) {
        statements.push(
          {
            sql: "SELECT 1 FROM profile_members WHERE user_id=? AND profile_id=? AND (?='read' OR role IN ('owner','writer'))",
            params: [e.user_id, g.profileId, g.permission],
            expect: 1,
            code: 'NOT_FOUND',
          },
          {
            sql: "INSERT INTO device_profiles VALUES(?,?,NULL,1,0,'active')",
            params: [deviceId, g.profileId],
          },
          {
            sql: 'INSERT INTO device_profile_scopes VALUES(?,?,?)',
            params: [deviceId, g.profileId, g.permission],
          },
        );
      }
      statements.push(
        ...issued.statements,
        security.delivery(key, principal, payloadHash, issued.response, issued.familyId),
        ...security.auditStatements(
          { kind: 'user', id: e.user_id },
          'device.enrolled',
          request.id,
          null,
          { deviceId },
        ),
      );
      try {
        await security.db.transaction(statements);
      } catch (error) {
        const prior = await security.delivered(key, principal, payloadHash);
        if (prior) return prior;
        throw error;
      }
      return issued.response;
    }
    type Credential = {
      id: string;
      device_id: string;
      revoked_at: number | null;
      expires_at: number;
      thumbprint: string;
      family_id: string;
      family_expires_at: number;
      device_revoked: number | null;
    };
    const rows = await security.db.query<Credential>(
      "SELECT c.*,cs.thumbprint,cs.family_id,cs.family_expires_at,d.revoked_at AS device_revoked FROM device_credentials c JOIN credential_security cs ON cs.credential_id=c.id JOIN devices d ON d.id=c.device_id JOIN device_owners o ON o.device_id=d.id JOIN user_security u ON u.user_id=o.user_id WHERE c.token_hash=? AND cs.kind='refresh' AND u.disabled_at IS NULL",
      [sha(body.refreshToken)],
    );
    const c = rows[0];
    if (
      !c ||
      c.thumbprint !== proof.thumbprint ||
      c.expires_at <= security.now() ||
      c.family_expires_at <= security.now() ||
      c.device_revoked !== null
    )
      throw new ApiError(401, 'DEVICE_REVOKED', 'Device credentials are expired or revoked.');
    if (c.revoked_at !== null) {
      await security.db.transaction([
        {
          sql: 'UPDATE device_credentials SET revoked_at=? WHERE id IN (SELECT credential_id FROM credential_security WHERE family_id=?)',
          params: [security.now(), c.family_id],
        },
        ...security.auditStatements(
          { kind: 'device', id: c.device_id },
          'credential.reuse_detected',
          request.id,
          null,
          {},
          'denied',
        ),
      ]);
      throw new ApiError(401, 'CREDENTIAL_REUSED', 'Sign in again to reconnect this device.');
    }
    const issued = security.issue(c.device_id, proof.thumbprint, c.family_id, c.family_expires_at);
    try {
      await security.db.transaction([
        {
          sql: 'UPDATE device_credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM devices d JOIN device_owners o ON o.device_id=d.id JOIN user_security u ON u.user_id=o.user_id WHERE d.id=? AND d.revoked_at IS NULL AND u.disabled_at IS NULL)',
          params: [security.now(), c.id, c.device_id],
          expect: 1,
          code: 'REFRESH_MOVED',
        },
        ...issued.statements,
        security.delivery(key, principal, payloadHash, issued.response, issued.familyId),
        ...security.auditStatements(
          { kind: 'device', id: c.device_id },
          'credential.refreshed',
          request.id,
        ),
      ]);
    } catch (error) {
      const delivered = await security.delivered(key, principal, payloadHash);
      if (delivered) return delivered;
      throw error;
    }
    return issued.response;
  });
  app.post(prefix + '/auth/device-logout', async (request, reply) => {
    const d = await security.device(request, reply);
    await security.db.transaction([
      ...security.deviceGuard(d),
      {
        sql: 'UPDATE devices SET revoked_at=coalesce(revoked_at,?) WHERE id=?',
        params: [security.now(), d.id],
      },
      {
        sql: 'UPDATE device_credentials SET revoked_at=coalesce(revoked_at,?) WHERE device_id=?',
        params: [security.now(), d.id],
      },
      {
        sql: "UPDATE sync_sessions SET state='cancelled' WHERE device_id=? AND state NOT IN ('committed','cancelled')",
        params: [d.id],
      },
      {
        sql: "UPDATE upload_sessions SET state='cancelled' WHERE device_id=? AND state IN ('open','verifying')",
        params: [d.id],
      },
      ...security.auditStatements({ kind: 'device', id: d.id }, 'device.signed_out', request.id),
    ]);
    return { revoked: true };
  });
  app.get(prefix + '/devices', async (request) => {
    const u = await security.user(request);
    const devices = await security.db.query(
      'SELECT d.id,d.name,d.os,d.client_version AS clientVersion,d.created_at AS createdAt,d.revoked_at AS revokedAt FROM devices d JOIN device_owners o ON o.device_id=d.id WHERE o.user_id=? ORDER BY d.created_at DESC,d.id LIMIT 200',
      [u.id],
    );
    await security.audit(actor(u), 'devices.read', request.id);
    return { devices };
  });
  app.post(prefix + '/devices/:id/revocations', async (request) => {
    const u = await security.user(request, true, true),
      deviceId = id.parse((request.params as { id: string }).id);
    await security.db.transaction([
      security.userGuard(u),
      {
        sql: 'SELECT 1 FROM device_owners WHERE device_id=? AND user_id=?',
        params: [deviceId, u.id],
        expect: 1,
        code: 'NOT_FOUND',
      },
      {
        sql: 'UPDATE devices SET revoked_at=coalesce(revoked_at,?) WHERE id=?',
        params: [security.now(), deviceId],
      },
      {
        sql: 'UPDATE device_credentials SET revoked_at=coalesce(revoked_at,?) WHERE device_id=?',
        params: [security.now(), deviceId],
      },
      {
        sql: "UPDATE sync_sessions SET state='cancelled' WHERE device_id=? AND state NOT IN ('committed','cancelled')",
        params: [deviceId],
      },
      {
        sql: "UPDATE upload_sessions SET state='cancelled' WHERE device_id=? AND state IN ('open','verifying')",
        params: [deviceId],
      },
      ...security.auditStatements(actor(u), 'device.revoked', request.id, null, { deviceId }),
    ]);
    return { deviceId, revoked: true };
  });
}
