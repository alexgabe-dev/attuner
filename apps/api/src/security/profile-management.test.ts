import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { secureHarness, SyntheticDevice } from '../testing/secure-harness.ts';
import { LocalAccounts } from './local-accounts.ts';
it('renames only an owned profile with recent authentication, CAS, idempotency and atomic audit', async () => {
  const h = await secureHarness();
  const password = 'isolated profile management password';
  try {
    await h.security.bootstrap('owner', password);
    const owner = await h.login('owner', password);
    const created = await h.web(
      'POST',
      '/api/v1/profiles',
      owner,
      { name: 'Original' },
      { 'idempotency-key': randomUUID() },
    );
    expect(created.status).toBe(200);
    const profileId = created.body.id as string,
      path = `/api/v1/profiles/${profileId}/renames`,
      body = { name: 'Renamed', expectedName: 'Original' },
      key = randomUUID();
    const results = await Promise.all([
      h.web('POST', path, owner, body, { 'idempotency-key': key }),
      h.web('POST', path, owner, body, { 'idempotency-key': key }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(
      await h.db.query(
        "SELECT id FROM audit_events WHERE type='profile.renamed' AND profile_id=?",
        [profileId],
      ),
    ).toHaveLength(1);
    expect(
      (await h.web('POST', path, owner, body, { 'idempotency-key': randomUUID() })).body.code,
    ).toBe('PROFILE_CHANGED');
    expect(
      (
        await h.web(
          'POST',
          path,
          owner,
          { ...body, name: 'Mismatched retry' },
          { 'idempotency-key': key },
        )
      ).body.code,
    ).toBe('IDEMPOTENCY_MISMATCH');
    await new LocalAccounts(h.security).create('other', password);
    const other = await h.login('other', password);
    expect(
      (
        await h.web(
          'POST',
          path,
          other,
          { name: 'Denied', expectedName: 'Renamed' },
          { 'idempotency-key': randomUUID() },
        )
      ).status,
    ).toBe(404);
    const otherId = (
      await h.db.query<{ id: string }>("SELECT id FROM web_users WHERE username='other'")
    )[0]!.id;
    await h.db.run("INSERT INTO profile_members VALUES(?,?,'writer')", [profileId, otherId]);
    expect(
      (
        await h.web(
          'POST',
          path,
          other,
          { name: 'Denied', expectedName: 'Renamed' },
          { 'idempotency-key': randomUUID() },
        )
      ).status,
    ).toBe(404);
    expect((await new SyntheticDevice().send(h, 'POST', path, body, randomUUID())).status).toBe(
      401,
    );
    h.advance(301);
    expect(
      (
        await h.web(
          'POST',
          path,
          owner,
          { name: 'Expired', expectedName: 'Renamed' },
          { 'idempotency-key': randomUUID() },
        )
      ).body.code,
    ).toBe('RECENT_AUTH_REQUIRED');
    expect((await h.web('POST', '/api/v1/auth/reauthenticate', owner, { password })).status).toBe(
      200,
    );
    await h.db.run(
      "CREATE TRIGGER refuse_rename_audit BEFORE INSERT ON audit_events WHEN NEW.type='profile.renamed' BEGIN SELECT RAISE(ABORT,'injected rename audit failure'); END",
    );
    expect(
      (
        await h.web(
          'POST',
          path,
          owner,
          { name: 'Must roll back', expectedName: 'Renamed' },
          { 'idempotency-key': randomUUID() },
        )
      ).status,
    ).toBe(503);
    expect(
      (await h.db.query<{ name: string }>('SELECT name FROM profiles WHERE id=?', [profileId]))[0]
        ?.name,
    ).toBe('Renamed');
    expect(
      await h.db.query('SELECT * FROM snapshots WHERE profile_id=?', [profileId]),
    ).toHaveLength(0);
  } finally {
    await h.close();
  }
});
