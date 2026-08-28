# The proxy plus the CLI it drives.
#
# This image is not just the Node app: the proxy works by running `claude` as a subprocess,
# so the CLI has to be installed here and its version pinned. An unpinned `@latest` would
# mean a rebuild could change the thing actually answering requests without a single line
# of this repository changing.
#
# It deliberately ships NO credentials. The CLI keeps its OAuth token in
# `$HOME/.claude/.credentials.json`, and that file arrives from a volume at run time —
# baking it in would put a live subscription inside an image that gets pushed, pulled and
# layer-cached.
#
# Built with plain `docker build` — no BuildKit-only syntax — because the host this runs on
# has classic docker and no buildx.

FROM node:22-bookworm AS build

# `git` is here for the CLI, which shells out to it; `curl` for the healthcheck below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Pinned on purpose — see the note above. Bump it deliberately, not by rebuilding.
ARG CLAUDE_CLI_VERSION=2.1.247
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}" \
    && claude --version

WORKDIR /app

# Manifests first, so a source-only change does not reinstall the dependency tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# Prune after building: the TypeScript compiler is a build dependency and has no business
# in the image that runs.
RUN npm run build \
    && npm prune --omit=dev

# The CLI's HOME. Mounted over at run time with the directory holding
# `.claude/.credentials.json`; it must be WRITABLE, because the CLI refreshes that token in
# place. A read-only mount works right up until the access token expires and then fails as
# an auth error with no obvious cause.
ENV HOME=/claude-home
RUN mkdir -p /claude-home && chown -R node:node /claude-home /app

USER node

ENV HOST=0.0.0.0 \
    PORT=4523
EXPOSE 4523

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD curl -fsS http://127.0.0.1:4523/health || exit 1

CMD ["node", "dist/index.js"]
