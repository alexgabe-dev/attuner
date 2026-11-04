import { expect, it } from 'vitest';
import { renderProxy, type ProxyConfig } from '../infrastructure/staging/nginx.ts';
import { jammyUnit, slice, journal } from '../infrastructure/staging/jammy.ts';
const config: ProxyConfig = {
  origin: 'https://attuner-staging.example.com',
  listen: '443',
  apiPort: 4317,
  webPort: 4318,
  apiCA: '/etc/attuner-staging/api-ca.pem',
  apiName: 'attuner-api.internal',
  edgeCertificate: '/etc/attuner-staging/edge-cert.pem',
  edgeKey: '/run/credentials/edge-tls-key',
  passwordFile: '/run/credentials/edge-passphrase',
  pid: '/run/attuner/nginx.pid',
  cache: '/var/cache/attuner',
};
it('rejects proxy origin/listener/path injection before writing deployment files', () => {
  for (const origin of [
    'http://attuner-staging.example.com',
    'https://user:secret@attuner-staging.example.com',
    'https://attuner-staging.example.com/path',
    'https://attuner-staging.example.com?token=secret',
    'https://attuner-staging.example.com#fragment',
  ])
    expect(() => renderProxy({ ...config, origin })).toThrow();
  expect(() => renderProxy({ ...config, listen: '8443' })).toThrow();
  expect(() => renderProxy({ ...config, apiCA: '/etc/key; injected' })).toThrow();
  expect(() => renderProxy({ ...config, apiCA: '/etc/../secrets' })).toThrow();
  expect(() => renderProxy({ ...config, apiName: 'localhost; injected' })).toThrow();
  expect(() => renderProxy({ ...config, apiPort: 80 })).toThrow();
});
it('keeps every compiled-in nginx temporary directory inside its writable cache', () => {
  const rendered = renderProxy(config);
  for (const name of ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'])
    expect(rendered).toContain(`${name}_temp_path "${config.cache}/`);
});
it('renders a shared-host include without owning the nginx master or other sites', () => {
  const hosted = { ...config, hosted: true };
  delete hosted.passwordFile;
  const rendered = renderProxy(hosted);
  for (const directive of [
    'worker_processes ',
    'pid ',
    'events {',
    'http {',
    'default_server',
    'ssl_password_file',
  ])
    expect(rendered).not.toContain(directive);
  expect(rendered).toContain('server_name attuner-staging.example.com;');
  expect(rendered).toContain('zone=attuner_staging_login:1m');
  expect(rendered.indexOf('server {')).toBeLessThan(rendered.indexOf('client_max_body_size'));
  expect(rendered).toContain('proxy_ssl_verify on;');
});
it('converts only reviewed Jammy services, retains hardening and gates runtime secrets', () => {
  const unit = jammyUnit(
    'attuner-staging-api.service',
    '[Unit]\nDescription=test\n[Service]\nUser=attuner-api\nLoadCredentialEncrypted=token-delivery-key:/srv/attuner-staging/secrets/token-delivery-key.cred\nProtectSystem=strict\n',
  );
  expect(unit).toContain(
    'LoadCredential=token-delivery-key:/run/attuner-staging-secrets/token-delivery-key',
  );
  expect(unit).toContain('ConditionPathExists=/run/attuner-staging-secrets/api.ready');
  expect(unit).toContain('LogNamespace=attuner-staging');
  expect(unit).toContain('ProtectSystem=strict');
  expect(() => jammyUnit('attuner-staging-proxy.service', '')).toThrow();
  expect(() =>
    jammyUnit('attuner-staging-api.service', 'LoadCredentialEncrypted=unreviewed:/elsewhere'),
  ).toThrow();
  expect(slice).toContain('CPUQuota=50%');
  expect(slice).toContain('MemoryMax=3G');
  expect(journal).toContain('SystemMaxUse=128M');
});
