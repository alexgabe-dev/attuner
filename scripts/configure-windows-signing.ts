import { appendFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
if (
  process.platform !== 'win32' ||
  process.env.CI !== 'true' ||
  !process.env.RUNNER_TEMP ||
  !process.env.GITHUB_ENV
)
  throw new Error('Windows CI required.');
const path = join(process.env.RUNNER_TEMP, 'attuner-windows-signing.json');
const receipts = join(process.env.RUNNER_TEMP, 'attuner-signing-receipts.jsonl');
await writeFile(
  path,
  JSON.stringify({
    bundle: {
      windows: {
        signCommand: {
          cmd: 'pwsh',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            resolve('scripts/sign-windows-cloud.ps1'),
            '%1',
          ],
        },
      },
    },
  }),
  { flag: 'wx' },
);
await writeFile(receipts, '', { flag: 'wx' });
await appendFile(
  process.env.GITHUB_ENV,
  `ATTUNER_SIGN_CONFIG=${path}\nATTUNER_SIGNING_RECEIPTS=${receipts}\n`,
);
