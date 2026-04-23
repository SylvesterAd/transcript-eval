// Extension JWT mint + verify (HS256, key ring indexed by kid).
// Web app calls mintExtToken(userId) after Supabase auth; extension
// stores the token in chrome.storage.local and sends it as
// Authorization: Bearer <token> on /api/export-events and
// /api/<source>-url. Rotation: add new entry to EXT_JWT_KEYS, flip
// EXT_JWT_CURRENT_KID; in-flight tokens keep working until their
// exp, because verify tries every key in the ring.

import { SignJWT, jwtVerify } from 'jose'

const ISSUER = 'transcript-eval'
const AUDIENCE = 'transcript-eval-ext'
const TTL_SECONDS = 8 * 60 * 60  // 8h

let ringCache = null
let currentKidCache = null

function loadRing() {
  if (ringCache) return ringCache
  const raw = process.env.EXT_JWT_KEYS
  if (!raw) throw new Error('EXT_JWT_KEYS env var is not set')
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new Error('EXT_JWT_KEYS must be JSON') }
  const ring = {}
  for (const [kid, b64] of Object.entries(parsed)) {
    const bytes = Buffer.from(b64, 'base64')
    if (bytes.length < 32) throw new Error(`EXT_JWT_KEYS.${kid} must be ≥32 bytes of base64-encoded key material`)
    ring[kid] = new Uint8Array(bytes)
  }
  if (!Object.keys(ring).length) throw new Error('EXT_JWT_KEYS is empty')
  const currentKid = process.env.EXT_JWT_CURRENT_KID
  if (!currentKid) throw new Error('EXT_JWT_CURRENT_KID env var is not set')
  if (!ring[currentKid]) throw new Error(`EXT_JWT_CURRENT_KID=${currentKid} has no matching entry in EXT_JWT_KEYS`)
  ringCache = ring
  currentKidCache = currentKid
  return ring
}

export async function mintExtToken(userId) {
  if (!userId) throw new Error('userId required')
  const ring = loadRing()
  const kid = currentKidCache
  const key = ring[kid]
  const nowSec = Math.floor(Date.now() / 1000)
  const exp = nowSec + TTL_SECONDS
  const token = await new SignJWT({ sub: String(userId) })
    .setProtectedHeader({ alg: 'HS256', kid, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(nowSec)
    .setExpirationTime(exp)
    .sign(key)
  return { token, kid, user_id: String(userId), expires_at: exp * 1000 }
}

export async function verifyExtToken(token) {
  if (!token) throw new Error('token required')
  const ring = loadRing()
  // Peek at header to pick the right key without parsing the body twice
  const headerB64 = token.split('.')[0] || ''
  let header
  try { header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8')) } catch { throw new Error('malformed token') }
  const kid = header.kid
  if (!kid || !ring[kid]) throw new Error('unknown kid')
  const { payload } = await jwtVerify(token, ring[kid], { issuer: ISSUER, audience: AUDIENCE })
  return { userId: payload.sub, payload, kid }
}

// Express middleware. Attaches req.ext = { userId, payload, kid }
// on success, otherwise responds 401.
export async function requireExtAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return res.status(401).json({ error: 'Missing bearer token' })
  }
  try {
    req.ext = await verifyExtToken(token)
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token', detail: err.message })
  }
}
