import { describe, it, expect, vi, beforeEach } from 'vitest'

function setupChrome() {
  globalThis.chrome = {
    tabs: { remove: vi.fn(async () => {}) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn() } },
    runtime: { sendMessage: vi.fn(), getManifest: () => ({ version: '1.1.0' }) },
    downloads: { onChanged: { addListener: vi.fn() } },
  }
  vi.resetModules()
}

describe('closeLicenseTab helper', () => {
  beforeEach(() => setupChrome())

  it('closes the tab and emits envato_license_tab_closed with the given reason', async () => {
    const emitCalls = []
    vi.doMock('../telemetry.js', () => ({
      emit: (name, meta) => emitCalls.push({ name, meta }),
      normalizeErrorCode: (e) => e,
    }))
    const { closeLicenseTab } = await import('../queue.js')
    const item = { seq: 3, source_item_id: 'NXG_AB', license_tab_id: 99 }
    await closeLicenseTab(item, 'download_complete')
    expect(chrome.tabs.remove).toHaveBeenCalledWith(99)
    expect(item.license_tab_id).toBeNull()
    const closedEvents = emitCalls.filter(e => e.name === 'envato_license_tab_closed')
    expect(closedEvents.length).toBe(1)
    expect(closedEvents[0].meta).toMatchObject({ seq: 3, source_item_id: 'NXG_AB', reason: 'download_complete' })
    vi.doUnmock('../telemetry.js')
  })

  it('is a no-op when item has no license_tab_id', async () => {
    const emitCalls = []
    vi.doMock('../telemetry.js', () => ({
      emit: (name, meta) => emitCalls.push({ name, meta }),
      normalizeErrorCode: (e) => e,
    }))
    const { closeLicenseTab } = await import('../queue.js')
    const item = { seq: 3, source_item_id: 'NXG_AB', license_tab_id: null }
    await closeLicenseTab(item, 'download_complete')
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
    expect(emitCalls.filter(e => e.name === 'envato_license_tab_closed').length).toBe(0)
    vi.doUnmock('../telemetry.js')
  })

  it('swallows chrome.tabs.remove errors (tab already closed)', async () => {
    chrome.tabs.remove = vi.fn(async () => { throw new Error('No tab with id') })
    vi.doMock('../telemetry.js', () => ({
      emit: vi.fn(),
      normalizeErrorCode: (e) => e,
    }))
    const { closeLicenseTab } = await import('../queue.js')
    const item = { seq: 3, source_item_id: 'NXG_AB', license_tab_id: 99 }
    await expect(closeLicenseTab(item, 'download_complete')).resolves.toBeUndefined()
    expect(item.license_tab_id).toBeNull()
    vi.doUnmock('../telemetry.js')
  })
})
