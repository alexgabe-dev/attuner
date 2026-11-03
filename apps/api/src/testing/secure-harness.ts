import { request } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { randomBytes, randomUUID, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { DatabaseWorker } from '@attuner/database';
import { createSecureApp } from '../secure-app.ts';
import { tlsFixture } from './tls-fixture.ts';
import { sha } from '../security/primitives.ts';
export type Response = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
};
export async function secureHarness() {
  const tls = await tlsFixture(),
    db = await DatabaseWorker.open();
  let clock = Math.floor(Date.now() / 1000);
  const { app, security } = await createSecureApp(db, {
    tls: tls.tls,
    deliveryKey: randomBytes(32),
    now: () => clock,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  const origin = `https://127.0.0.1:${address.port}`;
  async function send(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    return await new Promise((resolve, reject) => {
      const q = request(
        origin + path,
        {
          method,
          ca: tls.ca,
          headers: {
            ...(data
              ? {
                  'content-type': 'application/json',
                  'content-length': String(Buffer.byteLength(data)),
                }
              : {}),
            ...headers,
          },
        },
        (response) => {
          let bytes = '';
          response.on('data', (part) => (bytes += part));
          response.on('end', () =>
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              body: bytes ? JSON.parse(bytes) : {},
            }),
          );
        },
      );
      q.on('error', reject);
      q.end(data);
    });
  }
  async function login(username: string, password: string) {
    const result = await send('POST', '/api/v1/auth/login', { username, password }, { origin });
    if (result.status !== 200) throw new Error('Synthetic login failed: ' + result.body.code);
    return {
      cookie: String(result.headers['set-cookie']![0]).split(';')[0]!,
      csrfToken: result.body.csrfToken as string,
    };
  }
  async function web(
    method: string,
    path: string,
    session: { cookie: string; csrfToken: string },
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return send(method, path, body, {
      origin,
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
      ...headers,
    });
  }
  return {
    app,
    ca: tls.ca.toString('utf8'),
    security,
    db,
    origin,
    send,
    login,
    web,
    now: () => clock,
    advance: (seconds: number) => {
      clock += seconds;
    },
    close: async () => {
      await app.close();
      await db.close();
      await tls.close();
    },
  };
}
export type Harness = Awaited<ReturnType<typeof secureHarness>>;
export class SyntheticDevice {
  private privateKey: KeyObject;
  readonly jwk: Record<string, unknown>;
  private nonce = '';
  readonly verifier = randomBytes(32).toString('base64url');
  readonly state = randomBytes(32).toString('base64url');
  accessToken = '';
  refreshToken = '';
  deviceId = '';
  constructor() {
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = key.privateKey;
    this.jwk = key.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  }
  proof(
    h: Harness,
    method: string,
    path: string,
    extra: Record<string, unknown> = {},
    token = this.accessToken,
  ) {
    const header = Buffer.from(
      JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: this.jwk }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        htm: method,
        htu: h.origin + path,
        iat: h.now(),
        jti: randomUUID(),
        ...(this.nonce ? { nonce: this.nonce } : {}),
        ...(token ? { ath: sha(token) } : {}),
        ...extra,
      }),
    ).toString('base64url');
    return (
      header +
      '.' +
      payload +
      '.' +
      sign('sha256', Buffer.from(header + '.' + payload), {
        key: this.privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url')
    );
  }
  async send(
    h: Harness,
    method: string,
    path: string,
    body?: unknown,
    key?: string,
    token = this.accessToken,
  ): Promise<Response> {
    const headers = () => ({
      dpop: this.proof(h, method, path, {}, token),
      ...(token ? { authorization: 'DPoP ' + token } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    });
    let response = await h.send(method, path, body, headers());
    if (response.body.code === 'use_dpop_nonce') {
      this.nonce = String(response.headers['dpop-nonce']);
      response = await h.send(method, path, body, headers());
    }
    return response;
  }
  accept(response: Response) {
    if (response.status !== 200)
      throw new Error('Synthetic credential exchange failed: ' + response.body.code);
    this.accessToken = response.body.accessToken as string;
    this.refreshToken = response.body.refreshToken as string;
    this.deviceId = response.body.deviceId as string;
  }
}
