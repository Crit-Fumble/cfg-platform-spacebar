# Contributing

This repository carries no Spacebar source of its own: the Dockerfile fetches upstream at
`SPACEBAR_COMMIT` and applies `patches/*.patch` in order. Changes come as pull requests into `next`.

## A new patch

1. Check out upstream at the pinned commit (`SPACEBAR_COMMIT` at the top of the Dockerfile).
2. Make the fix there and commit it, with a message that reads well as an upstream pull request.
3. `git format-patch -1 -o <this repo>/patches --start-number <next number>`.
4. `docker build -t cfg-platform-spacebar:dev . && test/run.sh`. Add a check to
   `test/channel-events.mjs` (or a new probe beside it) that fails without the patch: build once with
   the patch removed and confirm that check fails there.
5. If the same commit is offered upstream, link that pull request in your pull request here.

## Bumping upstream

Change `SPACEBAR_COMMIT` at the top of the Dockerfile. The build runs `git apply --check` on every
patch under `set -e`, so one that no longer applies stops the build. Rebase it, or delete it if
upstream now carries the fix (`patches/.gitkeep` keeps the directory when none are left). Then run
`test/run.sh`.

The `node:24-slim` base is pinned by digest in both `FROM` lines; Dependabot proposes bumps.

## Releasing

Promote `next` to `main` by fast-forward, then tag the promoted commit `vX.Y.Z`. `release.yml`
publishes only a tag on `main` whose CI `test` check passed (amd64 and arm64).

The package takes this repository's public visibility, so anyone can pull it without
credentials. To confirm a release (prints `200`):

```bash
T=$(curl -s "https://ghcr.io/token?scope=repository:crit-fumble/cfg-platform-spacebar:pull" | jq -r .token)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/crit-fumble/cfg-platform-spacebar/manifests/<version>
```
