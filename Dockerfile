FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS builder
ENV CI=true NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
    NODE_OPTIONS=--max-old-space-size=1024 VITE_REFREF_API_ENDPOINT=/tracking \
    COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@10.34.7 --activate && \
    mkdir -p /app /runtime && chown node:node /app /runtime
WORKDIR /app
COPY --chown=node:node . .
USER node
RUN pnpm install --frozen-lockfile --ignore-scripts --store-dir=/app/.pnpm-store \
    --network-concurrency=4 --child-concurrency=1 \
    --filter refref --filter @refref/webapp... --filter @refref/api... --filter @refref/refer... \
    --filter @refref/widget... --filter @refref/attribution-script...
ARG PUBLIC_APP_URL=http://127.0.0.1:4310
ENV NEXT_PUBLIC_APP_URL=$PUBLIC_APP_URL NEXT_PUBLIC_REFER_URL=$PUBLIC_APP_URL/r \
    DATABASE_URL=postgresql://build-only.invalid/refref \
    BETTER_AUTH_SECRET=build-only-placeholder-not-a-runtime-secret \
    BETTER_AUTH_URL=$PUBLIC_APP_URL
RUN --network=none pnpm exec turbo run build --concurrency=1 --filter @refref/webapp... \
    --filter @refref/api... --filter @refref/refer... \
    --filter @refref/widget... --filter @refref/attribution-script...
RUN --network=none \
    pnpm --config.ignore-scripts=true --config.offline=true --config.store-dir=/app/.pnpm-store --filter @refref/api deploy --prod /runtime/api && \
    pnpm --config.ignore-scripts=true --config.offline=true --config.store-dir=/app/.pnpm-store --filter @refref/refer deploy --prod /runtime/refer

FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS node-runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
WORKDIR /app
USER node

FROM node-runtime AS webapp
ENV PORT=3000 HOSTNAME=0.0.0.0 NODE_OPTIONS=--max-old-space-size=448
COPY --from=builder --chown=node:node /app/apps/webapp/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/webapp/.next/static ./apps/webapp/.next/static
COPY --from=builder --chown=node:node /app/apps/webapp/public ./apps/webapp/public
CMD ["node", "apps/webapp/server.js"]

FROM node-runtime AS api
ENV PORT=3001 HOST=0.0.0.0 NODE_OPTIONS=--max-old-space-size=128
COPY --from=builder --chown=node:node /runtime/api ./
CMD ["node", "dist/index.js"]

FROM node-runtime AS refer
ENV PORT=3002 HOST=0.0.0.0 NODE_OPTIONS=--max-old-space-size=80
COPY --from=builder --chown=node:node /runtime/refer ./
CMD ["node", "dist/index.js"]

FROM api AS migrate
COPY --from=builder --chown=node:node /app/packages/coredb/drizzle ./migrations
COPY --chown=node:node infra/migrate.mjs infra/bootstrap.mjs ./infra/
CMD ["node", "infra/migrate.mjs"]

FROM nginx:stable-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5 AS gateway
COPY infra/nginx.conf /etc/nginx/nginx.conf
COPY --from=builder /app/packages/widget/dist/widget.umd.js /srv/assets/widget.v1.js
COPY --from=builder /app/packages/attribution-script/dist/attribution-script.umd.js /srv/assets/attribution.v1.js
USER nginx
ENTRYPOINT ["nginx", "-g", "daemon off;"]

FROM postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea AS database
COPY --chmod=755 infra/postgres-init.sh /docker-entrypoint-initdb.d/10-refref-roles.sh
COPY --chmod=755 infra/postgres-guard.sh /usr/local/bin/refref-postgres
ENTRYPOINT ["/usr/local/bin/refref-postgres"]
USER postgres
