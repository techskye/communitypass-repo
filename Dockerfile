# syntax=docker/dockerfile:1
# One Dockerfile, three runtime targets: api, worker, web.
# Alpine already ships libssl3 (needed by Prisma) and CA certificates — no OS packages to install.
FROM node:22-alpine AS base
RUN corepack enable
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
# Next.js bakes rewrite destinations in at build time (used when /api is not routed by Caddy).
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
RUN pnpm --filter @communitypass/shared build \
  && pnpm --filter @communitypass/core build \
  && pnpm --filter @communitypass/api build \
  && pnpm --filter @communitypass/worker build \
  && pnpm --filter @communitypass/web build

# API + worker + migrations share this image (Prisma CLI is included for `migrate deploy`).
FROM base AS backend
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
RUN rm -rf /app/apps/web && mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]

FROM base AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
