# cfg-platform-spacebar

The [Spacebar](https://github.com/spacebarchat/server) chat server that Crit-Fumble runs: upstream
`spacebarchat/server` at a pinned commit, plus the fixes in [`patches/`](patches/), built for
`linux/amd64` and `linux/arm64`.

```
ghcr.io/crit-fumble/cfg-platform-spacebar:<version>
```

It is a drop-in for upstream's own image: the same `/bin/start-bundle`, `/bin/start-gateway` (and
`start-api`, `start-cdn`, `start-webrtc`, `apply-migrations`) entrypoints, working directory `/data`,
port 3001. Unlike upstream's image, `node` is on `PATH`.

## The patches

All four fix the same confusion in the gateway: an event's routing key (its guild, channel or user) is
not always the thing the event is about. Each one is written to be offered upstream as it stands.

| Patch | What it fixes on an open gateway session |
|---|---|
| `0001` | A channel or DM created after the session connected sent it nothing. Closing a DM cut the session off from its own user's events, and a member who left a group DM kept receiving it. |
| `0002` | A member denied VIEW_CHANNEL kept receiving that channel. Reordering a channel hidden from a member cut them off from the whole guild. |
| `0003` | A member never heard that a channel was shown to them again (or shown for the first time), so it stayed silent until a reconnect. |
| `0004` | A guild joined while connected sent channels hidden from the member and no new channels. A member who left, or was kicked or banned, kept receiving the guild. |

What they do not change: a permission change that comes through a role (a role granted, removed or
edited) takes effect on open sessions at their next reconnect, as upstream. A thread created after a
session connected stays silent to it until a reconnect, as upstream.

`test/channel-events.mjs` holds a check for each: upstream at the pinned commit fails every patch's
checks, and this image passes them all.

## Build and test it

You need Docker with Compose. The smoke stack is the whole server: Postgres, the bundle (API and
CDN) and the standalone gateway, sharing a `/data` volume and a unix-socket event bus.

```bash
docker build -t cfg-platform-spacebar:dev .
test/run.sh            # boots test/compose.yml, runs the probe, tears down; IMAGE=<tag> picks another image
```

`test/compose.yml` is the probe's stack: it is reachable only inside its own compose network, and
its config (`test/spacebar-config.json`) advertises the compose-internal names `bundle` and
`gateway`. To run a server you can connect a client to, copy that config, set `general.serverName`,
`api.endpointPublic`, `cdn.endpointPublic`, `cdn.endpointPrivate` and `gateway.endpointPublic` to
addresses your client can reach, mount it as `CONFIG_PATH`, and publish ports 3001 and 3002.
Spacebar's own documentation covers the rest: <https://docs.spacebar.chat>.

Two settings matter when the bundle and gateway run as separate containers, as here:
- `EVENT_TRANSMISSION=unix` with the same `EVENT_SOCKET_PATH` on one shared volume in both;
- `init: true` on the gateway and not on the bundle. The event socket is named by PID, and both node
  processes would otherwise be PID 1 and claim the same socket.

## License

AGPL-3.0, as upstream Spacebar ([`LICENSE`](LICENSE), also at `/app/LICENSE` in the image). If you run
a modified copy as a network service, its users are entitled to the source; this repository is that
source for Crit-Fumble's, and the image carries its patches at `/app/patches`.
