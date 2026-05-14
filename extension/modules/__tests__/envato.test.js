import { describe, it, expect, vi, beforeEach } from 'vitest'

function setupChrome() {
  const onUpdatedListeners = []

  globalThis.chrome = {
    runtime: {
      lastError: undefined,
    },
    tabs: {
      // Callback-style create: resolves immediately, then fires onUpdated
      // with status 'complete' so waitForTabComplete settles.
      create: vi.fn((opts, cb) => {
        const tab = { id: 42, url: opts.url }
        if (typeof cb === 'function') {
          cb(tab)
          // Fire onUpdated 'complete' asynchronously so waitForTabComplete resolves.
          setTimeout(() => {
            for (const fn of onUpdatedListeners) fn(42, { status: 'complete' })
          }, 0)
        }
        return Promise.resolve(tab)
      }),
      remove: vi.fn(async () => {}),
      onUpdated: {
        addListener: vi.fn(fn => { onUpdatedListeners.push(fn) }),
        removeListener: vi.fn(fn => {
          const idx = onUpdatedListeners.indexOf(fn)
          if (idx !== -1) onUpdatedListeners.splice(idx, 1)
        }),
      },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async () => ([{ result: {
        signedUrl: 'https://cdn.envato.com/signed/abc?token=xyz',
        filename: 'movie.mov',
      } }])),
    },
    webNavigation: { onCommitted: { addListener: vi.fn(), removeListener: vi.fn() } },
  }
  vi.resetModules()
}

describe('getSignedDownloadUrl tab lifecycle', () => {
  beforeEach(() => setupChrome())

  it('returns licenseTabId and does NOT close the tab on success', async () => {
    const { getSignedDownloadUrl } = await import('../envato.js')
    const result = await getSignedDownloadUrl('11111111-2222-3333-4444-555555555555')
    expect(result).toMatchObject({
      signedUrl: 'https://cdn.envato.com/signed/abc?token=xyz',
      filename: 'movie.mov',
      licenseTabId: 42,
    })
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })

  it('closes the tab on error path', async () => {
    setupChrome()  // reset
    chrome.scripting.executeScript = vi.fn(async () => {
      throw new Error('synthetic failure')
    })
    const { getSignedDownloadUrl } = await import('../envato.js')
    await expect(
      getSignedDownloadUrl('11111111-2222-3333-4444-555555555555')
    ).rejects.toThrow(/synthetic failure|tab|fetch/)
    expect(chrome.tabs.remove).toHaveBeenCalledWith(42)
  })
})
