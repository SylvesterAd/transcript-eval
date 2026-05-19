import { describe, it, expect } from 'vitest'
import { _internal } from '../mp4-probe.js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function loadFixture(name) {
  const path = resolve(__dirname, '../../fixtures/mp4', name)
  const bytes = readFileSync(path)
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

describe('mp4-probe byte readers', () => {
  const buf = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
                              0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00]).buffer
  const view = new DataView(buf)

  it('readU32BE returns big-endian uint32', () => {
    expect(_internal.readU32BE(view, 0)).toBe(0x00000010)
    expect(_internal.readU32BE(view, 4)).toBe(0x66747970)  // 'ftyp'
  })

  it('readU64BE returns big-endian uint64 as BigInt', () => {
    expect(_internal.readU64BE(view, 0)).toBe(0x0000001066747970n)
  })

  it('readFourCC returns ASCII fourCC at offset', () => {
    expect(_internal.readFourCC(view, 4)).toBe('ftyp')
    expect(_internal.readFourCC(view, 8)).toBe('mp42')
  })
})

describe('mp4-probe box iteration', () => {
  it('parses a 32-bit-size ftyp box header', () => {
    // size=0x18, type='ftyp', then 16 bytes payload
    const bytes = new Uint8Array(0x18)
    bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], 0)
    const view = new DataView(bytes.buffer)
    const box = _internal.readBoxHeader(view, 0, bytes.length)
    expect(box).toEqual({
      type: 'ftyp', size: 0x18, headerSize: 8, payloadStart: 8, payloadEnd: 0x18,
    })
  })

  it('parses a 64-bit-size extended box header', () => {
    // size=1 marker, type='mdat', then 8-byte extended size
    const bytes = new Uint8Array(32)
    bytes.set([0x00, 0x00, 0x00, 0x01, 0x6d, 0x64, 0x61, 0x74,
               0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20], 0)
    const view = new DataView(bytes.buffer)
    const box = _internal.readBoxHeader(view, 0, bytes.length)
    expect(box).toEqual({
      type: 'mdat', size: 32, headerSize: 16, payloadStart: 16, payloadEnd: 32,
    })
  })

  it('returns null for box header that runs past buffer', () => {
    // size=0x100 but only 8 bytes of buffer
    const bytes = new Uint8Array(8)
    bytes.set([0x00, 0x00, 0x01, 0x00, 0x66, 0x74, 0x79, 0x70], 0)
    const view = new DataView(bytes.buffer)
    expect(_internal.readBoxHeader(view, 0, bytes.length)).toBeNull()
  })

  it('iterateBoxes yields top-level boxes in order', () => {
    const bytes = new Uint8Array(0x20)
    // ftyp size=0x10
    bytes.set([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70], 0)
    // moov size=0x10
    bytes.set([0x00, 0x00, 0x00, 0x10, 0x6d, 0x6f, 0x6f, 0x76], 0x10)
    const view = new DataView(bytes.buffer)
    const types = []
    for (const box of _internal.iterateBoxes(view, 0, bytes.length)) {
      types.push(box.type)
    }
    expect(types).toEqual(['ftyp', 'moov'])
  })
})

describe('mp4-probe brand validation', () => {
  it('accepts known MP4/MOV brands', () => {
    // ftyp size=0x18, major brand 'mp42', minor version 0, compat 'isom'
    const bytes = new Uint8Array(0x18)
    bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
               0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
               0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32], 0)
    const view = new DataView(bytes.buffer)
    const ftyp = _internal.readBoxHeader(view, 0, bytes.length)
    expect(_internal.validateFtypBrand(view, ftyp)).toBe(true)
  })

  it('rejects unknown brand', () => {
    const bytes = new Uint8Array(0x10)
    bytes.set([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
               0x77, 0x65, 0x62, 0x6d, 0x00, 0x00, 0x00, 0x00], 0)  // 'webm'
    const view = new DataView(bytes.buffer)
    const ftyp = _internal.readBoxHeader(view, 0, bytes.length)
    expect(_internal.validateFtypBrand(view, ftyp)).toBe(false)
  })
})

describe('mp4-probe moov + trak traversal', () => {
  it('finds moov in 30_cfr.mp4', () => {
    const view = loadFixture('30_cfr.mp4')
    const moov = _internal.findMoov(view, 0, view.byteLength)
    expect(moov).not.toBeNull()
    expect(moov.type).toBe('moov')
  })

  it('iterates traks and identifies video handler', () => {
    const view = loadFixture('30_cfr.mp4')
    const moov = _internal.findMoov(view, 0, view.byteLength)
    const traks = [..._internal.iterateTraks(view, moov)]
    expect(traks.length).toBeGreaterThanOrEqual(1)
    const handlers = traks.map(t => _internal.readTrakHandler(view, t))
    expect(handlers).toContain('vide')
  })

  it('returns null when moov missing in faststart buffer', () => {
    const bytes = new Uint8Array(0x20)
    bytes.set([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
               0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00], 0)
    bytes.set([0x00, 0x00, 0x00, 0x10, 0x6d, 0x64, 0x61, 0x74], 0x10)
    const view = new DataView(bytes.buffer)
    expect(_internal.findMoov(view, 0, bytes.length)).toBeNull()
  })
})

describe('mp4-probe mdhd + stts frame rate', () => {
  it.each([
    ['30_cfr.mp4',     { frameRate: 30, ntsc: false }],
    ['25_pal.mp4',     { frameRate: 25, ntsc: false }],
    ['50_pal.mp4',     { frameRate: 50, ntsc: false }],
    ['60_cfr.mp4',     { frameRate: 60, ntsc: false }],
    ['2997_ntsc.mov',  { frameRate: 30, ntsc: true  }],
    ['23976_ntsc.mov', { frameRate: 24, ntsc: true  }],
    ['5994_ntsc.mov',  { frameRate: 60, ntsc: true  }],
  ])('reads %s correctly', (filename, expected) => {
    const view = loadFixture(filename)
    const moov = _internal.findMoov(view, 0, view.byteLength)
    const traks = [..._internal.iterateTraks(view, moov)]
    const videoTrak = traks.find(t => _internal.readTrakHandler(view, t) === 'vide')
    const { frameRate, ntsc } = _internal.readVideoTrakRate(view, videoTrak)
    expect(frameRate).toBe(expected.frameRate)
    expect(ntsc).toBe(expected.ntsc)
  })
})

describe('mp4-probe tkhd dimensions + duration', () => {
  it('reads 160x90 dims from 30_cfr.mp4', () => {
    const view = loadFixture('30_cfr.mp4')
    const moov = _internal.findMoov(view, 0, view.byteLength)
    const traks = [..._internal.iterateTraks(view, moov)]
    const videoTrak = traks.find(t => _internal.readTrakHandler(view, t) === 'vide')
    const { width, height } = _internal.readTkhdDims(view, videoTrak)
    expect(width).toBe(160)
    expect(height).toBe(90)
  })

  it('derives ~1.0s duration from 30_cfr.mp4', () => {
    const view = loadFixture('30_cfr.mp4')
    const moov = _internal.findMoov(view, 0, view.byteLength)
    const traks = [..._internal.iterateTraks(view, moov)]
    const videoTrak = traks.find(t => _internal.readTrakHandler(view, t) === 'vide')
    const sec = _internal.readVideoTrakDurationSeconds(view, videoTrak)
    expect(sec).toBeGreaterThan(0.9)
    expect(sec).toBeLessThan(1.1)
  })
})

describe('mp4-probe VFR + bogus value handling', () => {
  // vfr.mp4 fixture is CFR in practice (ffmpeg produced a single stts entry
  // from a constant-color source). Synthetic in-memory stts used to exercise
  // the multi-entry VFR path directly instead.
  it('detects VFR and returns weighted average (synthetic stts)', () => {
    // Build a minimal trak structure with a 2-entry stts:
    //   entry 1: sampleCount=15, sampleDelta=512 (≈58.6 fps at timescale=30000? no, pick 90000/3003 ≈ 30)
    //   entry 2: sampleCount=15, sampleDelta=3004  (very slightly different => >10% spread)
    // We'll call normalizeFrameRate + isVfr logic via readVideoTrakRate by
    // constructing a tiny synthetic DataView that wraps the required boxes.
    // Timescale = 90000 to keep fps in range; deltas 2997 and 3003 => avg~3000 => 30fps,
    // spread = (3003-2997)/3000 = 0.002 (not >10%). Use bigger spread:
    // delta1=1500 (60fps), delta2=4500 (20fps) => avg=3000=>30fps,
    // spread = (4500-1500)/3000 = 1.0 => isVfr=true, frameRate=30
    //
    // Rather than building a full MP4, test normalizeFrameRate + isVfr logic directly
    // by calling readVideoTrakRate with a hand-crafted DataView containing the needed boxes.
    // This requires mdhd + stts, so we build a minimal mdia > mdhd+minf > stbl > stts.

    // Helper to write a big-endian uint32
    function w32(view, off, v) { view.setUint32(off, v, false) }
    function wFCC(view, off, s) {
      for (let i = 0; i < 4; i++) view.setUint8(off + i, s.charCodeAt(i))
    }

    // Build stts box: 8(hdr)+4(ver/flags)+4(count)+2*8(entries) = 36 bytes
    const sttsSize = 36
    const stts = new Uint8Array(sttsSize)
    const sv = new DataView(stts.buffer)
    w32(sv, 0, sttsSize); wFCC(sv, 4, 'stts')
    w32(sv, 8, 0)          // version + flags
    w32(sv, 12, 2)         // entry_count=2
    w32(sv, 16, 15); w32(sv, 20, 1500)   // entry1: 15 samples @ delta 1500
    w32(sv, 24, 15); w32(sv, 28, 4500)   // entry2: 15 samples @ delta 4500

    // Build stbl box containing stts
    const stblPayload = stts
    const stblSize = 8 + stblPayload.byteLength
    const stbl = new Uint8Array(stblSize)
    const stblv = new DataView(stbl.buffer)
    w32(stblv, 0, stblSize); wFCC(stblv, 4, 'stbl')
    stbl.set(stblPayload, 8)

    // Build minf box containing stbl
    const minfSize = 8 + stblSize
    const minf = new Uint8Array(minfSize)
    const minfv = new DataView(minf.buffer)
    w32(minfv, 0, minfSize); wFCC(minfv, 4, 'minf')
    minf.set(stbl, 8)

    // Build mdhd box (version 0): 8(hdr)+4(ver)+4(create)+4(mod)+4(ts)+4(dur) = 32 bytes
    // timescale = 90000
    const mdhdSize = 32
    const mdhd = new Uint8Array(mdhdSize)
    const mdhdv = new DataView(mdhd.buffer)
    w32(mdhdv, 0, mdhdSize); wFCC(mdhdv, 4, 'mdhd')
    w32(mdhdv, 8, 0)         // version 0, flags 0
    w32(mdhdv, 12, 0)        // creation_time
    w32(mdhdv, 16, 0)        // modification_time
    w32(mdhdv, 20, 90000)    // timescale
    w32(mdhdv, 24, 90000)    // duration

    // Build hdlr box (mdia needs hdlr for readTrakHandler) — but we call readVideoTrakRate
    // directly so we only need mdhd and stts accessible. readMdhd + readSttsEntries both
    // go through mdia, so we need mdia containing mdhd + minf.
    const mdiaSize = 8 + mdhdSize + minfSize
    const mdia = new Uint8Array(mdiaSize)
    const mdiav = new DataView(mdia.buffer)
    w32(mdiav, 0, mdiaSize); wFCC(mdiav, 4, 'mdia')
    mdia.set(mdhd, 8)
    mdia.set(minf, 8 + mdhdSize)

    // Build trak box containing mdia
    const trakSize = 8 + mdiaSize
    const trakBytes = new Uint8Array(trakSize)
    const trakv = new DataView(trakBytes.buffer)
    w32(trakv, 0, trakSize); wFCC(trakv, 4, 'trak')
    trakBytes.set(mdia, 8)

    const view = new DataView(trakBytes.buffer)
    // The trak "box" object: payloadStart=8, payloadEnd=trakSize
    const trak = { type: 'trak', size: trakSize, headerSize: 8, payloadStart: 8, payloadEnd: trakSize }
    const result = _internal.readVideoTrakRate(view, trak)
    // avg delta = (15*1500 + 15*4500) / 30 = 90000/30 = 3000 => 90000/3000 = 30 fps
    // spread = (4500-1500)/3000 = 1.0 > 0.1 => isVfr=true
    expect(result.frameRate).toBe(30)
    expect(result.isVfr).toBe(true)
    expect(result.isBogus).toBe(false)
  })

  it('rejects derived rate > 120 as bogus', () => {
    expect(_internal.normalizeFrameRate(10_000_000, 1)).toEqual({
      frameRate: null, ntsc: false, isBogus: true,
    })
  })

  it('rejects sampleDelta=0 (NaN guard)', () => {
    expect(_internal.normalizeFrameRate(30000, 0)).toEqual({
      frameRate: null, ntsc: false, isBogus: true,
    })
  })
})

describe('mp4-probe tmcd embedded timecode', () => {
  it('extracts 18:16:14:04 from with_tmcd.mov', () => {
    const view = loadFixture('with_tmcd.mov')
    const tc = _internal.readEmbeddedTimecode(view, 0, view.byteLength)
    expect(tc).toBe('18:16:14:04')
  })

  it('returns null when no tmcd trak present', () => {
    const view = loadFixture('30_cfr.mp4')
    const tc = _internal.readEmbeddedTimecode(view, 0, view.byteLength)
    expect(tc).toBeNull()
  })
})

describe('mp4-probe framesToTimecodeString (DF/NDF encoding)', () => {
  it('NDF: frame 0 → 00:00:00:00', () => {
    expect(_internal.framesToTimecodeString(0, 30, false)).toBe('00:00:00:00')
  })

  it('NDF: frame 1578580 at 24fps → 18:16:14:04 (matches with_tmcd.mov fixture)', () => {
    expect(_internal.framesToTimecodeString(1578580, 24, false)).toBe('18:16:14:04')
  })

  it('DF: frame 107892 at 30fps → 01:00:00;00 (10-min boundary, item 011)', () => {
    // 29.97 DF: 1 hour = 60min × 30fps − 108 dropped = 107892 actual frames.
    // Pre-fix bug: decoder treated startFrames as NDF counter, producing
    // "00:59:56;12", which parseTimecodeToFrame inverts to 107784 (off by 108).
    expect(_internal.framesToTimecodeString(107892, 30, true)).toBe('01:00:00;00')
  })

  it('DF: frame 1798 at 30fps → 00:00:59;28 (just before minute boundary)', () => {
    expect(_internal.framesToTimecodeString(1798, 30, true)).toBe('00:00:59;28')
  })

  it('DF: frame 1800 at 30fps → 00:01:00;02 (skips ;00 and ;01 at minute 1)', () => {
    expect(_internal.framesToTimecodeString(1800, 30, true)).toBe('00:01:00;02')
  })

  it('DF: frame 17982 at 30fps → 00:10:00;00 (10th minute, no skip)', () => {
    expect(_internal.framesToTimecodeString(17982, 30, true)).toBe('00:10:00;00')
  })
})

import { vi } from 'vitest'

describe('mp4-probe public probeMp4File', () => {
  function makeFetch(fixturePath, totalSize = null) {
    return vi.fn(async (url, opts) => {
      const bytes = readFileSync(resolve(__dirname, '../../fixtures/mp4', fixturePath))
      const size = totalSize ?? bytes.length
      if (opts?.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'content-length': String(size) } })
      }
      const range = opts?.headers?.Range || ''
      const m = range.match(/bytes=(\d+)-(\d+)/)
      if (m) {
        const a = Number(m[1]), b = Math.min(Number(m[2]), bytes.length - 1)
        return new Response(bytes.slice(a, b + 1), { status: 206 })
      }
      return new Response(bytes, { status: 200 })
    })
  }

  it('returns success metadata for a faststart MP4', async () => {
    const { probeMp4File } = await import('../mp4-probe.js')
    const emit = vi.fn()
    const fetchFn = makeFetch('30_cfr.mp4')
    const result = await probeMp4File('file:///fake', { fetchFn, emit })
    expect(result).toMatchObject({
      frameRate: 30, ntsc: false, width: 160, height: 90,
    })
    expect(result.durationSeconds).toBeGreaterThan(0.9)
    expect(emit).toHaveBeenCalledWith('fps_probe_success', expect.any(Object))
  })

  it('handles moov-at-end via tail range', async () => {
    const { probeMp4File } = await import('../mp4-probe.js')
    const emit = vi.fn()
    const fetchFn = makeFetch('moov_at_end.mp4')
    const result = await probeMp4File('file:///fake', { fetchFn, emit, headRangeBytes: 256 })
    expect(result).toMatchObject({ frameRate: 30, ntsc: false })
    expect(emit).toHaveBeenCalledWith('fps_probe_success', expect.any(Object))
  })

  it('returns null + emits unsupported_brand for non-MP4', async () => {
    const { probeMp4File } = await import('../mp4-probe.js')
    const emit = vi.fn()
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([
      0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
      0x77, 0x65, 0x62, 0x6d, 0x00, 0x00, 0x00, 0x00,
    ])))
    const result = await probeMp4File('file:///fake', { fetchFn, emit })
    expect(result).toBeNull()
    expect(emit).toHaveBeenCalledWith('fps_probe_failed_unsupported_brand', expect.any(Object))
  })

  it('returns null + emits timeout when fetch never resolves', async () => {
    const { probeMp4File } = await import('../mp4-probe.js')
    const emit = vi.fn()
    const fetchFn = () => new Promise(() => {})
    const result = await probeMp4File('file:///fake', { fetchFn, emit, timeoutMs: 50 })
    expect(result).toBeNull()
    expect(emit).toHaveBeenCalledWith('fps_probe_timeout', expect.any(Object))
  })

  it('returns null + emits failed_fetch on rejected fetch', async () => {
    const { probeMp4File } = await import('../mp4-probe.js')
    const emit = vi.fn()
    const fetchFn = vi.fn(async () => { throw new Error('OS error') })
    const result = await probeMp4File('file:///fake', { fetchFn, emit })
    expect(result).toBeNull()
    expect(emit).toHaveBeenCalledWith('fps_probe_failed_fetch', expect.objectContaining({
      error: expect.stringContaining('OS error'),
    }))
  })
})
