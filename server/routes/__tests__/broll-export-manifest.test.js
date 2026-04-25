// server/routes/__tests__/broll-export-manifest.test.js
//
// Unit tests for buildManifestFromPlacements — the pure transform that
// turns getBRollEditorData()'s placements into the export-manifest
// shape. Mocks db.js because importing broll.js triggers a top-level
// db import whose side effects exit on missing DATABASE_URL.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    prepare() {
      return {
        async all() { return [] },
        async get() { return null },
        async run() { return { lastInsertRowid: 0 } },
      }
    },
  },
}))

import { buildManifestFromPlacements } from '../../services/broll.js'

function makePlacement(overrides = {}) {
  return {
    chapterIndex: 0,
    placementIndex: 0,
    start: 10,
    end: 14,
    description: 'sunset',
    results: [],
    searchStatus: 'complete',
    ...overrides,
  }
}

function makeResult(overrides = {}) {
  return {
    source: 'envato',
    source_item_id: 'NX9WYGQ',
    envato_item_url: 'https://elements.envato.com/stock-video/foo-NX9WYGQ',
    resolution: { width: 1920, height: 1080 },
    frame_rate: 30,
    duration_seconds: 4,
    est_size_bytes: 150000000,
    rank_score: 0.9,
    rank_method: 'siglip+qwen',
    ...overrides,
  }
}

describe('buildManifestFromPlacements', () => {
  it('returns empty manifest when no placements have results', () => {
    const placements = [makePlacement({ results: [] })]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toEqual([])
    expect(out.totals).toEqual({ count: 0, est_size_bytes: 0, by_source: {} })
  })

  it('emits manifest item from results[0] when no user pick', () => {
    const placements = [makePlacement({ results: [makeResult()] })]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source).toBe('envato')
    expect(out.items[0].source_item_id).toBe('NX9WYGQ')
    expect(out.items[0].envato_item_url).toBe('https://elements.envato.com/stock-video/foo-NX9WYGQ')
    expect(out.items[0].seq).toBe(1)
    expect(out.items[0].timeline_start_s).toBe(10)
    expect(out.items[0].timeline_duration_s).toBe(4)
  })

  it('prefers persistedSelectedResult over results[0]', () => {
    const top = makeResult({ source_item_id: 'TOP_ID' })
    const picked = makeResult({ source: 'pexels', source_item_id: '12345' })
    const placements = [makePlacement({ results: [top], persistedSelectedResult: picked })]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items[0].source).toBe('pexels')
    expect(out.items[0].source_item_id).toBe('12345')
  })

  it('filters out storyblocks results entirely', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source: 'storyblocks', source_item_id: 'sb_1' })] }),
      makePlacement({ results: [makeResult({ source: 'pexels', source_item_id: 'px_1' })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source).toBe('pexels')
    expect(out.totals.by_source).toEqual({ pexels: 1 })
  })

  it('filters storyblocks case-insensitively (StoryBlocks, STORYBLOCKS)', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source: 'StoryBlocks' })] }),
      makePlacement({ results: [makeResult({ source: 'STORYBLOCKS' })] }),
      makePlacement({ results: [makeResult({ source: 'pexels', source_item_id: 'p1' })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source).toBe('pexels')
  })

  it('emits target_filename with seq prefix + source + safe id', () => {
    const placements = [makePlacement({ results: [makeResult({ source: 'pexels', source_item_id: '12345/extra' })] })]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items[0].target_filename).toBe('001_pexels_12345_extra.mp4')
  })

  it('uses .mov for envato, .mp4 for pexels and freepik', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source: 'envato', source_item_id: 'e1' })] }),
      makePlacement({ results: [makeResult({ source: 'pexels', source_item_id: 'p1' })] }),
      makePlacement({ results: [makeResult({ source: 'freepik', source_item_id: 'f1' })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items[0].target_filename).toMatch(/\.mov$/)
    expect(out.items[1].target_filename).toMatch(/\.mp4$/)
    expect(out.items[2].target_filename).toMatch(/\.mp4$/)
  })

  it('skips placements where pick has no source_item_id', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source_item_id: null })] }),
      makePlacement({ results: [makeResult({ source_item_id: '' })] }),
      makePlacement({ results: [makeResult({ source_item_id: 'ok' })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source_item_id).toBe('ok')
  })

  it('uses userTimelineStart/userTimelineEnd when present (editor user-edit override)', () => {
    const placements = [makePlacement({
      start: 10, end: 14,
      userTimelineStart: 25, userTimelineEnd: 27,
      results: [makeResult()],
    })]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items[0].timeline_start_s).toBe(25)
    expect(out.items[0].timeline_duration_s).toBe(2)
  })

  it('falls back to estimated size when est_size_bytes missing', () => {
    const placements = [makePlacement({
      results: [makeResult({ est_size_bytes: undefined, duration_seconds: 4 })],
    })]
    const out = buildManifestFromPlacements(placements, { variant: null })
    // 4 * 25 * 1024 * 1024 = 104857600
    expect(out.items[0].est_size_bytes).toBe(104857600)
  })

  it('totals aggregates count, bytes, and by_source', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source: 'envato',  source_item_id: 'e1', est_size_bytes: 100 })] }),
      makePlacement({ results: [makeResult({ source: 'pexels',  source_item_id: 'p1', est_size_bytes: 200 })] }),
      makePlacement({ results: [makeResult({ source: 'freepik', source_item_id: 'f1', est_size_bytes: 300 })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.totals).toEqual({ count: 3, est_size_bytes: 600, by_source: { envato: 1, pexels: 1, freepik: 1 } })
  })

  it('filters by variant when variant_label present (queue data path)', () => {
    const placements = [
      makePlacement({ variant_label: 'A', results: [makeResult({ source_item_id: 'a1' })] }),
      makePlacement({ variant_label: 'B', results: [makeResult({ source_item_id: 'b1' })] }),
      makePlacement({ variant_label: 'A', results: [makeResult({ source_item_id: 'a2' })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: 'A' })
    expect(out.items).toHaveLength(2)
    expect(out.items.map(i => i.source_item_id)).toEqual(['a1', 'a2'])
  })

  it('treats "Variant A" and "A" as equivalent for variant filter', () => {
    const placements = [
      makePlacement({ variant_label: 'Variant A', results: [makeResult({ source_item_id: 'a1' })] }),
      makePlacement({ variant_label: 'A',         results: [makeResult({ source_item_id: 'a2' })] }),
      makePlacement({ variant_label: 'B',         results: [makeResult({ source_item_id: 'b1' })] }),
    ]
    const out1 = buildManifestFromPlacements(placements, { variant: 'A' })
    const out2 = buildManifestFromPlacements(placements, { variant: 'Variant A' })
    expect(out1.items.map(i => i.source_item_id).sort()).toEqual(['a1', 'a2'])
    expect(out2.items.map(i => i.source_item_id).sort()).toEqual(['a1', 'a2'])
  })

  it('returns all items when variant requested but no placements have variant_label (legacy data)', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source_item_id: 'x1' })] }),
      makePlacement({ results: [makeResult({ source: 'pexels', source_item_id: 'x2' })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: 'A' })
    // Legacy data has no variant_label — pass through rather than filter to zero.
    expect(out.items).toHaveLength(2)
  })

  it('skips placements marked hidden via editor edits', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source_item_id: 'keep' })] }),
      makePlacement({ results: [makeResult({ source_item_id: 'drop' })], hidden: true }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source_item_id).toBe('keep')
  })

  it('seq is 1-based and gap-free across kept placements', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source: 'storyblocks', source_item_id: 's1' })] }),  // skipped
      makePlacement({ results: [makeResult({ source: 'pexels',      source_item_id: 'p1' })] }),  // seq 1
      makePlacement({ results: [] }),                                                              // skipped
      makePlacement({ results: [makeResult({ source: 'envato',      source_item_id: 'e1' })] }),  // seq 2
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items.map(i => i.seq)).toEqual([1, 2])
  })
})
