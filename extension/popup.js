// Popup renders STATE ONLY — reads from chrome.storage.local and
// config.js, never writes. Export progress UI lives on the web app
// export page (per spec § "Popup UI").

import { EXT_VERSION, BACKEND_URL } from './config.js'
import { getJwt } from './modules/auth.js'

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

async function render() {
  document.getElementById('version').textContent = `v${EXT_VERSION}`

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

  // Envato row: Ext.1 has no cookie watcher — static placeholder.
  const rowEn = document.getElementById('row-envato')
  const statusEn = document.getElementById('status-envato')
  const detailEn = document.getElementById('detail-envato')
  setRow(rowEn, statusEn, detailEn, {
    text: 'unknown',
    className: 'muted',
    detail: 'Cookie check added in Ext.4',
  })

  const banner = document.getElementById('banner')
  banner.textContent = connected
    ? 'Ready. Start an export from transcript-eval.'
    : 'Sign in at transcript-eval to continue.'
}

render()
