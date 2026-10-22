// What the patches are for, end to end: members on open gateway sessions, and every channel and guild
// event reaches whom it should and no one else. Runs inside the image under test (test/compose.yml,
// `probe`), using the image's own `ws`. Exits 1 if any check differs from what a correct server does.
//
// Each check names the patch that makes it pass. A check named "guard" passes on upstream too: it
// holds a fix to what the patches must not break. Upstream at the pinned commit fails every patch's
// checks; the image with all of patches/ passes them all.
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
} catch (err) {
  console.log(`ERROR ${err.stack}`)
  failures.push('the probe itself')
} finally {
  for (const s of sessions) s.close()
}

console.log(failures.length ? `\n${failures.length} checks failed: ${failures.join('; ')}` : '\nall checks passed')
setTimeout(() => process.exit(failures.length ? 1 : 0), 200)
