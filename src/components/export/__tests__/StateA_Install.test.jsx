// Smoke test for StateA_Install: the install vs update branch and the
// diagnostics surface. Mirrors StateF_Partial.test.jsx's bare
// createRoot + React.act pattern (no Testing Library dependency).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import StateA_Install from '../StateA_Install.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Pretend we are in Chrome so the non-Chromium branch doesn't fire.
  globalThis.chrome = { runtime: { sendMessage: () => {} } }
})

afterEach(() => {
  act(() => root.unmount())
  document.body.removeChild(container)
  delete globalThis.chrome
})

function render(props) {
  act(() => root.render(createElement(StateA_Install, props)))
}

describe('StateA_Install', () => {
  it('renders install copy when mode=install', () => {
    render({
      variant: 'A',
      mode: 'install',
      ping: { status: 'ok', value: { installed: false, reason: 'not_installed', ext_id: 'abc', latest_version: '0.9.4' } },
    })
    expect(container.textContent).toContain('Install the Export Helper')
    expect(container.textContent).toContain('Install from Chrome Web Store')
    expect(container.textContent).not.toContain('Update the Export Helper')
  })

  it('renders update copy when mode=update with installed version', () => {
    render({
      variant: 'A',
      mode: 'update',
      ping: {
        status: 'ok',
        value: { installed: true, ext_version: '0.9.0', latest_version: '0.9.4', is_outdated: true, ext_id: 'abc' },
      },
    })
    expect(container.textContent).toContain('Update the Export Helper')
    expect(container.textContent).toContain('v0.9.0')
    expect(container.textContent).toContain('v0.9.4')
    expect(container.textContent).not.toContain('Install the Export Helper')
  })

  it('exposes diagnostics with extension id, versions, and probe error', () => {
    render({
      variant: 'A',
      mode: 'install',
      ping: {
        status: 'ok',
        value: { installed: false, reason: 'error', error: 'channel closed', ext_id: 'mmpjeb...', latest_version: '0.9.4' },
      },
    })
    expect(container.textContent).toContain('mmpjeb...')
    expect(container.textContent).toContain('0.9.4')
    expect(container.textContent).toContain('channel closed')
    expect(container.textContent).toContain('Detection details')
  })
})
