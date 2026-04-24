// Popup renders STATE ONLY — reads from chrome.storage.local and
// config.js, never writes. Export progress UI lives on the web app
// export page (per spec § "Popup UI").

import { EXT_VERSION, BACKEND_URL } from './config.js'
import { getJwt, hasEnvatoSession } from './modules/auth.js'

function setRow(rowEl, statusEl, detailEl, state) {
  statusEl.textContent = state.text
  statusEl.className = `row-status ${state.className}`
  detailEl.textContent = state.detail || ''
  if (state.onClick) {
    rowEl.classList.add('clickable')
    rowEl.onclick = state.onClick
    rowEl.setAttribute('role', 'button')
    rowEl.setAttribute('tabindex', '0')
    rowEl.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        state.onClick()
      }
    }
  } else {
    rowEl.classList.remove('clickable')
    rowEl.onclick = null
    rowEl.onkeydown = null
    rowEl.removeAttribute('role')
    rowEl.removeAttribute('tabindex')
  }
}

async function renderEnvatoRow(statusFromStorage) {
  const rowEn = document.getElementById('row-envato')
  const statusEn = document.getElementById('status-envato')
  const detailEn = document.getElementById('detail-envato')

  // Trust storage when it has a value; fall back to a live cookie
  // read for the first-run case (watcher hasn't primed storage).
  let status = statusFromStorage
  if (status !== 'ok' && status !== 'missing') {
    status = (await hasEnvatoSession()) ? 'ok' : 'missing'
  }

  if (status === 'ok') {
    setRow(rowEn, statusEn, detailEn, {
      text: 'connected',
      className: 'ok',
      detail: 'session cookies present',
    })
  } else {
    setRow(rowEn, statusEn, detailEn, {
      text: 'sign in required',
      className: 'warn',
      detail: 'Click to open Envato sign-in',
      onClick: () => chrome.tabs.create({ url: 'https://app.envato.com/sign-in' }),
    })
  }
  return status
}

async function renderTeRow() {
  const rowTe = document.getElementById('row-te')
  const statusTe = document.getElementById('status-te')
  const detailTe = document.getElementById('detail-te')

  const jwt = await getJwt()
  const connected = !!jwt && jwt.expires_at > Date.now()

  if (connected) {
    const expires = new Date(jwt.expires_at).toLocaleString()
    setRow(rowTe, statusTe, detailTe, {
      text: 'connected',
      className: 'ok',
      detail: `user ${jwt.user_id.slice(0, 8)}… · expires ${expires}`,
    })
  } else {
    setRow(rowTe, statusTe, detailTe, {
      text: 'not signed in',
      className: 'warn',
      detail: 'Click to open transcript-eval',
      onClick: () => chrome.tabs.create({ url: BACKEND_URL }),
    })
  }
  return connected
}

async function renderBanner() {
  const { envato_session_status } = await chrome.storage.local.get('envato_session_status')
  const jwt = await getJwt()
  const teOk = !!jwt && jwt.expires_at > Date.now()
  const envOk = envato_session_status === 'ok' || (envato_session_status == null && await hasEnvatoSession())
  const banner = document.getElementById('banner')
  if (teOk && envOk) banner.textContent = 'Ready. Start an export from transcript-eval.'
  else if (!teOk) banner.textContent = 'Sign in at transcript-eval to continue.'
  else banner.textContent = 'Sign in to Envato to continue.'
}

// Ext.7: Check if the most-recent run ended with disk_failed (a
// chrome.downloads FILE_* interrupt → hardStopQueue). If so, render a
// recovery hint pointing the user at Chrome's download settings so
// they can change the folder without a DevTools spelunk.
async function renderDiskErrorIfAny() {
  const container = document.getElementById('disk-error')
  if (!container) return false
  container.innerHTML = ''
  container.style.display = 'none'
  try {
    const { active_run_id } = await chrome.storage.local.get('active_run_id')
    // Read any run:* key — the most-recent run is either the active
    // one OR the last one (whichever the user most likely cares about).
    const candidates = new Set()
    if (active_run_id) candidates.add('run:' + active_run_id)
    // Additionally scan all keys for run: prefix so a post-complete run
    // (lock cleared) still surfaces.
    const all = await chrome.storage.local.get(null)
    for (const k of Object.keys(all)) if (k.startsWith('run:')) candidates.add(k)
    let hit = null
    for (const k of candidates) {
      const run = all[k] || (await chrome.storage.local.get(k))[k]
      if (!run) continue
      const runDiskFailed = run.error_code === 'disk_failed'
      const itemDiskFailed = Array.isArray(run.items) && run.items.some(i => i && i.error_code === 'disk_failed')
      if (runDiskFailed || itemDiskFailed) {
        hit = run
        break
      }
    }
    if (!hit) return false
    container.innerHTML = `
      <div class="disk-error-title">Disk error</div>
      <div class="disk-error-body">
        The last download was interrupted by a disk error
        (out of space, permission denied, or the path is gone).
        Change your download folder in
        <a href="chrome://settings/downloads" target="_blank" rel="noopener">Chrome settings</a>
        and try the export again.
      </div>
    `
    container.style.display = 'block'
    return true
  } catch (err) {
    console.warn('[popup] renderDiskErrorIfAny failed', err)
    return false
  }
}

async function render() {
  document.getElementById('version').textContent = `v${EXT_VERSION}`
  const { envato_session_status } = await chrome.storage.local.get('envato_session_status')
  await renderTeRow()
  await renderEnvatoRow(envato_session_status)
  await renderBanner()
  await renderDiskErrorIfAny()
}

// Live updates: if a new JWT arrives OR the cookie watcher updates
// envato_session_status while the popup is open, re-render rather
// than showing stale state.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return
  if ('te:jwt' in changes || 'envato_session_status' in changes) {
    render()
  }
})

render()
