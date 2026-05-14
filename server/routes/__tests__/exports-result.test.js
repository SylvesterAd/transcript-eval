// server/routes/__tests__/exports-result.test.js
//
// Regression guard: probed-style metadata (sourceFrameRate, ntsc,
// embeddedTimecode, sourceDurationSeconds) in variant placements flows
// correctly into the XMEML generator output.
//
// Pattern: tests generateXmeml directly — same approach as
// export-xml-postcut.test.js's integration-style describe block. No
// HTTP layer, no real DB required. The generator is the locus of the
// regression: if it ignores sourceFrameRate or ntsc from placements,
// the emitted <rate> tags will be wrong. db.js is mocked because
// export-xml.js (which re-exports generateXmeml's collaborators)
// imports db.js at module load time and would otherwise call
// process.exit(1) when DATABASE_URL is missing in the test environment.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    prepare: () => ({
      run: () => ({ changes: 0 }),
      get: () => null,
      all: () => [],
    }),
    pool: {
      connect: () => Promise.resolve({
        query: async () => ({ rows: [] }),
        release: () => {},
      }),
    },
  },
}))

import { generateXmeml } from '../../services/xmeml-generator.js'

// Synthetic placements that mirror what result_json.variants[].placements
// looks like after Task 18 merges probed_metadata into the manifest shape.
// The route's pickAroll() strips the aroll placement from this list and
// passes it separately; here we pass each placement directly to
// generateXmeml in the role it occupies after that split.

const AROLL_PLACEMENT = {
  seq: 0,
  source: 'aroll',
  sourceItemId: 'aroll',
  filename: 'aroll.mp4',
  timelineStart: 0,
  timelineDuration: 10,
  sourceFrameRate: 29.97,
  ntsc: true,
  width: 1920,
  height: 1080,
  sourceDurationSeconds: 10,
  embeddedTimecode: '01:00:00:00',
}

const BROLL_25FPS = {
  seq: 1,
  source: 'envato',
  sourceItemId: 'NXG1',
  filename: 'broll1.mov',
  timelineStart: 2,
  timelineDuration: 3,
  sourceFrameRate: 25,
  ntsc: false,
  width: 1920,
  height: 1080,
  sourceDurationSeconds: 12,
  embeddedTimecode: null,
}

// pickAroll shape (mirrors the route's pickAroll() output).
const AROLL_ARG = {
  filename: AROLL_PLACEMENT.filename,
  frameRate: AROLL_PLACEMENT.sourceFrameRate,   // route maps sourceFrameRate → frameRate
  ntsc: AROLL_PLACEMENT.ntsc,
  width: AROLL_PLACEMENT.width,
  height: AROLL_PLACEMENT.height,
  sourceDurationSeconds: AROLL_PLACEMENT.sourceDurationSeconds,
}

describe('generateXmeml carries probed FPS/NTSC into XMEML output', () => {
  it('emits <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate> for a 25 fps b-roll placement', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [BROLL_25FPS],
    })
    // The b-roll <file> block must carry the source file's probed rate.
    expect(xml).toContain('<rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>')
  })

  it('emits <rate><timebase>29.97</timebase><ntsc>TRUE</ntsc></rate> for a probed-29.97 b-roll placement', () => {
    // sourceFrameRate=29.97 is passed through verbatim as the timebase value;
    // the generator does NOT round it to 30. The ntsc=TRUE flag is set because
    // p.ntsc===true. DaVinci requires the fractional timebase + ntsc flag to
    // validate fractional-rate source files correctly.
    const broll2997 = {
      seq: 2,
      source: 'pexels',
      sourceItemId: 'PX42',
      filename: 'broll2.mp4',
      timelineStart: 5,
      timelineDuration: 4,
      sourceFrameRate: 29.97,
      ntsc: true,
      width: 1920,
      height: 1080,
      sourceDurationSeconds: 15,
      embeddedTimecode: null,
    }
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [broll2997],
    })
    expect(xml).toContain('<rate><timebase>29.97</timebase><ntsc>TRUE</ntsc></rate>')
  })

  it('emits A-roll <file id="file-aroll"> inner <rate> at timebase=29.97 + NTSC=TRUE for probed 29.97', () => {
    // The aroll arg (built by the route's pickAroll) carries
    //   frameRate=29.97 → passed verbatim as the timebase value
    //   ntsc=true       → emitted as TRUE
    // The A-roll <file> block appears in V1 track; the timecode + rate
    // tags there must match the probed source metadata.
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [],   // no b-roll; testing aroll block only
      aroll: AROLL_ARG,
    })
    // <file id="file-aroll"> must carry the probed rate verbatim.
    expect(xml).toMatch(
      /<file id="file-aroll">[\s\S]*?<rate><timebase>29\.97<\/timebase><ntsc>TRUE<\/ntsc><\/rate>/
    )
  })

  it('emits both A-roll and B-roll probed rates correctly in a combined export', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [BROLL_25FPS],
      aroll: AROLL_ARG,
    })
    // A-roll inner <file> rate: 29.97 verbatim + TRUE
    expect(xml).toMatch(
      /<file id="file-aroll">[\s\S]*?<rate><timebase>29\.97<\/timebase><ntsc>TRUE<\/ntsc><\/rate>/
    )
    // B-roll <file> rate: 25/FALSE
    const brollFileBlock = xml.match(/<file id="file-envato[^>]*">[\s\S]*?<\/file>/)
    expect(brollFileBlock).not.toBeNull()
    expect(brollFileBlock[0]).toContain('<rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>')
  })

  it('B-roll <file><duration> reflects probed sourceDurationSeconds * sourceFrameRate', () => {
    // sourceDurationSeconds=12, sourceFrameRate=25 → 12 * 25 = 300 frames.
    // generator emits this as <duration>300</duration> inside the <file> block.
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [BROLL_25FPS],
    })
    const brollFileBlock = xml.match(/<file id="file-envato[^>]*">[\s\S]*?<\/file>/)
    expect(brollFileBlock).not.toBeNull()
    expect(brollFileBlock[0]).toContain('<duration>300</duration>')
  })

  it('B-roll <file><timecode><string> carries embeddedTimecode when present', () => {
    const brollWithTc = {
      seq: 3,
      source: 'envato',
      sourceItemId: 'TC001',
      filename: 'broll_tc.mov',
      timelineStart: 0,
      timelineDuration: 2,
      sourceFrameRate: 24,
      ntsc: false,
      width: 1920,
      height: 1080,
      sourceDurationSeconds: 10,
      embeddedTimecode: '18:16:14:04',
    }
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [brollWithTc],
    })
    expect(xml).toContain('<string>18:16:14:04</string>')
    // Non-drop-frame TC → displayformat NDF.
    expect(xml).toContain('<displayformat>NDF</displayformat>')
  })

  it('B-roll with embeddedTimecode=null falls back to 00:00:00:00 and sourceFrameRate governs rate', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [BROLL_25FPS],  // embeddedTimecode: null
    })
    expect(xml).toContain('<string>00:00:00:00</string>')
    // Rate should still be 25 fps (not the fallback 30).
    expect(xml).toContain('<rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>')
  })
})
