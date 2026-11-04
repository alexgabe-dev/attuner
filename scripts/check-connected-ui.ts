// Standalone synthetic qualification. Passwords, cookies and callback codes stay in memory.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { request } from 'node:https';
import { managementScenario } from '../apps/api/src/testing/management-scenario.ts';
import type { Harness, Response } from '../apps/api/src/testing/secure-harness.ts';
import { DatabaseWorker } from '../packages/database/src/worker.ts';
import { createSecureApp } from '../apps/api/src/secure-app.ts';
import { tlsFixture } from '../apps/api/src/testing/tls-fixture.ts';
const directory = await mkdtemp(join(tmpdir(), 'attuner-connected-ui-'));
const artifactDirectory =
  process.env.ATTUNER_QUALIFICATION_PHASE === '4' ? 'artifacts/phase-4' : 'artifacts/phase-3';
let currentProfileName = 'Violet Citadel · Synthetic';
const tls = await tlsFixture(),
  db = await DatabaseWorker.open(join(directory, 'attuner.sqlite'));
const { app, security } = await createSecureApp(db, {
  tls: tls.tls,
  publicOrigin: 'https://127.0.0.1:4318',
  blobDirectory: join(directory, 'objects'),
  deliveryKey: randomBytes(32),
});
const password = randomBytes(32).toString('base64url');
await security.bootstrap('qualification', password);
await copyFile(tls.caPath, join(directory, 'development-ca.pem'));
await app.listen({ host: '127.0.0.1', port: 4317 });
const gateway = spawn(process.execPath, ['scripts/https-dev.ts'], {
  cwd: resolve('apps/web'),
  env: { ...process.env, ATTUNER_DATA_DIR: directory },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let readyResolve: () => void, readyReject: (error: Error) => void;
const ready = new Promise<void>((resolve, reject) => {
  readyResolve = resolve;
  readyReject = reject;
});
gateway.stdout.on('data', (data: Buffer) => {
  if (data.toString().includes('Attuner development dashboard:')) readyResolve();
});
gateway.on('exit', (code) => readyReject(new Error(`Development gateway exited (${code}).`)));
const browser = await chromium.launch();
let kept = false;
try {
  await Promise.race([
    ready,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Gateway startup timeout.')), 45000).unref(),
    ),
  ]);
  await mkdir(artifactDirectory, { recursive: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage(),
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('https://127.0.0.1:4318/');
  await page.getByLabel('Username', { exact: true }).fill('qualification');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Create profile', exact: true }).click();
  await page.getByLabel('Profile name', { exact: true }).fill(currentProfileName);
  await page.getByRole('button', { name: 'Create profile', exact: true }).last().click();
  await page.getByRole('heading', { name: 'Ready for your first revision', exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const csrfToken = await page.evaluate(
    async () => (await (await fetch('/api/v1/auth/session')).json()).csrfToken as string,
  );
  const cookie = (await context.cookies())
    .filter((c) => c.name === '__Host-attuner')
    .map((c) => c.name + '=' + c.value)
    .join(';');
  const send: Harness['send'] = async (method, path, body, headers = {}) => {
    const data =
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(JSON.stringify(body));
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        'https://127.0.0.1:4317' + path,
        {
          method,
          ca: tls.ca,
          headers: {
            ...(data
              ? {
                  'content-type': Buffer.isBuffer(body)
                    ? 'application/octet-stream'
                    : 'application/json',
                  'content-length': String(data.length),
                }
              : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const bytes = Buffer.concat(chunks);
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: res.headers['content-type']?.includes('application/json')
                ? JSON.parse(bytes.toString('utf8'))
                : {},
              bytes,
            });
          });
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  };
  const transport = {
    origin: 'https://127.0.0.1:4318',
    now: () => Math.floor(Date.now() / 1000),
    send,
    web: async (
      method: string,
      path: string,
      session: { cookie: string; csrfToken: string },
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      send(method, path, body, {
        origin: 'https://127.0.0.1:4318',
        cookie: session.cookie,
        'x-csrf-token': session.csrfToken,
        ...headers,
      }),
  };
  const profile = (await db.query<{ id: string }>('SELECT id FROM profiles LIMIT 1'))[0]!;
  const scenario = await managementScenario(transport, profile.id, { cookie, csrfToken });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'A few changes need your attention', exact: true }),
  ).toBeVisible();
  async function inspectScreens() {
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const violations = (
        await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
      ).violations;
      if (violations.length)
        throw new Error(
          `Accessibility at ${width}: ${violations.map((v) => v.id + ':' + v.nodes.map((n) => n.target).join(',')).join(';')}`,
        );
      await page.screenshot({
        path: `${artifactDirectory}/web-connected-${width}.png`,
        fullPage: true,
      });
    }
  }
  await inspectScreens();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .locator('aside.sidebar')
    .getByRole('button', { name: 'Conflicts', exact: true })
    .click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const conflicts = page.locator('fieldset.connected-conflict');
  await expect(conflicts).toHaveCount(2);
  await conflicts.nth(0).getByRole('radio').first().check();
  await conflicts.nth(1).getByRole('radio').last().check();
  await page.screenshot({ path: `${artifactDirectory}/web-conflict-review.png`, fullPage: true });
  await page.getByRole('button', { name: 'Send proposal to device' }).click();
  await expect(page.getByRole('status')).toContainText('Proposal saved');
  await page
    .locator('aside.sidebar')
    .getByRole('button', { name: 'Diff Explorer', exact: true })
    .click();
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByRole('heading', { name: '2 changed files' })).toBeVisible();
  await page.getByRole('button', { name: 'After', exact: true }).first().click();
  await expect(page.locator('.connected-code')).toContainText('Fixture');
  await page.screenshot({
    path: `${artifactDirectory}/web-snapshot-comparison.png`,
    fullPage: true,
  });
  await page.locator('aside.sidebar').getByRole('button', { name: 'Devices', exact: true }).click();
  await page.getByLabel('Find a device…').fill('Travel');
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByLabel('Confirm your password').fill(password);
  await page.getByRole('button', { name: 'Revoke device', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    (
      await db.query<{ revoked_at: number | null }>('SELECT revoked_at FROM devices WHERE id=?', [
        scenario.revokeDeviceId,
      ])
    )[0]!.revoked_at,
  ).not.toBeNull();
  for (const name of [
    'Devices',
    'Snapshots',
    'Activity',
    'Conflicts',
    'Diff Explorer',
    'Addons',
    'Settings',
    'Overview',
  ]) {
    await page.locator('aside.sidebar').getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
  }
  await page
    .locator('aside.sidebar')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page.getByRole('button', { name: 'Rename profile', exact: true }).click();
  currentProfileName = 'Violet Citadel · Synthetic Beta';
  await page.getByLabel('Profile name', { exact: true }).fill(currentProfileName);
  await page.getByLabel('Confirm your password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Profile', { exact: true }).locator('option:checked')).toHaveText(
    currentProfileName,
  );
  expect(
    (await db.query<{ name: string }>('SELECT name FROM profiles WHERE id=?', [profile.id]))[0]
      ?.name,
  ).toBe(currentProfileName);
  expect(await db.query('SELECT id FROM snapshots WHERE profile_id=?', [profile.id])).toHaveLength(
    2,
  );
  await page.screenshot({
    path: `${artifactDirectory}/web-profile-settings-1440.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Help & diagnostics', exact: true }).click();
  const reportText = await page
    .getByRole('textbox', { name: 'Diagnostic report', exact: true })
    .inputValue();
  const diagnostic = JSON.parse(reportText) as Record<string, unknown>;
  expect(diagnostic.surface).toBe('web');
  expect(diagnostic.counts).toMatchObject({
    loadedDevices: 3,
    loadedSnapshots: 2,
    loadedConflictReports: 1,
  });
  for (const secret of [
    password,
    cookie,
    profile.id,
    scenario.revokeDeviceId,
    'Violet Citadel',
    transport.origin,
  ])
    expect(reportText).not.toContain(secret);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
  }
  await page.screenshot({ path: `${artifactDirectory}/web-diagnostics-390.png` });
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download report', exact: true }).click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toBe('attuner-diagnostics.json');
  const downloaded = await download.createReadStream();
  if (!downloaded) throw new Error('Diagnostic download was unavailable');
  const parts: Buffer[] = [];
  let exportedSize = 0;
  for await (const part of downloaded) {
    const bytes = Buffer.from(part);
    exportedSize += bytes.length;
    if (exportedSize > 8192) throw new Error('Diagnostic export limit');
    parts.push(bytes);
  }
  expect(JSON.parse(Buffer.concat(parts).toString('utf8'))).toEqual(diagnostic);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Help & diagnostics', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (errors.length) throw new Error('Browser runtime errors: ' + errors.join(';'));
  const checks = [
    'HTTPS login',
    'profile creation',
    'owner-authorized profile rename with retained history',
    'three scoped fixture devices',
    'immutable revisions',
    'modification/deletion conflict proposal',
    'verified content preview',
    'device revocation with reauthentication',
    'all navigation views',
    '1440/768/390 responsive widths',
    'automated WCAG checks',
    'no browser runtime errors',
    'reviewed secret-free diagnostic download and accessible responsive dialog',
  ];
  await writeFile(
    `${artifactDirectory}/web-qualification.json`,
    JSON.stringify(
      {
        scope: 'isolated synthetic data',
        source: process.env.GITHUB_SHA ?? 'local worktree',
        driver: 'authenticated TypeScript protocol fixtures; Rust clients are qualified separately',
        passed: true,
        checks,
        viewports: [1440, 768, 390],
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Connected UI qualification passed: ' + checks.join(', ') + '.');
  if (process.argv.includes('--keep-open')) {
    kept = true;
    await copyFile(join(directory, 'dashboard-ca.pem'), resolve('.runtime/qualification-ca.pem'));
    console.log(
      'Synthetic qualification API retained on 4317, dashboard on 4318. Public CA: .runtime/qualification-ca.pem. Commands: approve, capture, stop.',
    );
    const input = createInterface({ input: process.stdin });
    for await (const line of input) {
      if (line === 'stop') break;
      if (line === 'approve') {
        const enrollment = (
          await db.query<{ id: string }>(
            "SELECT id FROM enrollments WHERE state='pending' ORDER BY created_at DESC LIMIT 1",
          )
        )[0];
        if (!enrollment) {
          console.log('No pending synthetic enrollment.');
          continue;
        }
        await page.goto(`https://127.0.0.1:4318/enroll/${enrollment.id}`);
        await page.getByLabel('Access to ' + currentProfileName).selectOption('write');
        await page.getByLabel('Confirm your password').fill(password);
        await page.getByRole('button', { name: 'Approve device', exact: true }).click();
        const link = page.getByRole('link', { name: 'Return to Attuner' });
        await link.waitFor();
        const callback = await link.getAttribute('href');
        if (!callback?.startsWith('app.attuner.desktop:/enrollment?'))
          throw new Error('Unexpected callback.');
        // Test transport through Launch Services. The callback is never printed or persisted.
        await new Promise<void>((resolve, reject) =>
          execFile('open', [callback], (error) => (error ? reject(error) : resolve())),
        );
        console.log('Synthetic enrollment approved and returned to the native app.');
      }
      if (line === 'capture') {
        await page.goto('https://127.0.0.1:4318/');
        await expect(
          page.getByRole('heading', {
            name: /Your setup, preserved|A few changes need your attention/,
            exact: true,
          }),
        ).toBeVisible();
        await inspectScreens();
        console.log('Updated connected screenshots captured.');
      }
    }
    input.close();
  }
} finally {
  await browser.close();
  if (gateway.exitCode === null) {
    gateway.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        gateway.kill('SIGKILL');
        resolve();
      }, 5000);
      gateway.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await app.close();
  await db.close();
  await tls.close();
  await rm(directory, { recursive: true, force: true });
  if (kept)
    console.log(
      'Only this qualification process’s temporary server data was removed. Native fixture recovery history remains preserved.',
    );
}
