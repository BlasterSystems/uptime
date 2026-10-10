# syntax=docker/dockerfile:1

# Native modules (better-sqlite3) are compiled on musl and run on musl — build and
# runtime MUST be the same libc (SPEC §10 correction, plan review B1).
FROM node:24-alpine AS build
RUN apk add --no-cache python3 make g++
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/notify/package.json packages/notify/
COPY packages/agent/package.json packages/agent/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @uptime/core --filter @uptime/db --filter @uptime/notify --filter @uptime/agent --filter @uptime/server build \
    && pnpm --filter @uptime/web build \
    && pnpm --filter @uptime/server --prod deploy --legacy /out

FROM node:24-alpine
# iputils provides the `ping` binary used by icmp monitors (Node has no raw ICMP
# sockets); requires NET_RAW on the container for non-root use.
RUN apk add --no-cache iputils
ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/data \
    WEB_DIST=/app/apps/web/dist
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /repo/apps/web/dist ./apps/web/dist
RUN addgroup -g 1001 uptime && adduser -u 1001 -G uptime -D uptime
USER uptime
VOLUME /data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/main.js"]
CMD ["server"]
