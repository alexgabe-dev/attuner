import { afterEach, expect, it, vi } from 'vitest';
import { webController } from './connected-controller';
afterEach(() => vi.unstubAllGlobals());
it('never sends a password or authenticated request over HTTP', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('location', { protocol: 'http:', origin: 'http://127.0.0.1:3000' });
  const controller = webController();
  await expect(controller.login!('synthetic', 'disposable-test-password')).rejects.toThrow('HTTPS');
  await expect(controller.session!()).rejects.toThrow('HTTPS');
  expect(fetch).not.toHaveBeenCalled();
});
it('never forwards authenticated data outside its own API origin', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('location', { protocol: 'https:', origin: 'https://synthetic.invalid' });
  const controller = webController();
  for (const path of [
    'https://other.invalid/api/v1/auth/login',
    '//other.invalid/api/v1/auth/login',
    '/api/v1/\\other.invalid',
  ])
    await expect(controller.write!(path, { password: 'disposable-test-password' })).rejects.toThrow(
      'Only this Attuner',
    );
  expect(fetch).not.toHaveBeenCalled();
});
