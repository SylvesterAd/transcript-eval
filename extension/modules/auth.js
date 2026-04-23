// JWT lifecycle for the extension. Storage is chrome.storage.local;
// nothing persists in service worker memory because MV3 service
// workers are terminated aggressively. Every caller reads fresh.

const STORAGE_KEY = 'te:jwt'

// Shape returned by POST /api/session-token and by the web app's
// {type:"session"} message:
//   { token: string, kid: string, user_id: string, expires_at: number (epoch_ms) }

export async function getJwt() {
  const { [STORAGE_KEY]: jwt } = await chrome.storage.local.get(STORAGE_KEY)
  return jwt || null
}

export async function setJwt(jwt) {
  if (!jwt || typeof jwt !== 'object' || Array.isArray(jwt)) throw new Error('setJwt: jwt must be an object')
  const { token, kid, user_id, expires_at } = jwt
  if (typeof token !== 'string' || !token) throw new Error('setJwt: token must be a non-empty string')
  if (typeof kid !== 'string' || !kid) throw new Error('setJwt: kid must be a non-empty string')
  if (typeof user_id !== 'string' || !user_id) throw new Error('setJwt: user_id must be a non-empty string')
  if (typeof expires_at !== 'number' || !Number.isFinite(expires_at)) throw new Error('setJwt: expires_at must be a finite number')
  await chrome.storage.local.set({ [STORAGE_KEY]: { token, kid, user_id, expires_at } })
}

export async function clearJwt() {
  await chrome.storage.local.remove(STORAGE_KEY)
}

// True if a JWT is present AND not expired. Called by popup + SW
// to decide whether the extension is "connected" to transcript-eval.
export async function hasValidJwt() {
  const jwt = await getJwt()
  if (!jwt) return false
  return jwt.expires_at > Date.now()
}
