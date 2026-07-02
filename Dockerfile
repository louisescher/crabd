# crab'd action image — self-contained: node_modules + built packages + the Flue app,
# so a run does zero install/build (only the model turn). Built once per release.
FROM node:22-bookworm-slim

# git: crab'd inspects and commits the working tree. ca-certificates: TLS for API/model calls.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

WORKDIR /app

# Copy manifests first for better layer caching. All workspace package.json files are
# needed so pnpm can resolve the workspace graph, even though we only install the action.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/config/package.json ./packages/config/
COPY packages/core/package.json ./packages/core/
COPY packages/action/package.json ./packages/action/
COPY packages/broker/package.json ./packages/broker/
COPY apps/docs/package.json ./apps/docs/

# Install only the action and its workspace dependencies (config, core) + their deps.
RUN pnpm install --frozen-lockfile --filter @crabd/action...

# Build config, core, and the action (tsdown + `flue build`).
COPY packages/config ./packages/config
COPY packages/core ./packages/core
COPY packages/action ./packages/action
RUN pnpm --filter @crabd/config --filter @crabd/core --filter @crabd/action build \
  && chmod +x /app/packages/action/docker-entrypoint.sh

ENTRYPOINT ["/app/packages/action/docker-entrypoint.sh"]
