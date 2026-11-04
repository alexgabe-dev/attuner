// Local operator authority only. No HTTP registration, administration or reset route.
import { randomUUID } from 'node:crypto';
import type { Statement } from '@attuner/database';
import { Security } from './service.ts';
import { passwordHash } from './primitives.ts';
function username(value: string) {
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(value))
    throw new Error('Use 3–64 simple username characters.');
  return value.toLowerCase();
}
export class LocalAccounts {
  constructor(private security: Security) {}
  private authority(): Statement {
    return {
      sql: "SELECT 1 WHERE EXISTS(SELECT 1 FROM user_security WHERE role='administrator' AND disabled_at IS NULL)",
      expect: 1,
      code: 'RECOVER_ADMINISTRATOR_FIRST',
    };
  }
  async list(after = '') {
    if (after) after = username(after);
    const rows = await this.security.db.query<{
      username: string;
      role: string;
      disabledAt: number | null;
      createdAt: number;
    }>(
      'SELECT u.username,s.role,s.disabled_at AS disabledAt,u.created_at AS createdAt FROM web_users u JOIN user_security s ON s.user_id=u.id WHERE u.username>? ORDER BY u.username LIMIT 201',
      [after],
    );
    return { users: rows.slice(0, 200), nextAfter: rows.length > 200 ? rows[199]!.username : null };
  }
  async create(name: string, password: string) {
    const normalized = username(name),
      hash = await passwordHash(password),
      id = randomUUID();
    await this.security.db.transaction([
      this.authority(),
      {
        sql: 'INSERT INTO web_users VALUES(?,?,?,?)',
        params: [id, normalized, hash, this.security.now()],
      },
      { sql: "INSERT INTO user_security VALUES(?,'user',NULL,1)", params: [id] },
      ...this.security.auditStatements(
        { kind: 'operator', id: null },
        'user.created',
        'local-cli',
        null,
        { targetUserId: id },
      ),
    ]);
    return id;
  }
  async change(name: string, action: 'disable' | 'reset', password?: string) {
    const normalized = username(name);
    const rows = await this.security.db.query<{ id: string; role: string }>(
      'SELECT u.id,s.role FROM web_users u JOIN user_security s ON s.user_id=u.id WHERE u.username=?',
      [normalized],
    );
    const user = rows[0];
    if (!user || user.role !== 'user')
      throw new Error(
        'This command requires an ordinary local account. Use explicit administrator recovery for the bootstrapped owner.',
      );
    const hash = action === 'reset' ? await passwordHash(password ?? '') : undefined,
      now = this.security.now();
    await this.security.db.transaction([
      this.authority(),
      {
        sql: "SELECT 1 FROM user_security WHERE user_id=? AND role='user'",
        params: [user.id],
        expect: 1,
        code: 'USER_CHANGED',
      },
      ...(hash
        ? [{ sql: 'UPDATE web_users SET password_hash=? WHERE id=?', params: [hash, user.id] }]
        : []),
      {
        sql: 'UPDATE user_security SET disabled_at=?,epoch=epoch+1 WHERE user_id=?',
        params: [action === 'disable' ? now : null, user.id],
      },
      {
        sql: 'UPDATE devices SET revoked_at=coalesce(revoked_at,?) WHERE id IN (SELECT device_id FROM device_owners WHERE user_id=?)',
        params: [now, user.id],
      },
      {
        sql: 'UPDATE device_credentials SET revoked_at=coalesce(revoked_at,?) WHERE device_id IN (SELECT device_id FROM device_owners WHERE user_id=?)',
        params: [now, user.id],
      },
      {
        sql: "UPDATE enrollments SET state='denied' WHERE user_id=? AND state IN ('pending','approved')",
        params: [user.id],
      },
      ...this.security.auditStatements(
        { kind: 'operator', id: null },
        action === 'disable' ? 'user.disabled' : 'user.recovered',
        'local-cli',
        null,
        { targetUserId: user.id },
      ),
    ]);
  }
}
