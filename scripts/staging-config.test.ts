import { expect, it } from 'vitest';
import { renderProxy, type ProxyConfig } from '../infrastructure/staging/nginx.ts';
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
