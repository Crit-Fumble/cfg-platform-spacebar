# The platform Spacebar image: upstream spacebarchat/server at a pinned commit, plus patches/.
#
# A drop-in for upstream's own image (its flake's containers.docker.default): the same
# /bin/start-<module> entrypoints, WorkingDir /data (where Spacebar keeps its JWT keypair and
# files), PORT 3001. Two differences on purpose:
#   - node is on PATH (upstream's nix image keeps it under /nix/store/<hash>-nodejs-*), so a
#     healthcheck runs `node /opt/cfg/bus-check.mjs` instead of globbing the store;
#   - it builds for linux/amd64 and linux/arm64 (upstream publishes amd64 only).
#
# Bump upstream by changing SPACEBAR_COMMIT and re-checking every patch applies (CONTRIBUTING.md).
# The base is pinned by its multi-arch index digest in both FROM lines (literal, so Dependabot can
# bump them), so CI tests the base that ships.

ARG SPACEBAR_COMMIT=8ab020db8de9a4eb09d00d591ceb56fa3a1464b2

FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
ARG SPACEBAR_COMMIT
# git for the fetch; python3, make and g++ only for a native module with no prebuilt binary.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q \
  && git remote add origin https://github.com/spacebarchat/server.git \
  && git fetch -q --depth 1 origin "$SPACEBAR_COMMIT" \
  && git checkout -q FETCH_HEAD \
  && printf '{"rev":"%s","shortRev":"%.7s","lastModified":%s}\n' "$SPACEBAR_COMMIT" "$SPACEBAR_COMMIT" "$(git log -1 --format=%ct)" > .rev
COPY patches/ /patches/
# set -e: a patch that no longer applies stops the build here, whichever patch it is.
RUN set -e; for p in /patches/*.patch; do \
      [ -e "$p" ] || continue; \
      git apply --check "$p"; \
      git apply "$p"; \
      echo "applied $(basename "$p")"; \
    done
# Upstream's own postinstall (patch-package) and prepare (husky) run here, as in its nix build.
RUN npm ci
RUN npm run build
# prune keeps devOptional packages (typescript, ts-node and friends are optional peers of runtime
# deps); upstream's nix build drops them too. Package LICENSE files stay.
RUN npm prune --omit=dev \
  && rm -rf node_modules/typescript node_modules/ts-node node_modules/@tsconfig node_modules/@types \
            node_modules/.bin dist/src.tsbuildinfo \
  && find node_modules -name '*.map' -type f -delete

FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
ARG SPACEBAR_COMMIT
LABEL org.opencontainers.image.source="https://github.com/Crit-Fumble/cfg-platform-spacebar" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.description="Spacebar chat server (spacebarchat/server) at a pinned commit, with Crit-Fumble's patches" \
      dev.crit-fumble.spacebar.commit="$SPACEBAR_COMMIT"
WORKDIR /app
COPY --from=build /src/package.json /src/.rev ./
COPY --from=build /src/assets ./assets
COPY --from=build /src/dist ./dist
COPY --from=build /src/node_modules ./node_modules
# The modifications and the license travel with the image (AGPL-3.0).
COPY patches/ ./patches/
COPY LICENSE ./LICENSE
# Upstream's wrappers: node with NODE_PATH on the bundled node_modules, one per module that has a start.js.
RUN set -e; for f in /app/dist/*/start.js; do \
      m=$(basename "$(dirname "$f")"); \
      printf '#!/bin/sh\nexport NODE_PATH=/app/node_modules${NODE_PATH:+:$NODE_PATH}\nexec node --enable-source-maps %s "$@"\n' "$f" > "/bin/start-$m"; \
      chmod 0755 "/bin/start-$m"; \
    done; \
    printf '#!/bin/sh\nexport NODE_PATH=/app/node_modules${NODE_PATH:+:$NODE_PATH}\nexec node --enable-source-maps /app/dist/apply-migrations.js "$@"\n' > /bin/apply-migrations; \
    chmod 0755 /bin/apply-migrations; \
    ls /bin/start-bundle /bin/start-gateway
WORKDIR /data
ENV PORT=3001
EXPOSE 3001
CMD ["/bin/start-bundle"]
