import { readPath, type ConnectedController } from '@attuner/ui';
/** Session CSRF material stays in this closure. Cookies remain HttpOnly. */
export function webController(): ConnectedController {
  let csrf = '';
  async function request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    key?: string,
  ): Promise<T> {
    if (globalThis.location?.protocol !== 'https:')
      throw new Error('Open Attuner over HTTPS before signing in.');
    if (
      !path.startsWith('/api/v1/') ||
      path.includes('\\') ||
      path.includes('#') ||
      new URL(path, globalThis.location.origin).origin !== globalThis.location.origin
    )
      throw new Error('Only this Attuner server’s API can receive authenticated requests.');
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    if (key) headers['Idempotency-Key'] = key;
    const response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const value = (await response
      .json()
      .catch(() => ({ message: 'The secure Attuner API is unavailable.' }))) as {
      csrfToken?: string;
      message?: string;
    };
    if (!response.ok)
      throw new Error(value.message ?? `The server rejected this request (${response.status}).`);
    if (value.csrfToken) csrf = value.csrfToken;
    return value as T;
  }
  return {
    read: (view) => request(readPath(view)),
    session: () => request('/api/v1/auth/session'),
    login: (username, password) => request('/api/v1/auth/login', 'POST', { username, password }),
    write: (path, body, key) => request(path, 'POST', body, key),
  };
}
