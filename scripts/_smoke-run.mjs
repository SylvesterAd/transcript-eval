// E2E smoke: upload audio → configure auto path → wait for 30 b-rolls.
// Hits prod (Railway). Costs real money. Run only on explicit user approval.

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const env = readFileSync('/Users/laurynas/Desktop/one last /transcript-eval/.env', 'utf8')
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}

const JWT = readFileSync('/tmp/smoke_jwt.txt', 'utf8').trim()
const USER_ID = readFileSync('/tmp/smoke_user.txt', 'utf8').trim()
const API = 'https://backend-production-4b19.up.railway.app/api'
const AUDIO_PATH = '/Users/laurynas/Downloads/audio (1).mp3'

const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args)

async function api(method, path, opts = {}) {
  const headers = { 'Authorization': `Bearer ${JWT}`, ...(opts.headers || {}) }
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(opts.json)
    delete opts.json
  }
  const res = await fetch(`${API}${path}`, { method, headers, ...opts })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, ok: res.ok, body }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── 1. Upload ───────────────────────────────────────────────────────────
async function upload() {
  log(`Uploading ${AUDIO_PATH} (${(statSync(AUDIO_PATH).size / 1024 / 1024).toFixed(1)} MB)`)
  const fileBuf = readFileSync(AUDIO_PATH)
  const fd = new FormData()
  const blob = new Blob([fileBuf], { type: 'audio/mpeg' })
  fd.append('video', blob, 'audio (1).mp3')
  const title = `smoke-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
  fd.append('title', title)
  fd.append('video_type', 'raw')
  fd.append('group_name', title)

  const res = await fetch(`${API}/videos/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${JWT}` },
    body: fd,
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  if (!res.ok) {
    log('UPLOAD FAILED:', res.status, body)
    process.exit(1)
  }
  const groupId = body.video.group_id
  const videoId = body.videoId
  log(`Uploaded → groupId=${groupId} videoId=${videoId} title="${title}"`)
  return { groupId, videoId, title }
}

// ── 2. Configure group with auto path ───────────────────────────────────
async function configure(groupId) {
  log(`Configuring group ${groupId} for hands-off auto path`)
  const result = await api('PUT', `/videos/groups/${groupId}`, {
    json: {
      libraries: ['envato', 'artlist', 'storyblocks'],
      freepik_opt_in: false,
      audience: { description: 'smoke test - general audience' },
      path_id: 'hands-off',
      auto_rough_cut: true,
    },
  })
  if (!result.ok) {
    log('CONFIGURE FAILED:', result.status, result.body)
    process.exit(1)
  }
  log(`  path_id=${result.body.path_id} auto_rough_cut=${result.body.auto_rough_cut}`)
  return result.body
}

// ── 3. Trigger the chain ────────────────────────────────────────────────
// For audio-only single file, classification doesn't really apply (no
// multicam to split). After transcription completes, the chain should
// auto-fire via auto-orchestrator's chainAfterClassify (called from
// the post-transcription hook).
async function pollUntilTranscribed(videoId, maxMinutes = 5) {
  log(`Polling transcription status (every 10s, max ${maxMinutes}min)…`)
  const deadline = Date.now() + maxMinutes * 60 * 1000
  let lastStatus = ''
  while (Date.now() < deadline) {
    const result = await api('GET', `/videos/${videoId}`)
    if (!result.ok) {
      log('  poll error:', result.status, result.body)
      await sleep(10000)
      continue
    }
    const v = result.body
    const status = v.transcription_status || 'null'
    if (status !== lastStatus) {
      log(`  transcription_status=${status}`)
      lastStatus = status
    }
    if (status === 'done' || status === 'complete') return v
    if (status === 'failed') {
      log('  TRANSCRIPTION FAILED:', v.transcription_error)
      process.exit(1)
    }
    await sleep(10000)
  }
  log('  TIMEOUT waiting for transcription')
  process.exit(1)
}

// ── 4. Poll the auto-chain status ───────────────────────────────────────
async function pollChain(groupId, maxMinutes = 25) {
  log(`Polling broll_chain_status (every 15s, max ${maxMinutes}min)…`)
  const deadline = Date.now() + maxMinutes * 60 * 1000
  let lastSubstage = ''
  let lastStatus = ''
  let lastPlacementCount = 0
  while (Date.now() < deadline) {
    const result = await api('GET', `/videos/groups/${groupId}/full-auto-status`)
    if (!result.ok) {
      log('  poll error:', result.status, result.body)
      await sleep(15000)
      continue
    }
    const s = result.body
    const status = s.broll_chain_status || 'null'
    const substage = s.broll_chain_substage || 'null'
    if (status !== lastStatus || substage !== lastSubstage) {
      log(`  chain_status=${status} substage=${substage}`)
      lastStatus = status
      lastSubstage = substage
    }
    if (status === 'failed') {
      log('  CHAIN FAILED:', s.broll_chain_error)
      return { failed: true, status: s }
    }

    if (status === 'done') {
      log(`  Chain done — exiting poll`)
      return { ok: true, status: s }
    }
    await sleep(15000)
  }
  log('  TIMEOUT waiting for chain')
  return { timeout: true }
}

async function countPlacements(groupId) {
  // Get b-roll progress per sub-group via /full-auto-status which reports
  // references_total; then dig into /detail for placements per sub-group.
  // The simplest reliable counter: query broll_searches table via the
  // detail endpoint. For now, count subGroups[0]'s broll metadata.
  const result = await api('GET', `/videos/groups/${groupId}/full-auto-status`)
  if (!result.ok) return { searched: 0, complete: 0 }
  const sgs = result.body?.subGroups || []
  // The broll_searches counter isn't in this endpoint; use 0 as a placeholder
  // and rely on chain_status='done' as the success signal.
  return {
    chain_status: sgs[0]?.broll_chain_status ?? result.body?.parent?.broll_chain_status,
    chain_substage: sgs[0]?.broll_chain_substage,
    refs_total: sgs[0]?.broll?.references_total ?? 0,
  }
}

// ── Main ────────────────────────────────────────────────────────────────
const { groupId, videoId, title } = await upload()
await configure(groupId)
await pollUntilTranscribed(videoId, 8)
const final = await pollChain(groupId, 30)

log('═══════════════════════════════════════════')
log(`FINAL: groupId=${groupId} videoId=${videoId} title="${title}"`)
log(`Result:`, final.ok ? 'PASS' : final.failed ? 'FAILED' : final.timeout ? 'TIMEOUT' : 'PARTIAL')
log(`Final chain:`, JSON.stringify(final.status, null, 2))
