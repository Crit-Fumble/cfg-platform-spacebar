// What the patches are for, end to end: members on open gateway sessions, and every channel and guild
// event reaches whom it should and no one else. Runs inside the image under test (test/compose.yml,
// `probe`), using the image's own `ws`. Exits 1 if any check differs from what a correct server does.
//
// Each check names the patch that makes it pass. A check named "guard" passes on upstream too: it
// holds a fix to what the patches must not break. Upstream at the pinned commit fails every patch's
// checks; the image with all of patches/ passes them all.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('/app/package.json')
const WebSocket = require('ws')

const API = process.env.SPACEBAR_API ?? 'http://bundle:3001/api/v9'
const GW = process.env.SPACEBAR_GATEWAY ?? 'ws://gateway:3002/?encoding=json&v=9'
const tag = `smoke${Date.now().toString(36)}`
const PASSWORD = `Pw-${tag}-x9!`
const VIEW_CHANNEL = String(1 << 10)
const GUILD_TEXT = 0
const PUBLIC_THREAD = 11
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const check = (name, want, got) => {
  console.log(`${got === want ? 'ok  ' : 'FAIL'} ${name} (want ${want}, got ${got})`)
  if (got !== want) failures.push(name)
}

async function api(user, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { authorization: user.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, json }
}

/** A REST call that must succeed: setup steps fail the probe loudly instead of reading as a delivery bug. */
async function must(user, method, path, body) {
  const r = await api(user, method, path, body)
  if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}

async function register(name) {
  const r = await api(null, 'POST', '/auth/register', {
    username: name, email: `${name}@smoke.local`, password: PASSWORD, consent: true, date_of_birth: '1990-01-01',
  })
  if (!r.json?.token) throw new Error(`register ${name}: ${r.status} ${JSON.stringify(r.json)}`)
  const me = await api({ token: r.json.token }, 'GET', '/users/@me')
  return { name, token: r.json.token, id: me.json.id }
}

/** IDENTIFY and resolve on READY. The gateway may still be booting, so connection errors retry. */
async function gateway(user) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        // Spacebar refuses a gateway connection with no User-Agent unless its config says otherwise.
        const ws = new WebSocket(GW, { headers: { 'User-Agent': 'cfg-platform-spacebar-smoke' } })
        const events = []
        let seq = null
        let hb
        ws.on('message', (raw) => {
          const m = JSON.parse(raw.toString())
          if (m.s) seq = m.s
          if (m.op === 10) {
            hb = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), m.d.heartbeat_interval)
            ws.send(JSON.stringify({ op: 2, d: { token: user.token, properties: { os: 'linux', browser: 'smoke', device: 'smoke' }, intents: 3276799 } }))
          }
          if (m.op === 0) {
            events.push({ t: m.t, d: m.d })
            if (m.t === 'READY') resolve({ events, close: () => { clearInterval(hb); ws.close(1000) } })
          }
        })
        ws.on('close', () => clearInterval(hb))
        ws.on('error', reject)
        setTimeout(() => reject(new Error(`${user.name}: no READY in 10 s`)), 10_000)
      })
    } catch (e) {
      if (attempt >= 15) throw e
      await sleep(2_000)
    }
  }
}

/** Did an event `t` matching `pred` reach the session (or had it already) within `ms`? */
async function arrives(session, t, pred, ms = 4_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (session.events.some((e) => e.t === t && pred(e.d))) return true
    await sleep(100)
  }
  return false
}

let n = 0
/** Post a fresh message and report whether each of `sessions` received it (negatives wait 3 s). */
async function deliver(user, channelId, sessions, ms = 4_000) {
  const content = `m${++n}-${tag}`
  await must(user, 'POST', `/channels/${channelId}/messages`, { content })
  return Promise.all(sessions.map((s) => arrives(s, 'MESSAGE_CREATE', (d) => d.content === content, ms)))
}
const one = async (user, channelId, session, ms) => (await deliver(user, channelId, [session], ms))[0]
const overwrite = (target, type, allow, deny) => ({ id: target, type, allow, deny })

// 0005: each package that carried an advisory is at or past the release that fixes it.
const FLOORS = { multer: '2.5.0', 'body-parser': '2.4.0', 'proxy-addr': '2.0.8', undici: '7.30.1' }
const atLeast = (version, floor) => {
  const [v, f] = [version, floor].map((s) => s.split('.').map(Number))
  for (let i = 0; i < 3; i++) if (v[i] !== f[i]) return v[i] > f[i]
  return true
}
for (const [pkg, floor] of Object.entries(FLOORS)) {
  const { version } = JSON.parse(readFileSync(`/app/node_modules/${pkg}/package.json`, 'utf8'))
  check(`${pkg} ${version} is at or past ${floor} (0005)`, true, atLeast(version, floor))
}

const sessions = []
try {
  const A = await register(`${tag}a`) // the guild owner
  const B = await register(`${tag}b`) // a member from the start
  const C = await register(`${tag}c`) // joins while connected, then is kicked

  const guild = await must(A, 'POST', '/guilds', { name: `smoke ${tag}` })
  const everyone = guild.id // the @everyone role's id is the guild's
  const general = (await must(A, 'GET', `/guilds/${guild.id}/channels`)).find((c) => c.type === GUILD_TEXT)
  // Hidden from @everyone before anyone connects: #staff stays hidden, #secret is revealed later.
  const hidden = [overwrite(everyone, 0, '0', VIEW_CHANNEL)]
  const staff = await must(A, 'POST', `/guilds/${guild.id}/channels`, { name: 'staff', type: GUILD_TEXT, permission_overwrites: hidden })
  const secret = await must(A, 'POST', `/guilds/${guild.id}/channels`, { name: 'secret', type: GUILD_TEXT, permission_overwrites: hidden })
  const invite = await must(A, 'POST', `/channels/${general.id}/invites`, { max_age: 600 })
  await must(B, 'POST', `/invites/${invite.code}`, {})

  const sA = await gateway(A); sessions.push(sA)
  const sB = await gateway(B); sessions.push(sB)
  const sC = await gateway(C); sessions.push(sC)

  // READY lands before a session's listeners are bound: post until both members echo one.
  let live = false
  for (let i = 0; i < 20 && !live; i++) live = (await deliver(A, general.id, [sA, sB], 500)).every(Boolean)
  check('the bus delivers a message to both members', true, live)

  // ── New channels and edits ───────────────────────────────────────────────────────────────────
  const late = await must(A, 'POST', `/guilds/${guild.id}/channels`, { name: 'late', type: GUILD_TEXT })
  check('CHANNEL_CREATE reaches the owner', true, await arrives(sA, 'CHANNEL_CREATE', (d) => d.id === late.id))
  check('CHANNEL_CREATE reaches the member', true, await arrives(sB, 'CHANNEL_CREATE', (d) => d.id === late.id))
  check('a new channel\'s message reaches the member without a reconnect (0001)', true, await one(A, late.id, sB))
  await must(A, 'PATCH', `/channels/${general.id}`, { name: 'renamed' })
  check('a rename reaches the member as CHANNEL_UPDATE', true, await arrives(sB, 'CHANNEL_UPDATE', (d) => d.id === general.id && d.name === 'renamed'))

  // ── Losing and regaining a channel (#general: every session subscribes it at IDENTIFY) ──────────
  const denyB = overwrite(B.id, 1, '0', VIEW_CHANNEL)
  await must(A, 'PUT', `/channels/${general.id}/permissions/${B.id}`, denyB)
  check('a member deny takes effect over REST', 403, (await api(B, 'GET', `/channels/${general.id}/messages?limit=1`)).status)
  await sleep(500)
  const [ownerGets, memberGets] = await deliver(A, general.id, [sA, sB], 3_000)
  check('the owner still gets a channel denied to a member', true, ownerGets)
  check('a member denied VIEW_CHANNEL stops getting it on an open session (0002)', false, memberGets)
  await must(A, 'DELETE', `/channels/${general.id}/permissions/${B.id}`)
  await sleep(500)
  check('a member re-allowed by removing the deny gets it again without a reconnect (0003; 0002 alone breaks it)', true, await one(A, general.id, sB))
  await must(A, 'PUT', `/channels/${general.id}/permissions/${B.id}`, denyB)
  await sleep(500)
  await must(A, 'PUT', `/channels/${general.id}/permissions/${B.id}`, overwrite(B.id, 1, VIEW_CHANNEL, '0'))
  await sleep(500)
  check('a member re-allowed by an allow overwrite gets it again without a reconnect (0003; 0002 alone breaks it)', true, await one(A, general.id, sB))
  check('a channel hidden at connect sends the member nothing (guard)', false, await one(A, secret.id, sB, 3_000))
  await must(A, 'DELETE', `/channels/${secret.id}/permissions/${everyone}`)
  await sleep(500)
  check('a channel hidden at connect and then revealed reaches the member without a reconnect (0003)', true, await one(A, secret.id, sB))

  // ── What a member who cannot manage or see must not get ──────────────────────────────────────
  const invite2 = await must(A, 'POST', `/channels/${general.id}/invites`, { max_age: 600 })
  check('INVITE_CREATE reaches the owner', true, await arrives(sA, 'INVITE_CREATE', (d) => d.code === invite2.code))
  check('INVITE_CREATE never reaches a member who cannot manage the guild', false, await arrives(sB, 'INVITE_CREATE', (d) => d.code === invite2.code, 3_000))
  const thread = await must(A, 'POST', `/channels/${staff.id}/threads`, { name: 'staff-thread', type: PUBLIC_THREAD })
  check('the member cannot read a thread in a channel hidden from them', 403, (await api(B, 'GET', `/channels/${thread.id}/messages?limit=1`)).status)
  await one(A, thread.id, sA, 1_000)
  check('a thread in a channel hidden from the member sends them nothing (guard)', false, await one(A, thread.id, sB, 3_000))

  // ── DMs ──────────────────────────────────────────────────────────────────────────────────────
  const dmAB = await must(A, 'POST', '/users/@me/channels', { recipients: [B.id] })
  check('a DM opened after connect delivers to the recipient (0001)', true, await one(A, dmAB.id, sB))
  const dmBA = await must(B, 'POST', '/users/@me/channels', { recipients: [A.id] })
  await must(B, 'DELETE', `/channels/${dmBA.id}`)
  await sleep(500)
  const group = await must(A, 'POST', '/users/@me/channels', { recipients: [B.id, C.id] })
  check('after closing a DM, a new DM still reaches the member (0001; guard against the user listener being cancelled)', true,
    await arrives(sB, 'CHANNEL_CREATE', (d) => d.id === group.id))
  check('a group DM opened after connect delivers to a recipient (0001)', true, await one(A, group.id, sB))
  await must(B, 'DELETE', `/channels/${group.id}`)
  await sleep(500)
  check('a member who left a group DM stops getting it (0001)', false, await one(A, group.id, sB, 3_000))

  // ── Joining and leaving while connected ──────────────────────────────────────────────────────
  await must(C, 'POST', `/invites/${invite.code}`, {})
  const joined = await arrives(sC, 'GUILD_CREATE', (d) => d.id === guild.id, 6_000)
  check('a member who joins while connected gets GUILD_CREATE', true, joined)
  await sleep(1_000)
  check('a member who joined while connected gets the guild\'s messages', true, await one(A, general.id, sC))
  check('a member who joined while connected gets nothing from a channel hidden from them (0004)', false, await one(A, staff.id, sC, 3_000))
  const later = await must(A, 'POST', `/guilds/${guild.id}/channels`, { name: 'later', type: GUILD_TEXT })
  check('a member who joined while connected gets the guild\'s next CHANNEL_CREATE (0004)', true, await arrives(sC, 'CHANNEL_CREATE', (d) => d.id === later.id))
  await must(A, 'PUT', `/channels/${general.id}/permissions/${C.id}`, overwrite(C.id, 1, '0', VIEW_CHANNEL))
  await sleep(500)
  check('a member who joined while connected and is then denied stops getting the channel (0004)', false, await one(A, general.id, sC, 3_000))
  await must(A, 'DELETE', `/channels/${general.id}/permissions/${C.id}`)
  await sleep(500)
  check('a member who joined while connected gets a channel again once the deny is removed', true, await one(A, general.id, sC))
  await must(A, 'DELETE', `/guilds/${guild.id}/members/${C.id}`)
  await sleep(1_000)
  check('a kicked member stops getting the guild\'s messages (0004)', false, await one(A, general.id, sC, 3_000))
  const dmAC = await must(A, 'POST', '/users/@me/channels', { recipients: [C.id] })
  check('after a kick, a new DM still reaches the member (0004; guard against the user listener being cancelled)', true,
    await arrives(sC, 'CHANNEL_CREATE', (d) => d.id === dmAC.id))

  // ── Guild reads a Discord bot relies on (C is now kicked, never banned) ─────────────────────
  const answer = (r) => `${r.status} ${r.json?.code}`
  check('a ban that does not exist is 404 Unknown Ban (0007)', '404 10026', answer(await api(A, 'GET', `/guilds/${guild.id}/bans/${C.id}`)))
  check('a user who is not a member is 404 Unknown Member (0007)', '404 10007', answer(await api(A, 'GET', `/guilds/${guild.id}/members/${C.id}`)))
  const byUserId = [A.id, B.id].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1)).join(',')
  const listed = await api(A, 'GET', `/guilds/${guild.id}/members?limit=1000`)
  check('the member list with no `after` lists every member\'s user.id by user id (0007)', byUserId,
    Array.isArray(listed.json) ? listed.json.map((m) => m.user?.id).join(',') : `${listed.status}`)
  const walked = []
  for (let after = '0', page = 0; page < 5; page++) {
    const r = await api(A, 'GET', `/guilds/${guild.id}/members?limit=1&after=${after}`)
    if (!Array.isArray(r.json) || r.json.length === 0 || !r.json[0].user?.id) break
    walked.push((after = r.json[0].user.id))
  }
  check('the member list pages by `after` = the last user.id (0007)', byUserId, walked.join(','))
  const counted = await api(A, 'GET', `/guilds/${guild.id}?with_counts=true`)
  check('with_counts adds approximate_member_count (0007)', 2, counted.json?.approximate_member_count)
  check('with_counts adds approximate_presence_count (0007)', 'number', typeof counted.json?.approximate_presence_count)

  // ── Unbans a Discord bot relies on (B is banned here, so this section comes last) ───────────
  check('unbanning a user with no ban is 404 Unknown Ban (0008)', '404 10026', answer(await api(A, 'DELETE', `/guilds/${guild.id}/bans/${C.id}`)))
  await must(A, 'PUT', `/guilds/${guild.id}/bans/${B.id}`, {})
  check('a banned member\'s ban reads back before the unban', 200, (await api(A, 'GET', `/guilds/${guild.id}/bans/${B.id}`)).status)
  check('unbanning a banned user deletes the ban with 204 (guard)', 204, (await api(A, 'DELETE', `/guilds/${guild.id}/bans/${B.id}`)).status)
  check('a lifted ban is gone afterwards', '404 10026', answer(await api(A, 'GET', `/guilds/${guild.id}/bans/${B.id}`)))

  // ── Handing a guild over, and deleting an account that left things behind (0009, 0010) ─────
  const D = await register(`${tag}d`) // owns a guild, hands it to E, then deletes their account
  const E = await register(`${tag}e`) // the member who takes the guild over
  const F = await register(`${tag}f`) // never a member
  const G = await register(`${tag}g`) // an admin who starts a thread, uploads an emoji, bans, owns a group DM
  const H = await register(`${tag}h`) // the member G bans
  const g2 = await must(D, 'POST', '/guilds', { name: `handover ${tag}` })
  const g2general = (await must(D, 'GET', `/guilds/${g2.id}/channels`)).find((c) => c.type === GUILD_TEXT)
  const g2invite = await must(D, 'POST', `/channels/${g2general.id}/invites`, { max_age: 600 })
  for (const u of [E, G, H]) await must(u, 'POST', `/invites/${g2invite.code}`, {})
  const MANAGE_GUILD = String(1 << 5)
  const ADMINISTRATOR = String(1 << 3)
  const managers = await must(D, 'POST', `/guilds/${g2.id}/roles`, { name: 'managers', permissions: MANAGE_GUILD })
  const admins = await must(D, 'POST', `/guilds/${g2.id}/roles`, { name: 'admins', permissions: ADMINISTRATOR })
  await must(D, 'PUT', `/guilds/${g2.id}/members/${E.id}/roles/${managers.id}`)
  await must(D, 'PUT', `/guilds/${g2.id}/members/${G.id}/roles/${admins.id}`)
  const sE = await gateway(E); sessions.push(sE)
  const ownerOf = async () => (await api(D, 'GET', `/guilds/${g2.id}`)).json?.owner_id ?? (await api(E, 'GET', `/guilds/${g2.id}`)).json?.owner_id

  const byManager = await api(E, 'PATCH', `/guilds/${g2.id}`, { owner_id: E.id })
  check('a member with Manage Server who is not the owner cannot take the guild (0009)', '50013', `${byManager.json?.code}`)
  check('the guild keeps its owner after a refused transfer (0009)', D.id, await ownerOf())
  check('a transfer to a user who is not a member is 404 Unknown Member (0009)', '404 10007',
    answer(await api(D, 'PATCH', `/guilds/${g2.id}`, { owner_id: F.id })))
  const handed = await api(D, 'PATCH', `/guilds/${g2.id}`, { owner_id: E.id })
  check('the owner hands the guild to a member (0009)', `200 ${E.id}`, `${handed.status} ${handed.json?.owner_id}`)
  check('the new owner reads back (0009)', E.id, await ownerOf())
  check('the new owner gets GUILD_UPDATE naming them (0009)', true,
    await arrives(sE, 'GUILD_UPDATE', (d) => d.id === g2.id && d.owner_id === E.id))
  check('the former owner can then delete their account (0009)', 204,
    (await api(D, 'POST', '/users/@me/delete', { password: PASSWORD })).status)

  const gThread = await must(G, 'POST', `/channels/${g2general.id}/threads`, { name: 'g-thread', type: PUBLIC_THREAD })
  const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const gEmoji = await must(G, 'POST', `/guilds/${g2.id}/emojis`, { name: `e${tag}`.slice(0, 32), image: PIXEL, roles: [] })
  await must(G, 'PUT', `/guilds/${g2.id}/bans/${H.id}`, {})
  const gGroup = await must(G, 'POST', '/users/@me/channels', { recipients: [E.id, H.id] })
  check('a user who started a thread, uploaded an emoji, banned someone and owns a group DM deletes their account (0010)', 204,
    (await api(G, 'POST', '/users/@me/delete', { password: PASSWORD })).status)
  check('the deleted account cannot sign in (0010)', 400,
    (await api(null, 'POST', '/auth/login', { login: `${G.name}@smoke.local`, password: PASSWORD })).status)
  const threadAfter = await api(E, 'GET', `/channels/${gThread.id}`)
  check('their thread stays, with no owner (0010)', '200 null', `${threadAfter.status} ${threadAfter.json?.owner_id ?? null}`)
  const emojisAfter = await api(E, 'GET', `/guilds/${g2.id}/emojis`)
  check('their emoji stays (0010)', true, Array.isArray(emojisAfter.json) && emojisAfter.json.some((e) => e.id === gEmoji.id))
  check('their ban stays (0010)', 200, (await api(E, 'GET', `/guilds/${g2.id}/bans/${H.id}`)).status)
  const groupAfter = await api(E, 'GET', `/channels/${gGroup.id}`)
  check('their group DM stays for the others, without them (0010)', `200 false`,
    `${groupAfter.status} ${(groupAfter.json?.recipients ?? []).some((r) => r.id === G.id)}`)
  check('their group DM passes to another recipient (0010)', true, [E.id, H.id].includes(groupAfter.json?.owner_id))
} catch (err) {
  console.log(`ERROR ${err.stack}`)
  failures.push('the probe itself')
} finally {
  for (const s of sessions) s.close()
}

console.log(failures.length ? `\n${failures.length} checks failed: ${failures.join('; ')}` : '\nall checks passed')
setTimeout(() => process.exit(failures.length ? 1 : 0), 200)
