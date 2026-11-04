export type ProxyConfig = {
  origin: string;
  listen: string;
  apiPort: number;
  webPort: number;
  apiCA: string;
  apiName: string;
  edgeCertificate: string;
  edgeKey: string;
  passwordFile: string;
  pid: string;
  cache: string;
  accessLog?: string;
};
function path(value: string) {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(value) || value.split('/').includes('..'))
    throw new Error('Unsafe proxy configuration path.');
  return `"${value}"`;
}
export function renderProxy(config: ProxyConfig): string {
  const origin = new URL(config.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !/^[a-z0-9.-]+$/.test(origin.hostname) ||
    !/^(?:127\.0\.0\.1:)?\d{2,5}$/.test(config.listen) ||
    !/^[a-z0-9.-]+$/.test(config.apiName) ||
    ![config.apiPort, config.webPort].every((p) => Number.isInteger(p) && p > 1024 && p <= 65535)
  )
    throw new Error('Invalid HTTPS proxy configuration.');
  const listenPort = Number(config.listen.split(':').at(-1));
  if (
    (listenPort < 1024 && listenPort !== 443) ||
    listenPort > 65535 ||
    listenPort !== Number(origin.port || 443)
  )
    throw new Error('Proxy listener must match its HTTPS origin.');
  return `# Generated Attuner staging configuration. Never log request URIs, headers or bodies.
worker_processes 2;
pid ${path(config.pid)};
error_log /dev/null;
events { worker_connections 256; }
http {
  server_tokens off;
  map $request_method $attuner_method { default OTHER; GET GET; HEAD HEAD; POST POST; PUT PUT; PATCH PATCH; DELETE DELETE; OPTIONS OPTIONS; }
  map $uri $attuner_route { default web; ~^/api/v1/health/ health; ~^/api/v1/ api; }
  log_format attuner_safe escape=json '{"event":"proxy.request","requestId":"$request_id","method":"$attuner_method","route":"$attuner_route","status":$status,"duration":$request_time}';
  access_log ${path(config.accessLog ?? '/dev/stdout')} attuner_safe;
  limit_req_zone $binary_remote_addr zone=attuner_requests:10m rate=30r/s;
  limit_req_zone $binary_remote_addr zone=attuner_login:1m rate=5r/m;
  limit_conn_zone $binary_remote_addr zone=attuner_connections:1m;
  client_body_temp_path ${path(config.cache + '/body')};
  proxy_temp_path ${path(config.cache + '/proxy')};
  fastcgi_temp_path ${path(config.cache + '/fastcgi')};
  uwsgi_temp_path ${path(config.cache + '/uwsgi')};
  scgi_temp_path ${path(config.cache + '/scgi')};
  client_max_body_size 17m;
  client_body_buffer_size 64k;
  client_header_buffer_size 1k;
  large_client_header_buffers 4 8k;
  client_body_timeout 60s;
  client_header_timeout 15s;
  keepalive_timeout 15s;
  send_timeout 65s;
  server {
    listen ${config.listen} ssl;
    server_name ${origin.hostname};
    if ($host != "${origin.hostname}") { return 444; }
    ssl_certificate ${path(config.edgeCertificate)};
    ssl_certificate_key ${path(config.edgeKey)};
    ssl_password_file ${path(config.passwordFile)};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_tickets off;
    add_header Strict-Transport-Security "max-age=86400" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    limit_req zone=attuner_requests burst=120 nodelay;
    limit_conn attuner_connections 32;
    limit_req_status 429;
    limit_conn_status 429;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Origin $http_origin;
    proxy_set_header Connection "";
    proxy_connect_timeout 10s;
    proxy_read_timeout 65s;
    proxy_send_timeout 65s;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_max_temp_file_size 0;
    proxy_ssl_server_name on;
    proxy_ssl_name ${config.apiName};
    proxy_ssl_trusted_certificate ${path(config.apiCA)};
    proxy_ssl_verify on;
    proxy_ssl_verify_depth 2;
    location = /api/v1/auth/login {
      limit_req zone=attuner_login burst=5 nodelay;
      proxy_pass https://127.0.0.1:${config.apiPort};
    }
    location /api/v1/ { proxy_pass https://127.0.0.1:${config.apiPort}; }
    location / { proxy_pass http://127.0.0.1:${config.webPort}; }
  }
}
`;
}
