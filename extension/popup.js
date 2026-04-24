// Popup renders STATE ONLY — reads from chrome.storage.local and
// config.js, never writes. Export progress UI lives on the web app
// export page (per spec § "Popup UI").

import { EXT_VERSION, BACKEND_URL } from './config.js'
import { getJwt, hasEnvatoSession } from './modules/auth.js'
import { buildBundle } from './modules/diagnostics.js'

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

// Ext.8 — "Export diagnostic bundle" button. Kicks off
// diagnostics.buildBundle() (which invokes chrome.downloads.download
// with saveAs: true) and surfaces the result in the row-detail text.
async function renderDiagRow() {
  const btn = document.getElementById('btn-build-bundle')
  const detail = document.getElementById('detail-diag')
  if (!btn || btn._wired) return
  btn._wired = true
  btn.addEventListener('click', async () => {
    btn.disabled = true
    detail.textContent = 'Building bundle…'
    try {
      const res = await buildBundle()
      detail.textContent = res?.ok
        ? `Saved ${res.filename} (${Math.round((res.bytes || 0) / 1024)} KB)`
        : 'Bundle failed'
    } catch (err) {
      detail.textContent = `Error: ${String(err?.message || err)}`
    } finally {
      btn.disabled = false
    }
  })
}

// Ext.8 — "Send diagnostic events" toggle. The persisted flag is
// `telemetry_opt_out`; the checkbox represents "send" (checked = ON
// = NOT opted-out) — we invert when reading/writing. Flipping to
// off clears the persisted queue (Q3 recommendation).
async function renderOptOutRow() {
  const chk = document.getElementById('chk-optout-send')
  const detail = document.getElementById('detail-optout')
  if (!chk) return
  const { telemetry_opt_out } = await chrome.storage.local.get('telemetry_opt_out')
  chk.checked = telemetry_opt_out !== true   // "Send" = ON when not opted-out
  if (chk._wired) return
  chk._wired = true
  chk.addEventListener('change', async () => {
    const newOptOut = !chk.checked  // unchecked → opted-out
    await chrome.storage.local.set({ telemetry_opt_out: newOptOut })
    if (newOptOut) {
      await chrome.storage.local.remove('telemetry_queue')
      detail.textContent = 'Opt-out on — events will not be sent. Queue cleared.'
    } else {
      detail.textContent = 'Opt-out off — events will be sent.'
    }
  })
}

async function render() {
  document.getElementById('version').textContent = `v${EXT_VERSION}`
  const { envato_session_status } = await chrome.storage.local.get('envato_session_status')
  await renderTeRow()
  await renderEnvatoRow(envato_session_status)
  await renderBanner()
  await renderDiskErrorIfAny()
  await renderDiagRow()
  await renderOptOutRow()
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
