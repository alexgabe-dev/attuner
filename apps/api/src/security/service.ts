import { randomUUID } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { DatabaseWorker, type Statement } from '@attuner/database';
import {
  ApiError,
  secret,
  sha,
  csrf,
  equal,
  passwordHash,
  passwordMatches,
  decodeProof,
  encrypt,
  decrypt,
} from './primitives.ts';
declare module 'fastify' {
  interface FastifyRequest {
    attunerActor?: Actor;
  }
}
export type Actor = { kind: 'user' | 'device' | 'anonymous'; id: string | null };
export type User = {
  id: string;
  username: string;
  role: string;
  tokenHash: string;
  authenticatedAt: number;
  csrfToken: string;
};
export type Device = { id: string; userId: string; thumbprint: string; credentialId: string };
export type Tokens = {
  deviceId: string;
  tokenType: 'DPoP';
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};
export type SecurityOptions = { key: Buffer; origin: () => string; now?: () => number };
export class Security {
  readonly db: DatabaseWorker;
  readonly options: SecurityOptions;
  private dummy = '';
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(db: DatabaseWorker, options: SecurityOptions) {
    if (options.key.length !== 32) throw new Error('A 32-byte token-delivery key is required.');
    this.db = db;
    this.options = options;
  }
  now() {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000);
  }
  async initialize() {
    this.dummy = await passwordHash(secret());
  }
  auditStatements(
    actor: Actor,
    type: string,
    requestId: string,
    profileId: string | null = null,
    payload: Record<string, unknown> = {},
    outcome = 'success',
    jobId: string | null = null,
  ): Statement[] {
    return [
      {
        sql: 'INSERT INTO audit_events(profile_id,device_id,type,payload,created_at) VALUES(?,?,?,?,?)',
        params: [
          profileId,
          actor.kind === 'device' ? actor.id : null,
          type,
          JSON.stringify(payload),
          this.now(),
        ],
      },
      {
        sql: 'INSERT INTO audit_details(event_id,actor_kind,actor_id,request_id,job_id,outcome) VALUES(last_insert_rowid(),?,?,?,?,?)',
        params: [actor.kind, actor.id, requestId, jobId, outcome],
      },
    ];
  }
  async audit(
    actor: Actor,
    type: string,
    requestId: string,
    profileId: string | null = null,
    payload: Record<string, unknown> = {},
    outcome = 'success',
  ) {
    await this.db.transaction(
      this.auditStatements(actor, type, requestId, profileId, payload, outcome),
    );
  }
  async receipt(principal: string, scope: string, key: string, payloadHash: string) {
    const rows = await this.db.query<{ payload_hash: string; result: string }>(
      'SELECT payload_hash,result FROM request_receipts WHERE principal=? AND scope=? AND key=?',
      [principal, scope, key],
    );
    if (!rows[0]) return null;
    if (rows[0].payload_hash !== payloadHash)
      throw new ApiError(
        409,
        'IDEMPOTENCY_MISMATCH',
        'Request key was reused for different input.',
      );
    return JSON.parse(rows[0].result) as Record<string, unknown>;
  }
  tls(request: FastifyRequest) {
    if (!('encrypted' in request.raw.socket) || request.raw.socket.encrypted !== true)
      throw new ApiError(400, 'TLS_REQUIRED', 'HTTPS is required.');
  }
  origin(request: FastifyRequest) {
    this.tls(request);
    if (request.headers.origin !== this.options.origin())
      throw new ApiError(403, 'ORIGIN_REJECTED', 'Request origin was rejected.');
  }
  limit(key: string, max = 30) {
    const now = this.now();
    for (const [id, item] of this.attempts) if (item.until <= now) this.attempts.delete(id);
    const existing = this.attempts.get(key);
    if (!existing && this.attempts.size >= 2048)
      throw new ApiError(429, 'RATE_LIMITED', 'Retry later.');
    const item = existing ?? { count: 0, until: now + 60 };
    item.count++;
    this.attempts.set(key, item);
    if (item.count > max) throw new ApiError(429, 'RATE_LIMITED', 'Retry later.');
  }
  async bootstrap(username: string, password: string) {
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username))
      throw new ApiError(400, 'INVALID_USERNAME', 'Use 3–64 simple username characters.');
    const id = randomUUID(),
      hash = await passwordHash(password);
    await this.db.transaction([
      {
        sql: 'SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM web_users)',
        expect: 1,
        code: 'ALREADY_BOOTSTRAPPED',
      },
      {
        sql: 'INSERT INTO web_users VALUES(?,?,?,?)',
        params: [id, username.toLowerCase(), hash, this.now()],
      },
      { sql: "INSERT INTO user_security VALUES(?,'administrator',NULL,1)", params: [id] },
      ...this.auditStatements({ kind: 'user', id }, 'administrator.bootstrapped', 'local-cli'),
    ]);
    return id;
  }
  async login(request: FastifyRequest, reply: FastifyReply, username: string, password: string) {
    this.origin(request);
    this.limit('login:' + request.ip, 10);
    const users = await this.db.query<{
      id: string;
      username: string;
      password_hash: string;
      role: string;
      epoch: number;
      disabled_at: number | null;
    }>(
      'SELECT u.*,s.role,s.epoch,s.disabled_at FROM web_users u JOIN user_security s ON s.user_id=u.id WHERE u.username=?',
      [username.toLowerCase()],
    );
    const user = users[0],
      valid = await passwordMatches(password, user?.password_hash ?? this.dummy);
    if (!valid || !user || user.disabled_at !== null) {
      await this.audit(
        { kind: 'anonymous', id: null },
        'login.denied',
        request.id,
        null,
        {},
        'denied',
      );
      throw new ApiError(401, 'LOGIN_FAILED', 'Username or password was not accepted.');
    }
    const token = secret(),
      tokenHash = sha(token),
      csrfToken = csrf(this.options.key, token);
    await this.db.transaction([
      {
        sql: 'INSERT INTO web_sessions VALUES(?,?,?,?)',
        params: [tokenHash, user.id, this.now() + 28800, this.now()],
      },
      {
        sql: 'INSERT INTO web_session_security VALUES(?,?,?,?)',
        params: [tokenHash, sha(csrfToken), user.epoch, this.now()],
      },
      ...this.auditStatements({ kind: 'user', id: user.id }, 'login.succeeded', request.id),
    ]);
    reply.header(
      'Set-Cookie',
      `__Host-attuner=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`,
    );
    return { user: { id: user.id, username: user.username, role: user.role }, csrfToken };
  }
  async user(request: FastifyRequest, write = false, recent = false): Promise<User> {
    this.tls(request);
    const token = (request.headers.cookie ?? '')
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('__Host-attuner='))
      ?.slice(15);
    if (!token || token.length > 128)
      throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    const rows = await this.db.query<{
      id: string;
      username: string;
      role: string;
      authenticated_at: number;
      csrf_hash: string;
    }>(
      'SELECT u.id,u.username,us.role,ss.authenticated_at,ss.csrf_hash FROM web_sessions s JOIN web_session_security ss ON ss.token_hash=s.token_hash JOIN web_users u ON u.id=s.user_id JOIN user_security us ON us.user_id=u.id WHERE s.token_hash=? AND s.expires_at>? AND us.disabled_at IS NULL AND us.epoch=ss.epoch',
      [sha(token), this.now()],
    );
    const user = rows[0],
      csrfToken = csrf(this.options.key, token);
    if (!user || !equal(sha(csrfToken), user.csrf_hash))
      throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    if (write) {
      this.origin(request);
      if (!equal(String(request.headers['x-csrf-token'] ?? ''), csrfToken))
        throw new ApiError(403, 'CSRF_REJECTED', 'Reload the page and try again.');
    }
    if (recent && this.now() - user.authenticated_at > 300)
      throw new ApiError(403, 'RECENT_AUTH_REQUIRED', 'Confirm your password to continue.');
    request.attunerActor = { kind: 'user', id: user.id };
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      tokenHash: sha(token),
      authenticatedAt: user.authenticated_at,
      csrfToken,
    };
  }
  async proof(request: FastifyRequest, reply: FastifyReply, accessToken?: string) {
    this.tls(request);
    this.limit('proof:' + request.ip, 12000);
    const path = new URL(request.url, this.options.origin()).pathname;
    const proof = decodeProof(
      request.headers.dpop,
      request.method,
      this.options.origin() + path,
      this.now(),
      accessToken,
    );
    const nonce = proof.claims.nonce;
    const rows = nonce
      ? await this.db.query(
          'SELECT 1 FROM proof_nonces WHERE hash=? AND thumbprint=? AND expires_at>?',
          [sha(nonce), proof.thumbprint, this.now()],
        )
      : [];
    if (!rows.length) {
      this.limit('nonce:' + request.ip, 30);
      const next = secret();
      await this.db.transaction([
        { sql: 'DELETE FROM proof_nonces WHERE expires_at<=?', params: [this.now()] },
        { sql: 'DELETE FROM proof_replays WHERE expires_at<=?', params: [this.now()] },
        {
          sql: 'INSERT INTO proof_nonces VALUES(?,?,?)',
          params: [sha(next), proof.thumbprint, this.now() + 120],
        },
      ]);
      reply.header('DPoP-Nonce', next);
      throw new ApiError(401, 'use_dpop_nonce', 'A fresh device proof is required.');
    }
    try {
      await this.db.run('INSERT INTO proof_replays VALUES(?,?,?)', [
        proof.thumbprint,
        proof.claims.jti,
        this.now() + 120,
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE'))
        throw new ApiError(401, 'DPOP_REPLAY', 'Device proof was already used.');
      throw error;
    }
    return proof;
  }
  async device(request: FastifyRequest, reply: FastifyReply): Promise<Device> {
    const authorization = request.headers.authorization ?? '';
    if (!authorization.startsWith('DPoP ') || authorization.length > 128)
      throw new ApiError(401, 'DEVICE_AUTH_REQUIRED', 'Connect this device to continue.');
    const token = authorization.slice(5),
      proof = await this.proof(request, reply, token);
    const rows = await this.db.query<{
      id: string;
      user_id: string;
      thumbprint: string;
      credential_id: string;
    }>(
      "SELECT d.id,o.user_id,cs.thumbprint,c.id AS credential_id FROM device_credentials c JOIN credential_security cs ON cs.credential_id=c.id JOIN devices d ON d.id=c.device_id JOIN device_owners o ON o.device_id=d.id JOIN user_security u ON u.user_id=o.user_id WHERE c.token_hash=? AND cs.kind='access' AND cs.thumbprint=? AND c.revoked_at IS NULL AND c.expires_at>? AND d.revoked_at IS NULL AND u.disabled_at IS NULL",
      [sha(token), proof.thumbprint, this.now()],
    );
    if (!rows[0])
      throw new ApiError(401, 'DEVICE_REVOKED', 'This device credential is expired or revoked.');
    await this.db.run('INSERT OR IGNORE INTO device_heartbeats VALUES(?,?,?)', [
      rows[0].id,
      this.now(),
      'foreground',
    ]);
    request.attunerActor = { kind: 'device', id: rows[0].id };
    return {
      id: rows[0].id,
      userId: rows[0].user_id,
      thumbprint: rows[0].thumbprint,
      credentialId: rows[0].credential_id,
    };
  }
  /** Recheck at the same transaction linearization point as the protected mutation. */
  deviceGuard(device: Device, profileId?: string, write = false): Statement[] {
    const statements: Statement[] = [
      {
        sql: 'SELECT 1 FROM device_credentials c JOIN devices d ON d.id=c.device_id JOIN device_owners o ON o.device_id=d.id JOIN user_security u ON u.user_id=o.user_id WHERE c.id=? AND c.device_id=? AND c.revoked_at IS NULL AND c.expires_at>max(?,unixepoch()) AND d.revoked_at IS NULL AND u.disabled_at IS NULL',
        params: [device.credentialId, device.id, this.now()],
        expect: 1,
        code: 'DEVICE_REVOKED',
      },
    ];
    if (profileId)
      statements.push({
        sql: "SELECT 1 FROM profile_members m JOIN device_profile_scopes s ON s.profile_id=m.profile_id WHERE m.profile_id=? AND m.user_id=? AND s.device_id=? AND (?=0 OR (s.permission='write' AND m.role IN ('owner','writer')))",
        params: [profileId, device.userId, device.id, write ? 1 : 0],
        expect: 1,
        code: 'NOT_FOUND',
      });
    return statements;
  }
  userGuard(user: User): Statement {
    return {
      sql: 'SELECT 1 FROM web_sessions s JOIN web_session_security ss ON ss.token_hash=s.token_hash JOIN user_security u ON u.user_id=s.user_id WHERE s.token_hash=? AND s.expires_at>max(?,unixepoch()) AND u.disabled_at IS NULL AND u.epoch=ss.epoch',
      params: [user.tokenHash, this.now()],
      expect: 1,
      code: 'AUTH_REQUIRED',
    };
  }
  async member(actor: User | Device, profileId: string, write = false) {
    const isDevice = 'userId' in actor;
    const rows = await this.db.query<{ role: string; permission?: string }>(
      isDevice
        ? 'SELECT m.role,s.permission FROM profile_members m JOIN device_profile_scopes s ON s.profile_id=m.profile_id WHERE m.profile_id=? AND m.user_id=? AND s.device_id=?'
        : 'SELECT role FROM profile_members WHERE profile_id=? AND user_id=?',
      isDevice ? [profileId, actor.userId, actor.id] : [profileId, actor.id],
    );
    const grant = rows[0];
    if (
      !grant ||
      (write && (grant.role === 'reader' || (isDevice && grant.permission !== 'write')))
    )
      throw new ApiError(404, 'NOT_FOUND', 'Resource not found.');
    return grant.role;
  }
  issue(
    deviceId: string,
    thumbprint: string,
    familyId: string = randomUUID(),
    familyExpiresAt = this.now() + 7776000,
  ) {
    const response: Tokens = {
      deviceId,
      tokenType: 'DPoP',
      accessToken: secret(),
      refreshToken: secret(),
      expiresIn: 300,
    };
    const statements: Statement[] = [];
    for (const [kind, token, expires] of [
      ['access', response.accessToken, this.now() + 300],
      ['refresh', response.refreshToken, Math.min(this.now() + 2592000, familyExpiresAt)],
    ] as const) {
      const id = randomUUID();
      statements.push(
        {
          sql: "INSERT INTO device_credentials VALUES(?,?,?,'sync',?,NULL,?)",
          params: [id, deviceId, sha(token), expires, this.now()],
        },
        {
          sql: 'INSERT INTO credential_security VALUES(?,?,?,?,?,NULL)',
          params: [id, kind, thumbprint, familyId, familyExpiresAt],
        },
      );
    }
    return { response, statements, familyId };
  }
  delivery(
    key: string,
    principal: string,
    payloadHash: string,
    tokens: Tokens,
    familyId: string,
  ): Statement {
    return {
      sql: 'INSERT INTO token_deliveries VALUES(?,?,?,?,?,?,?,?)',
      params: [
        key,
        principal,
        payloadHash,
        familyId,
        tokens.deviceId,
        encrypt(this.options.key, tokens, key + '\0' + principal),
        this.now() + 300,
        this.now(),
      ],
    };
  }
  async delivered(key: string, principal: string, payloadHash: string): Promise<Tokens | null> {
    const rows = await this.db.query<{
      principal: string;
      payload_hash: string;
      ciphertext: string;
      expires_at: number;
      revoked_at: number | null;
      disabled_at: number | null;
    }>(
      'SELECT t.*,d.revoked_at,u.disabled_at FROM token_deliveries t JOIN devices d ON d.id=t.device_id JOIN device_owners o ON o.device_id=d.id JOIN user_security u ON u.user_id=o.user_id WHERE t.key=?',
      [key],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.principal !== principal || row.payload_hash !== payloadHash)
      throw new ApiError(
        409,
        'IDEMPOTENCY_MISMATCH',
        'Request key was reused for different input.',
      );
    if (row.revoked_at !== null || row.disabled_at !== null || row.expires_at <= this.now())
      throw new ApiError(
        401,
        'AUTH_REQUIRED',
        'Sign in again to recover this credential exchange.',
      );
    const tokens = decrypt<Tokens>(this.options.key, row.ciphertext, key + '\0' + principal);
    const active = await this.db.query(
      'SELECT 1 FROM device_credentials WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?',
      [sha(tokens.refreshToken), this.now()],
    );
    if (!active.length)
      throw new ApiError(401, 'AUTH_REQUIRED', 'This credential delivery is no longer current.');
    return tokens;
  }
}
