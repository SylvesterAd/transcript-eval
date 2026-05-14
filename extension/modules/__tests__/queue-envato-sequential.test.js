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

// ---------------------------------------------------------------------------
// Helpers shared by the slot-hold test
// ---------------------------------------------------------------------------

function makeFullChrome(captureDownloadListener) {
  let downloadListenerRef = null
  const chrome = {
    tabs: {
      create: vi.fn(async () => ({ id: 42 })),
      remove: vi.fn(async () => {}),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async () => ([{ result: { signedUrl: 'https://cdn/x', filename: 'a.mov' } }])),
    },
    downloads: {
      download: vi.fn(async () => 1),
      search: vi.fn(async () => [{ filename: '/tmp/a.mov', bytesReceived: 1000 }]),
      onChanged: {
        addListener: vi.fn((cb) => {
          downloadListenerRef = cb
          if (captureDownloadListener) captureDownloadListener(cb)
        }),
      },
    },
    webNavigation: { onCommitted: { addListener: vi.fn(), removeListener: vi.fn() } },
    storage: {
      local: {
        get: vi.fn(async (key) => {
          // Return empty state so autoResumeIfActiveRun finds nothing
          if (typeof key === 'string') return { [key]: null }
          if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, null]))
          return {}
        }),
        set: vi.fn(async () => {}),
      },
    },
    runtime: { sendMessage: vi.fn(), getManifest: () => ({ version: '1.1.0' }) },
    extension: { isAllowedFileSchemeAccess: vi.fn(async () => false) },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
  }
  return { chrome, getDownloadListener: () => downloadListenerRef }
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

// ---------------------------------------------------------------------------
// E4: Envato licensing slot held through download
// ---------------------------------------------------------------------------

describe('Envato licensing slot held through download', () => {
  it('item N+1 licensing does not start until item N download completes', async () => {
    const licenseStarts = []
    let downloadListener = null

    const { chrome: mockChrome } = makeFullChrome((cb) => { downloadListener = cb })
    // Override download mock to return incrementing IDs
    let nextDownloadId = 1
    mockChrome.downloads.download = vi.fn(async () => nextDownloadId++)
    globalThis.chrome = mockChrome

    vi.doMock('../envato.js', () => ({
      resolveOldIdToNewUuid: vi.fn(async (url) => `uuid-for-${url}`),
      getSignedDownloadUrl: vi.fn(async (uuid) => {
        licenseStarts.push({ at: Date.now(), uuid })
        return { signedUrl: 'https://cdn/x.mov', filename: 'x.mov', licenseTabId: 42 }
      }),
    }))
    // Minimal stubs for all other modules queue.js imports
    vi.doMock('../sources.js', () => ({
      fetchPexelsUrl: vi.fn(async () => ({ url: 'https://pexels/x', expires_at: null })),
      fetchFreepikUrl: vi.fn(async () => ({ url: 'https://freepik/x', expires_at: null })),
    }))
    vi.doMock('../port.js', () => ({ broadcastToPort: vi.fn() }))
    vi.doMock('../auth.js', () => ({
      onEnvatoSessionChange: vi.fn(),
      hasEnvatoSession: vi.fn(async () => true),
    }))
    vi.doMock('../storage.js', () => ({
      saveRunState: vi.fn(async () => {}),
      loadRunState: vi.fn(async () => null),
      deleteRunState: vi.fn(async () => {}),
      getActiveRunId: vi.fn(async () => null),
      setActiveRunId: vi.fn(async () => ({ ok: true })),
      clearActiveRunId: vi.fn(async () => {}),
      markCompleted: vi.fn(async () => {}),
      isDenied: vi.fn(async () => false),
      addToDenyList: vi.fn(async () => {}),
      incrementDailyCount: vi.fn(async () => {}),
      checkDailyCapThreshold: vi.fn(async () => 'ok'),
      getDailyCount: vi.fn(async () => 0),
    }))
    vi.doMock('../telemetry.js', () => ({
      emit: vi.fn(),
      normalizeErrorCode: (e) => (typeof e === 'string' ? e : String(e)),
    }))
    vi.doMock('../config.js', () => ({
      MAX_ENVATO_RESOLVER_CONCURRENCY: 2,
      MAX_ENVATO_LICENSE_CONCURRENCY: 1,
      MAX_DOWNLOAD_CONCURRENCY: 4,
      PROGRESS_COALESCE_MS: 200,
      DOWNLOAD_NETWORK_RETRY_CAP: 3,
      MESSAGE_VERSION: '1.1.0',
      FREEPIK_URL_REFETCH_CAP: 2,
      INTEGRITY_TOLERANCE: 0.05,
      ENVATO_JITTER_MIN_MS: 0,
      ENVATO_JITTER_MAX_MS: 0,
      ENVATO_REAUTH_MAX_WAIT_MS: 5000,
      getCachedConfig: vi.fn(async () => ({ fps_probe_enabled: false })),
    }))
    vi.doMock('../power.js', () => ({
      acquireKeepAwake: vi.fn(async () => {}),
      releaseKeepAwake: vi.fn(async () => {}),
    }))

    vi.resetModules()
    const { startRun } = await import('../queue.js')

    const manifest = [
      {
        source: 'envato',
        source_item_id: 'NX1',
        target_filename: 'a.mov',
        est_size_bytes: 1000,
        envato_item_url: 'https://elements.envato.com/x',
      },
      {
        source: 'envato',
        source_item_id: 'NX2',
        target_filename: 'b.mov',
        est_size_bytes: 1000,
        envato_item_url: 'https://elements.envato.com/y',
      },
    ]

    const runPromise = startRun({
      runId: 'test-run-e4',
      manifest,
      targetFolder: 'tmp',
      _config_check_passed: true,
    })

    // Wait for item 1 to reach licensing (resolving is fast since mock resolveOldIdToNewUuid is instant)
    await new Promise(r => setTimeout(r, 300))
    expect(licenseStarts.length).toBe(1)  // only item 1 has licensed so far

    // Fire chrome.downloads.onChanged complete for item 1 (download_id=1)
    if (downloadListener) {
      downloadListener({
        id: 1,
        state: { current: 'complete', previous: 'in_progress' },
        bytesReceived: { current: 1000 },
      })
    }
    await new Promise(r => setTimeout(r, 300))

    // Now item 2's licensing should have begun
    expect(licenseStarts.length).toBe(2)

    // Clean up — cancel the run to prevent dangling promises
    try {
      const { cancelRun } = await import('../queue.js')
      await cancelRun()
    } catch {}

    vi.doUnmock('../envato.js')
    vi.doUnmock('../sources.js')
    vi.doUnmock('../port.js')
    vi.doUnmock('../auth.js')
    vi.doUnmock('../storage.js')
    vi.doUnmock('../telemetry.js')
    vi.doUnmock('../config.js')
    vi.doUnmock('../power.js')
  }, 8000)
})

// ---------------------------------------------------------------------------
// E5: closeLicenseTab called in chrome.downloads.onChanged terminal branches
// ---------------------------------------------------------------------------

function makeE5Chrome(captureDownloadListener) {
  let downloadListenerRef = null
  let nextDownloadId = 1
  const chrome = {
    tabs: {
      create: vi.fn(async () => ({ id: 42 })),
      remove: vi.fn(async () => {}),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async () => ([{ result: { signedUrl: 'https://cdn/x', filename: 'a.mov' } }])),
    },
    downloads: {
      // Two items → two downloads; use incrementing IDs matching E4 pattern.
      download: vi.fn(async () => nextDownloadId++),
      search: vi.fn(async () => [{ filename: '/tmp/a.mov', bytesReceived: 1000 }]),
      resume: vi.fn(async () => {}),
      onChanged: {
        addListener: vi.fn((cb) => {
          downloadListenerRef = cb
          if (captureDownloadListener) captureDownloadListener(cb)
        }),
      },
    },
    webNavigation: { onCommitted: { addListener: vi.fn(), removeListener: vi.fn() } },
    storage: {
      local: {
        get: vi.fn(async (key) => {
          if (typeof key === 'string') return { [key]: null }
          if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, null]))
          return {}
        }),
        set: vi.fn(async () => {}),
      },
    },
    runtime: { sendMessage: vi.fn(), getManifest: () => ({ version: '1.1.0' }) },
    extension: { isAllowedFileSchemeAccess: vi.fn(async () => false) },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
  }
  return { chrome, getDownloadListener: () => downloadListenerRef }
}

// Two-item manifest: item2's resolver completes first (or concurrently),
// triggering schedule() which picks up item1 for downloading. This ensures
// runDownloader(item1) is called even though runLicenser(item1) is blocked
// awaiting __envato_cycle_settle.
const twoEnvatoManifest = [
  {
    source: 'envato',
    source_item_id: 'NX1',
    target_filename: 'a.mov',
    est_size_bytes: 1000,
    envato_item_url: 'https://elements.envato.com/x',
  },
  {
    source: 'envato',
    source_item_id: 'NX2',
    target_filename: 'b.mov',
    est_size_bytes: 1000,
    envato_item_url: 'https://elements.envato.com/y',
  },
]

describe('Envato license tab close-on-download', () => {
  it('closes the license tab with reason download_complete on successful download', async () => {
    const emitCalls = []
    let downloadListener = null

    const { chrome: mockChrome } = makeE5Chrome((cb) => { downloadListener = cb })
    globalThis.chrome = mockChrome

    vi.doMock('../envato.js', () => ({
      resolveOldIdToNewUuid: vi.fn(async (url) => `uuid-for-${url}`),
      getSignedDownloadUrl: vi.fn(async () => ({
        signedUrl: 'https://cdn/x.mov', filename: 'x.mov', licenseTabId: 42,
      })),
    }))
    vi.doMock('../sources.js', () => ({
      fetchPexelsUrl: vi.fn(async () => ({ url: 'https://pexels/x', expires_at: null })),
      fetchFreepikUrl: vi.fn(async () => ({ url: 'https://freepik/x', expires_at: null })),
    }))
    vi.doMock('../port.js', () => ({ broadcastToPort: vi.fn() }))
    vi.doMock('../auth.js', () => ({
      onEnvatoSessionChange: vi.fn(),
      hasEnvatoSession: vi.fn(async () => true),
    }))
    vi.doMock('../storage.js', () => ({
      saveRunState: vi.fn(async () => {}),
      loadRunState: vi.fn(async () => null),
      deleteRunState: vi.fn(async () => {}),
      getActiveRunId: vi.fn(async () => null),
      setActiveRunId: vi.fn(async () => ({ ok: true })),
      clearActiveRunId: vi.fn(async () => {}),
      markCompleted: vi.fn(async () => {}),
      isDenied: vi.fn(async () => false),
      addToDenyList: vi.fn(async () => {}),
      incrementDailyCount: vi.fn(async () => {}),
      checkDailyCapThreshold: vi.fn(async () => 'ok'),
      getDailyCount: vi.fn(async () => 0),
      shouldAlertForDeny: vi.fn(async () => false),
      markAlertEmitted: vi.fn(async () => {}),
    }))
    vi.doMock('../telemetry.js', () => ({
      emit: (name, meta) => emitCalls.push({ name, meta }),
      normalizeErrorCode: (e) => (typeof e === 'string' ? e : String(e)),
    }))
    vi.doMock('../config.js', () => ({
      MAX_ENVATO_RESOLVER_CONCURRENCY: 2,
      MAX_ENVATO_LICENSE_CONCURRENCY: 1,
      MAX_DOWNLOAD_CONCURRENCY: 4,
      PROGRESS_COALESCE_MS: 200,
      DOWNLOAD_NETWORK_RETRY_CAP: 3,
      MESSAGE_VERSION: '1.1.0',
      FREEPIK_URL_REFETCH_CAP: 2,
      INTEGRITY_TOLERANCE: 0.05,
      ENVATO_JITTER_MIN_MS: 0,
      ENVATO_JITTER_MAX_MS: 0,
      ENVATO_REAUTH_MAX_WAIT_MS: 5000,
      getCachedConfig: vi.fn(async () => ({ fps_probe_enabled: false })),
    }))
    vi.doMock('../power.js', () => ({
      acquireKeepAwake: vi.fn(async () => {}),
      releaseKeepAwake: vi.fn(async () => {}),
    }))

    vi.resetModules()
    const { startRun } = await import('../queue.js')

    startRun({ manifest: twoEnvatoManifest, runId: 'e5-complete', targetFolder: 'tmp', _config_check_passed: true })

    // Wait for item1 licensing + item2 resolving to complete and item1 download to start.
    // item2's resolver completes concurrently, its .finally fires schedule() which picks
    // up item1 for downloading (runLicenser(item1) is blocked awaiting __envato_cycle_settle).
    await new Promise(r => setTimeout(r, 300))
    expect(downloadListener).not.toBeNull()

    // Fire onChanged complete for item1 (download_id=1)
    downloadListener({ id: 1, state: { current: 'complete', previous: 'in_progress' }, bytesReceived: { current: 1000 } })
    await new Promise(r => setTimeout(r, 300))

    // Tab must have been closed with the licenseTabId
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith(42)

    // Telemetry envato_license_tab_closed with reason download_complete
    const closedEvent = emitCalls.find(e => e.name === 'envato_license_tab_closed')
    expect(closedEvent).toBeTruthy()
    expect(closedEvent.meta.reason).toBe('download_complete')

    try { const { cancelRun } = await import('../queue.js'); await cancelRun() } catch {}

    vi.doUnmock('../envato.js')
    vi.doUnmock('../sources.js')
    vi.doUnmock('../port.js')
    vi.doUnmock('../auth.js')
    vi.doUnmock('../storage.js')
    vi.doUnmock('../telemetry.js')
    vi.doUnmock('../config.js')
    vi.doUnmock('../power.js')
  }, 8000)

  it('closes the license tab with reason download_failed on interrupted download', async () => {
    const emitCalls = []
    let downloadListener = null

    const { chrome: mockChrome } = makeE5Chrome((cb) => { downloadListener = cb })
    // For the interrupted test, DOWNLOAD_NETWORK_RETRY_CAP=0 means NETWORK_FAILED is terminal immediately.
    globalThis.chrome = mockChrome

    vi.doMock('../envato.js', () => ({
      resolveOldIdToNewUuid: vi.fn(async (url) => `uuid-for-${url}`),
      getSignedDownloadUrl: vi.fn(async () => ({
        signedUrl: 'https://cdn/x.mov', filename: 'x.mov', licenseTabId: 42,
      })),
    }))
    vi.doMock('../sources.js', () => ({
      fetchPexelsUrl: vi.fn(async () => ({ url: 'https://pexels/x', expires_at: null })),
      fetchFreepikUrl: vi.fn(async () => ({ url: 'https://freepik/x', expires_at: null })),
    }))
    vi.doMock('../port.js', () => ({ broadcastToPort: vi.fn() }))
    vi.doMock('../auth.js', () => ({
      onEnvatoSessionChange: vi.fn(),
      hasEnvatoSession: vi.fn(async () => true),
    }))
    vi.doMock('../storage.js', () => ({
      saveRunState: vi.fn(async () => {}),
      loadRunState: vi.fn(async () => null),
      deleteRunState: vi.fn(async () => {}),
      getActiveRunId: vi.fn(async () => null),
      setActiveRunId: vi.fn(async () => ({ ok: true })),
      clearActiveRunId: vi.fn(async () => {}),
      markCompleted: vi.fn(async () => {}),
      isDenied: vi.fn(async () => false),
      addToDenyList: vi.fn(async () => {}),
      incrementDailyCount: vi.fn(async () => {}),
      checkDailyCapThreshold: vi.fn(async () => 'ok'),
      getDailyCount: vi.fn(async () => 0),
      shouldAlertForDeny: vi.fn(async () => false),
      markAlertEmitted: vi.fn(async () => {}),
    }))
    vi.doMock('../telemetry.js', () => ({
      emit: (name, meta) => emitCalls.push({ name, meta }),
      normalizeErrorCode: (e) => (typeof e === 'string' ? e : String(e)),
    }))
    vi.doMock('../config.js', () => ({
      MAX_ENVATO_RESOLVER_CONCURRENCY: 2,
      MAX_ENVATO_LICENSE_CONCURRENCY: 1,
      MAX_DOWNLOAD_CONCURRENCY: 4,
      PROGRESS_COALESCE_MS: 200,
      DOWNLOAD_NETWORK_RETRY_CAP: 3,
      MESSAGE_VERSION: '1.1.0',
      FREEPIK_URL_REFETCH_CAP: 2,
      INTEGRITY_TOLERANCE: 0.05,
      ENVATO_JITTER_MIN_MS: 0,
      ENVATO_JITTER_MAX_MS: 0,
      ENVATO_REAUTH_MAX_WAIT_MS: 5000,
      getCachedConfig: vi.fn(async () => ({ fps_probe_enabled: false })),
    }))
    // Mock classifier to make NETWORK_FAILED immediately terminal (skip verdict),
    // ensuring handleDownloadInterrupt reaches the terminal phase-check that calls
    // closeLicenseTab. Without this, the real classifier would return a retry verdict
    // (use_chrome_resume), keeping the item in 'downloading' and bypassing the close.
    vi.doMock('../classifier.js', () => ({
      classifyResolverError: vi.fn(() => ({ skip: { error_code: 'test_resolver_error' } })),
      classifyLicenseError: vi.fn(() => ({ skip: { error_code: 'test_license_error' } })),
      classifySourceMintError: vi.fn(() => ({ skip: { error_code: 'test_mint_error' } })),
      classifyDownloadInterrupt: vi.fn(() => ({ skip: { error_code: 'network_failed' } })),
      classifyIntegrityError: vi.fn(() => ({ skip: { error_code: 'integrity_failed' } })),
      parseRetryAfter: vi.fn(() => null),
    }))
    vi.doMock('../power.js', () => ({
      acquireKeepAwake: vi.fn(async () => {}),
      releaseKeepAwake: vi.fn(async () => {}),
    }))

    vi.resetModules()
    const { startRun } = await import('../queue.js')

    startRun({ manifest: twoEnvatoManifest, runId: 'e5-interrupted', targetFolder: 'tmp', _config_check_passed: true })

    // Wait for item1 licensing + item2 resolving to complete and item1 download to start.
    await new Promise(r => setTimeout(r, 300))
    expect(downloadListener).not.toBeNull()

    // Fire onChanged interrupted for item1 (download_id=1). Classifier is mocked to
    // return a terminal skip verdict, so handleDownloadInterrupt reaches the closeLicenseTab call.
    downloadListener({ id: 1, state: { current: 'interrupted', previous: 'in_progress' }, error: { current: 'NETWORK_FAILED' } })
    await new Promise(r => setTimeout(r, 300))

    // Tab must have been closed with the licenseTabId
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith(42)

    // Telemetry envato_license_tab_closed with reason download_failed
    const closedEvent = emitCalls.find(e => e.name === 'envato_license_tab_closed')
    expect(closedEvent).toBeTruthy()
    expect(closedEvent.meta.reason).toBe('download_failed')

    try { const { cancelRun } = await import('../queue.js'); await cancelRun() } catch {}

    vi.doUnmock('../envato.js')
    vi.doUnmock('../sources.js')
    vi.doUnmock('../port.js')
    vi.doUnmock('../auth.js')
    vi.doUnmock('../storage.js')
    vi.doUnmock('../telemetry.js')
    vi.doUnmock('../config.js')
    vi.doUnmock('../classifier.js')
    vi.doUnmock('../power.js')
  }, 8000)
})
