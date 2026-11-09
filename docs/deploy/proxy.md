# Reverse proxy & TLS

The container speaks plain HTTP on its port (3001 by default, `PORT` to
change) and expects TLS to terminate at the reverse proxy in front of it.
A proxy is not required — but it is the common setup, and the admin session
cookie is `Secure` whenever the request is, so production deployments should
front the app with HTTPS.

## Before you start

- **Tell the app about the proxy.** Set `TRUST_PROXY=1` (one proxy hop) in the
  environment. Without it, `req.ip` is the proxy's address — every per-IP
  rate limit (login, setup, password recovery) collapses into one shared
  bucket — and `req.secure` stays false, so cookies are issued without the
  `Secure` flag. See `deploy/.env.example`.
- **Live updates are SSE** (`GET /api/v1/events`, viewer auth): disable
  response buffering on `/api/` and keep proxy read timeouts above ~5 min.
  No WebSockets are needed.
- **`/metrics` is open by default.** Set `METRICS_ALLOWLIST` (IPv4/CIDR list)
  or block the path at the proxy if you don't intend to scrape it.
- Unauthenticated surface: `/healthz`, `/metrics`, `/api/v1/push/*` (the path
  token is the secret), published status pages, password recovery, and
  first-run `/auth/setup`.
- The container's `HEALTHCHECK` hits `/healthz` internally; for LB checks use
  `/healthz` too (200 = process + database reachable).

## Caddy (automatic HTTPS)

```caddyfile
uptime.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

That's the whole config — Caddy obtains/renews the certificate and streams
SSE without extra settings.

## Nginx Proxy Manager (NPM)

1. **Hosts → Proxy Hosts → Add**: domain `uptime.example.com`, scheme `http`,
   forward host `uptime-monitoring` (the compose service name) or the host IP,
   port `3001`.
2. **SSL tab**: request a certificate, enable *Force HTTPS*.
3. **Advanced tab** — custom nginx configuration for the host:

   ```nginx
   proxy_buffering off;
   proxy_read_timeout 3600s;
   ```

   The first line keeps the SSE event stream live (nginx buffers proxied
   responses by default), the second keeps long-lived event connections from
   being cut at the 60 s default timeout.

## Traefik (compose labels)

```yaml
services:
  uptime-monitoring:
    image: ghcr.io/blastersystems/uptime-monitoring:latest
    labels:
      - traefik.enable=true
      - traefik.http.routers.uptime.rule=Host(`uptime.example.com`)
      - traefik.http.routers.uptime.entrypoints=websecure
      - traefik.http.routers.uptime.tls.certresolver=le
      - traefik.http.services.uptime.loadbalancer.server.port=3001
```

Traefik streams SSE as-is; nothing to tune.

## Plain nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name uptime.example.com;

    ssl_certificate     /etc/letsencrypt/live/uptime.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/uptime.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;       # SSE: stream events instead of buffering
        proxy_read_timeout 3600s;  # SSE: keep long-lived connections open
    }
}
```

## Multiple proxy hops

Set `TRUST_PROXY` to the number of trusted hops in front of the container
(e.g. `2` for CDN → nginx → container), or an explicit list
(`TRUST_PROXY=loopback,10.0.0.0/8`). Anything Express accepts for its
`trust proxy` setting works.
