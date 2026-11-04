// Authenticated protocol fixtures for web qualification. No real installation or filesystem client.
import { randomUUID } from 'node:crypto';
import { blake3 } from 'hash-wasm';
import { consistencyGroup, manifestDigest, type Manifest, type Head } from '@attuner/sync-protocol';
import { SyntheticDevice, type Harness } from './secure-harness.ts';
import { sha } from '../security/primitives.ts';
type Transport = Pick<Harness, 'origin' | 'now' | 'send' | 'web'>;
export async function managementScenario(
  h: Transport,
  profileId: string,
  owner: { cookie: string; csrfToken: string },
) {
  const base = `/api/v1/profiles/${profileId}`;
  async function enroll(deviceName: string, os: string) {
    const device = new SyntheticDevice();
    const start = await device.send(
      h,
      'POST',
      '/api/v1/auth/enrollments',
      {
        deviceName,
        os,
        clientVersion: '0.1.0',
        codeChallenge: sha(device.verifier),
        state: device.state,
      },
      randomUUID(),
    );
    const enrollmentId = start.body.enrollmentId as string;
    const approved = await h.web(
      'POST',
      `/api/v1/auth/enrollments/${enrollmentId}/decision`,
      owner,
      { approve: true, grants: [{ profileId, permission: 'write' }] },
    );
    const code = new URL(approved.body.redirectUri as string).searchParams.get('code');
    device.accept(
      await device.send(
        h,
        'POST',
        '/api/v1/auth/token',
        { grantType: 'authorization_code', enrollmentId, code, codeVerifier: device.verifier },
        randomUUID(),
        '',
      ),
    );
    return device;
  }
  const mac = await enroll('MacBook Pro · Fixture', 'macos'),
    windows = await enroll('Main PC · Fixture', 'windows'),
    offline = await enroll('Travel laptop · Fixture', 'linux');
  async function manifest(entries: Record<string, string>): Promise<Manifest> {
    return {
      protocolVersion: 1,
      profileId,
      policyVersion: 1,
      files: await Promise.all(
        Object.entries(entries).map(async ([path, text]) => ({
          root: 'account' as const,
          path,
          hash: await blake3(text),
          size: Buffer.byteLength(text),
          group: await consistencyGroup('account', path),
        })),
      ),
    };
  }
  async function publish(expectedHead: Head, entries: Record<string, string>) {
    const captured = await manifest(entries),
      digest = await manifestDigest(captured);
    const staged = await mac.send(
      h,
      'POST',
      base + '/sessions',
      {
        publicationVersion: 1,
        namespaceVersion: 1,
        expectedHead,
        baseSnapshotId: expectedHead.snapshotId,
        coveredRoots: ['account', 'addons'],
        manifest: captured,
        manifestHash: digest,
      },
      randomUUID(),
    );
    if (staged.status !== 200) throw new Error('Synthetic staging failed.');
    const session = staged.body.sessionId as string;
    for (const file of captured.files) {
      const upload = await mac.send(h, 'POST', `${base}/sessions/${session}/uploads`, {
        hash: file.hash,
        size: file.size,
      });
      if (upload.body.verified) continue;
      const id = upload.body.uploadId as string;
      const part = await mac.send(
        h,
        'PUT',
        `${base}/uploads/${id}/chunks/0`,
        Buffer.from(entries[file.path]!),
      );
      const completion = await mac.send(h, 'POST', `${base}/uploads/${id}/completion`, {});
      if (part.status !== 200 || completion.status !== 200)
        throw new Error('Synthetic content transfer failed.');
    }
    const committed = await mac.send(h, 'POST', `${base}/sessions/${session}/commit`, {
      approve: true,
    });
    if (committed.status !== 200) throw new Error('Synthetic publication failed.');
    return committed.body as Head;
  }
  const original = {
    'SavedVariables/WeakAuras.lua': 'Fixture = { size = 48, visible = true }\r\n',
    'SavedVariables/Plater.lua': 'Fixture = { scale = 1 }\r\n',
    'Config.wtf': 'SET fixture "isolated"\r\n',
  };
  const first = await publish({ snapshotId: null, revision: 0, manifestHash: null }, original);
  const second = await publish(first, {
    ...original,
    'SavedVariables/WeakAuras.lua': 'Fixture = { size = 52, visible = true }\r\n',
    'SavedVariables/Plater.lua': 'Fixture = { scale = 1.1 }\r\n',
  });
  await mac.send(h, 'POST', base + '/acknowledgements', {
    snapshotId: second.snapshotId,
    manifestHash: second.manifestHash,
  });
  const local = await manifest({
    'SavedVariables/WeakAuras.lua': 'Fixture = { size = 56, visible = false }\r\n',
    'Config.wtf': original['Config.wtf'],
  });
  const conflictId = randomUUID();
  const report = {
    sourceGeneration: 1,
    state: 'conflictReview',
    localManifest: local,
    localManifestHash: await manifestDigest(local),
    baselineSnapshotId: first.snapshotId,
    remoteHead: second,
    publishedHead: null,
    sessionId: null,
    candidateManifestHash: null,
    validatedProposalId: null,
    reason: null,
  };
  if ((await windows.send(h, 'PUT', base + '/jobs/' + conflictId, report)).status !== 200)
    throw new Error('Synthetic source report failed.');
  await offline.send(h, 'PUT', base + '/jobs/' + randomUUID(), {
    ...report,
    state: 'offline',
    baselineSnapshotId: first.snapshotId,
    remoteHead: first,
    reason: 'Offline edits retained. Compare against the latest revision after reconnecting.',
  });
  return { conflictId, first, second, revokeDeviceId: offline.deviceId };
}
