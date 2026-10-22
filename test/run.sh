#!/usr/bin/env bash
# Boot the smoke stack on IMAGE (default cfg-platform-spacebar:dev), run the channel-events probe,
# and always tear down, an interrupted run included. Exit status is the probe's.
#
# Each run gets its own compose project, so two runs at once (two checkouts, parallel jobs) never
# share containers or volumes. COMPOSE_PROJECT_NAME, when set, wins.
set -uo pipefail
cd "$(dirname "$0")"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cfg-platform-spacebar-smoke-$$}"
compose=(docker compose -f compose.yml)

cleanup() { "${compose[@]}" --profile probe down -v --remove-orphans; }
trap cleanup EXIT
# An interrupt or kill exits through the EXIT trap too.
trap 'exit 130' INT
trap 'exit 143' TERM

"${compose[@]}" up -d --wait bundle gateway
status=$?
if [ "$status" -eq 0 ]; then
  "${compose[@]}" --profile probe run --rm probe
  status=$?
fi
if [ "$status" -ne 0 ]; then
  "${compose[@]}" logs --tail 150 bundle gateway
fi
exit "$status"
