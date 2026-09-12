FROM node:24.13.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:24.13.1-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24.13.1-bookworm-slim AS runtime-base
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production CODEVO_HOST=0.0.0.0 CODEVO_PORT=4318 CODEVO_DATA_DIR=/data
EXPOSE 4318
CMD ["node", "dist/src/main.js"]

# Explicit opt-in toolchain. Never mount a Docker socket into this runner.
FROM runtime-base AS execution
USER root
ARG CODEX_CLI_VERSION=0.154.0
ARG CLAUDE_CLI_VERSION=2.1.270
RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_CLI_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}" \
    && npm cache clean --force \
    && mkdir -p /data/projects /data/workspaces /data/provider-home/.codex \
    && chown -R node:node /data
USER node
ENV HOME=/data/provider-home CODEX_HOME=/data/provider-home/.codex

# Keep plain `docker build .` on the small, non-executing image.
FROM runtime-base AS runtime
