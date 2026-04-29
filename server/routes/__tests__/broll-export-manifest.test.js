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

import { buildManifestFromPlacements, coerceTimingToSeconds } from '../../services/broll.js'

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

  it('skips placement when ALL results are storyblocks', () => {
    const placements = [
      makePlacement({ results: [
        makeResult({ source: 'storyblocks', source_item_id: 'sb_1' }),
        makeResult({ source: 'storyblocks', source_item_id: 'sb_2' }),
      ] }),
      makePlacement({ results: [makeResult({ source: 'pexels', source_item_id: 'px_1' })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source).toBe('pexels')
    expect(out.totals.by_source).toEqual({ pexels: 1 })
  })

  it('falls through to next non-storyblocks result when results[0] is storyblocks', () => {
    // Real-world data: many placements have storyblocks ranked first but
    // pexels/envato available at index 1+. The export should use the first
    // non-storyblocks result rather than dropping the placement entirely.
    const placements = [makePlacement({ results: [
      makeResult({ source: 'storyblocks', source_item_id: 'sb_top' }),
      makeResult({ source: 'storyblocks', source_item_id: 'sb_2' }),
      makeResult({ source: 'pexels', source_item_id: 'px_fallback' }),
      makeResult({ source: 'envato', source_item_id: 'env_4' }),
    ] })]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source).toBe('pexels')
    expect(out.items[0].source_item_id).toBe('px_fallback')
  })

  it('filters storyblocks case-insensitively when scanning fallback', () => {
    const placements = [
      makePlacement({ results: [
        makeResult({ source: 'StoryBlocks', source_item_id: 'sb1' }),
        makeResult({ source: 'STORYBLOCKS', source_item_id: 'sb2' }),
        makeResult({ source: 'pexels', source_item_id: 'p1' }),
      ] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source).toBe('pexels')
    expect(out.items[0].source_item_id).toBe('p1')
  })

  it('persistedSelectedResult takes precedence even over storyblocks-fallback logic', () => {
    // If user explicitly picked something via the editor, honor it. The
    // editor wouldn't let them pick a storyblocks clip in practice.
    const placements = [makePlacement({
      persistedSelectedResult: makeResult({ source: 'envato', source_item_id: 'user_pick' }),
      results: [
        makeResult({ source: 'storyblocks', source_item_id: 'sb_top' }),
        makeResult({ source: 'pexels', source_item_id: 'p_other' }),
      ],
    })]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items[0].source).toBe('envato')
    expect(out.items[0].source_item_id).toBe('user_pick')
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

describe('buildManifestFromPlacements — allowedSources allowlist', () => {
  // The export route pins allowedSources to ['pexels'] while
  // envato/freepik are gated. These tests exercise the allowlist as a
  // pure transform — the route choice is independent.

  it('without allowedSources, picks first non-storyblocks regardless of source', () => {
    const placements = [
      makePlacement({ results: [
        makeResult({ source: 'storyblocks', source_item_id: 'sb1' }),
        makeResult({ source: 'envato',      source_item_id: 'env1' }),
        makeResult({ source: 'pexels',      source_item_id: 'p1' }),
      ] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items[0].source).toBe('envato')
  })

  it('with allowedSources, only picks rank-#1 — no fall-through past out-of-allowlist sources', () => {
    // Storyblocks is at rank 0, pexels is at rank 2. Without an allowlist
    // the legacy fall-through would pick pexels. With the allowlist the
    // editor's displayed pick (results[0] = storyblocks) is out of the
    // allowlist → placement is SKIPPED. This avoids the silent
    // editor/export disagreement that confused users.
    const placements = [
      makePlacement({ results: [
        makeResult({ source: 'storyblocks', source_item_id: 'sb1' }),
        makeResult({ source: 'envato',      source_item_id: 'env1' }),
        makeResult({ source: 'pexels',      source_item_id: 'p1' }),
      ] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null, allowedSources: ['pexels'] })
    expect(out.items).toHaveLength(0)
  })

  it('with allowedSources, picks rank-#1 when it IS in the allowlist', () => {
    const placements = [
      makePlacement({ results: [
        makeResult({ source: 'pexels',      source_item_id: 'p1' }),
        makeResult({ source: 'storyblocks', source_item_id: 'sb1' }),
      ] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null, allowedSources: ['pexels'] })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source_item_id).toBe('p1')
  })

  it('drops placements whose rank-#1 source is out of the allowlist', () => {
    const placements = [
      makePlacement({ results: [
        makeResult({ source: 'storyblocks', source_item_id: 'sb1' }),
        makeResult({ source: 'envato',      source_item_id: 'env1' }),
      ] }),
      makePlacement({ results: [
        makeResult({ source: 'pexels',      source_item_id: 'p1' }),
      ] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null, allowedSources: ['pexels'] })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source_item_id).toBe('p1')
  })

  it('also restricts user-picked results (persistedSelectedResult)', () => {
    // User explicitly clicked an envato clip. With pexels-only allowlist,
    // we still drop the placement — not silently substitute a pexels.
    const placements = [
      makePlacement({
        persistedSelectedResult: makeResult({ source: 'envato', source_item_id: 'env1' }),
        results: [makeResult({ source: 'pexels', source_item_id: 'p1' })],
      }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null, allowedSources: ['pexels'] })
    expect(out.items).toHaveLength(0)
  })

  it('multi-source allowlist accepts every entry', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source: 'pexels',  source_item_id: 'p1' })] }),
      makePlacement({ results: [makeResult({ source: 'envato',  source_item_id: 'e1' })] }),
      makePlacement({ results: [makeResult({ source: 'freepik', source_item_id: 'f1' })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null, allowedSources: ['pexels', 'freepik'] })
    expect(out.items.map(i => i.source).sort()).toEqual(['freepik', 'pexels'])
  })
})

describe('coerceTimingToSeconds', () => {
  it('passes finite numbers through', () => {
    expect(coerceTimingToSeconds(0)).toBe(0)
    expect(coerceTimingToSeconds(42.5)).toBe(42.5)
    expect(coerceTimingToSeconds(-1)).toBe(-1)
  })

  it('parses bracketed timecode strings (LLM plan output format)', () => {
    expect(coerceTimingToSeconds('[00:00:03]')).toBe(3)
    expect(coerceTimingToSeconds('[00:01:30]')).toBe(90)
    expect(coerceTimingToSeconds('[01:02:03]')).toBe(3723)
  })

  it('parses bare hh:mm:ss strings', () => {
    expect(coerceTimingToSeconds('00:00:00')).toBe(0)
    expect(coerceTimingToSeconds('00:00:42')).toBe(42)
    expect(coerceTimingToSeconds('00:01:30')).toBe(90)
  })

  it('parses fractional seconds (commas + dots)', () => {
    expect(coerceTimingToSeconds('00:00:01.5')).toBe(1.5)
    expect(coerceTimingToSeconds('[00:00:01,250]')).toBe(1.25)
  })

  it('returns null for missing / non-parseable values', () => {
    expect(coerceTimingToSeconds(null)).toBe(null)
    expect(coerceTimingToSeconds(undefined)).toBe(null)
    expect(coerceTimingToSeconds(NaN)).toBe(null)
    expect(coerceTimingToSeconds('not a tc')).toBe(null)
    expect(coerceTimingToSeconds({})).toBe(null)
  })
})

describe('buildManifestFromPlacements — timing coercion (regression)', () => {
  // The LLM-emitted plan stores start/end as bracketed timecode
  // strings. Before the fix, these became NaN durations which the
  // web app silently dropped during XML construction. Now they
  // parse to numeric seconds and reach the timeline.
  it('parses bracketed timecode strings from plan output into numeric timing', () => {
    const placements = [
      makePlacement({
        start: '[00:00:03]',
        end: '[00:00:11]',
        results: [makeResult({ source: 'pexels', source_item_id: 'p1' })],
      }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].timeline_start_s).toBe(3)
    expect(out.items[0].timeline_duration_s).toBe(8)
  })

  it('user-edited numeric timing wins over the plan default', () => {
    const placements = [
      makePlacement({
        start: '[00:00:03]',
        end: '[00:00:11]',
        userTimelineStart: 25,
        userTimelineEnd: 27,
        results: [makeResult({ source: 'pexels', source_item_id: 'p1' })],
      }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items[0].timeline_start_s).toBe(25)
    expect(out.items[0].timeline_duration_s).toBe(2)
  })

  it('placement with unparseable timing produces null duration (skipped downstream)', () => {
    const placements = [
      makePlacement({
        start: 'garbage',
        end: 'also garbage',
        results: [makeResult({ source: 'pexels', source_item_id: 'p1' })],
      }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    // Item still emitted (download still useful) but timing is null →
    // buildVariantsPayload will skip it from the XML.
    expect(out.items).toHaveLength(1)
    expect(out.items[0].timeline_start_s).toBe(null)
    expect(out.items[0].timeline_duration_s).toBe(null)
  })
})
