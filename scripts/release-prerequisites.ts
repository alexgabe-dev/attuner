const platform = process.argv[2];
if (platform !== 'macos' && platform !== 'windows') throw new Error('Expected macos or windows.');
const names =
  platform === 'macos'
    ? [
        'APPLE_CERTIFICATE',
        'APPLE_CERTIFICATE_PASSWORD',
        'APPLE_SIGNING_IDENTITY',
        'APPLE_API_ISSUER',
        'APPLE_API_KEY',
        'ATTUNER_APPLE_API_PRIVATE_KEY',
        'ATTUNER_APPLE_TEAM_ID',
      ]
    : [
        'AZURE_CLIENT_ID',
        'AZURE_TENANT_ID',
        'AZURE_SUBSCRIPTION_ID',
        'ATTUNER_SIGNING_ENDPOINT',
        'ATTUNER_SIGNING_ACCOUNT',
        'ATTUNER_SIGNING_PROFILE',
        'ATTUNER_WINDOWS_PUBLISHER',
      ];
names.push('TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
const missing = names.filter((name) => !process.env[name]?.trim());
if (missing.length)
  throw new Error(
    `Signing blocked: configure ${missing.join(', ')} in the protected signing environment.`,
  );
if (
  platform === 'windows' &&
  !/^https:\/\/[a-z0-9.-]+\.codesigning\.azure\.net\/?$/.test(
    process.env.ATTUNER_SIGNING_ENDPOINT ?? '',
  )
)
  throw new Error('An HTTPS Azure signing endpoint is required.');
if (
  platform === 'macos' &&
  !process.env.APPLE_SIGNING_IDENTITY?.startsWith('Developer ID Application:')
)
  throw new Error('A real Developer ID Application identity is required.');
console.log('Signing prerequisites are configured; platform verification remains mandatory.');
