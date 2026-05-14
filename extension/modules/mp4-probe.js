// MP4/MOV box parser for the Chrome extension. Reads files via file:// fetch
// and extracts authoritative {frameRate, ntsc, width, height, durationSeconds,
// embeddedTimecode}. Pure functions; no DOM, no chrome.* APIs.
//
// Spec: docs/superpowers/specs/2026-05-13-extension-fps-probe-design.md

function readU32BE(view, offset) {
  return view.getUint32(offset, false)
}

function readU64BE(view, offset) {
  return view.getBigUint64(offset, false)
}

function readFourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

function readBoxHeader(view, offset, bufferEnd) {
  if (offset + 8 > bufferEnd) return null
  let size = readU32BE(view, offset)
  const type = readFourCC(view, offset + 4)
  let headerSize = 8
  if (size === 1) {
    if (offset + 16 > bufferEnd) return null
    const big = readU64BE(view, offset + 8)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null
    size = Number(big)
    headerSize = 16
  } else if (size === 0) {
    // Runs to end-of-buffer
    size = bufferEnd - offset
  }
  if (size < headerSize) return null
  if (offset + size > bufferEnd) return null
  return {
    type,
    size,
    headerSize,
    payloadStart: offset + headerSize,
    payloadEnd: offset + size,
  }
}

function* iterateBoxes(view, start, end) {
  let cursor = start
  while (cursor < end) {
    const box = readBoxHeader(view, cursor, end)
    if (!box) return
    yield box
    cursor = box.payloadEnd
  }
}

const ACCEPTED_BRANDS = new Set([
  'mp4 ', 'isom', 'iso2', 'iso4', 'iso5', 'iso6',
  'qt  ', 'mp41', 'mp42', 'MSNV', 'M4V ', 'M4A ',
  'avc1',
])

function validateFtypBrand(view, ftyp) {
  if (!ftyp || ftyp.type !== 'ftyp') return false
  // Major brand at payload offset 0
  if (ftyp.payloadEnd - ftyp.payloadStart < 8) return false
  const major = readFourCC(view, ftyp.payloadStart)
  if (ACCEPTED_BRANDS.has(major)) return true
  // Walk compatible brands (4 bytes each, starting at payload+8)
  for (let off = ftyp.payloadStart + 8; off + 4 <= ftyp.payloadEnd; off += 4) {
    if (ACCEPTED_BRANDS.has(readFourCC(view, off))) return true
  }
  return false
}

function findMoov(view, start, end) {
  for (const box of iterateBoxes(view, start, end)) {
    if (box.type === 'moov') return box
  }
  return null
}

function findChildBox(view, parent, type) {
  for (const box of iterateBoxes(view, parent.payloadStart, parent.payloadEnd)) {
    if (box.type === type) return box
  }
  return null
}

function* iterateTraks(view, moov) {
  for (const box of iterateBoxes(view, moov.payloadStart, moov.payloadEnd)) {
    if (box.type === 'trak') yield box
  }
}

function readTrakHandler(view, trak) {
  const mdia = findChildBox(view, trak, 'mdia')
  if (!mdia) return null
  const hdlr = findChildBox(view, mdia, 'hdlr')
  if (!hdlr) return null
  // hdlr layout: version(1) + flags(3) + pre_defined(4) + handler_type(4) + ...
  if (hdlr.payloadEnd - hdlr.payloadStart < 12) return null
  return readFourCC(view, hdlr.payloadStart + 8)
}

function readMdhd(view, trak) {
  const mdia = findChildBox(view, trak, 'mdia')
  if (!mdia) return null
  const mdhd = findChildBox(view, mdia, 'mdhd')
  if (!mdhd) return null
  const versionFlags = view.getUint32(mdhd.payloadStart, false)
  const version = (versionFlags >>> 24) & 0xff
  // v0: creation(4) + mod(4) + timescale(4) + duration(4)
  // v1: creation(8) + mod(8) + timescale(4) + duration(8)
  const off = mdhd.payloadStart + 4
  if (version === 0) {
    if (mdhd.payloadEnd - off < 16) return null
    return {
      timescale: readU32BE(view, off + 8),
      duration: readU32BE(view, off + 12),
    }
  }
  if (version === 1) {
    if (mdhd.payloadEnd - off < 28) return null
    const big = readU64BE(view, off + 20)
    return {
      timescale: readU32BE(view, off + 16),
      duration: big > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(big),
    }
  }
  return null
}

function readSttsEntries(view, trak) {
  const mdia = findChildBox(view, trak, 'mdia')
  if (!mdia) return null
  const minf = findChildBox(view, mdia, 'minf')
  if (!minf) return null
  const stbl = findChildBox(view, minf, 'stbl')
  if (!stbl) return null
  const stts = findChildBox(view, stbl, 'stts')
  if (!stts) return null
  // stts: version(1) + flags(3) + entry_count(4) + entries[ count(4) + delta(4) ]
  const off = stts.payloadStart
  if (stts.payloadEnd - off < 8) return null
  const entryCount = readU32BE(view, off + 4)
  const entries = []
  let cursor = off + 8
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 8 > stts.payloadEnd) break
    entries.push({
      sampleCount: readU32BE(view, cursor),
      sampleDelta: readU32BE(view, cursor + 4),
    })
    cursor += 8
  }
  return entries
}

function normalizeFrameRate(timescale, sampleDelta) {
  if (!timescale || !sampleDelta || sampleDelta <= 0) {
    return { frameRate: null, ntsc: false, isBogus: true }
  }
  const exact = timescale / sampleDelta
  if (!Number.isFinite(exact) || exact <= 0 || exact > 120) {
    return { frameRate: null, ntsc: false, isBogus: true }
  }
  const frameRate = Math.round(exact)
  const ntsc = timescale % 1000 === 0
    && sampleDelta === 1001
    && [24000, 30000, 48000, 60000].includes(timescale)
  return { frameRate, ntsc, isBogus: false }
}

function readVideoTrakRate(view, trak) {
  const mdhd = readMdhd(view, trak)
  if (!mdhd || !mdhd.timescale) return { frameRate: null, ntsc: false, isVfr: false }
  const entries = readSttsEntries(view, trak)
  if (!entries || entries.length === 0) return { frameRate: null, ntsc: false, isVfr: false }
  if (entries.length === 1) {
    const norm = normalizeFrameRate(mdhd.timescale, entries[0].sampleDelta)
    return { ...norm, isVfr: false }
  }
  // VFR: weighted average of sampleDelta across all entries
  let totalSamples = 0
  let totalDuration = 0
  let minDelta = Infinity
  let maxDelta = 0
  for (const e of entries) {
    totalSamples += e.sampleCount
    totalDuration += e.sampleCount * e.sampleDelta
    minDelta = Math.min(minDelta, e.sampleDelta)
    maxDelta = Math.max(maxDelta, e.sampleDelta)
  }
  if (totalSamples === 0 || totalDuration === 0) {
    return { frameRate: null, ntsc: false, isVfr: false }
  }
  const avgDelta = totalDuration / totalSamples
  const norm = normalizeFrameRate(mdhd.timescale, avgDelta)
  // VFR if min/max spread > 10% of average
  const isVfr = (maxDelta - minDelta) / avgDelta > 0.1
  return { ...norm, isVfr }
}

function readTkhdDims(view, trak) {
  const tkhd = findChildBox(view, trak, 'tkhd')
  if (!tkhd) return { width: null, height: null }
  // tkhd width/height are 16.16 fixed-point at the LAST 8 bytes of the payload
  const fixedOff = tkhd.payloadEnd - 8
  if (fixedOff < tkhd.payloadStart) return { width: null, height: null }
  const wRaw = readU32BE(view, fixedOff)
  const hRaw = readU32BE(view, fixedOff + 4)
  return { width: wRaw >>> 16, height: hRaw >>> 16 }
}

function readVideoTrakDurationSeconds(view, trak) {
  const mdhd = readMdhd(view, trak)
  if (!mdhd || !mdhd.timescale || !mdhd.duration) return null
  return mdhd.duration / mdhd.timescale
}

function readEmbeddedTimecode(view, start, end) {
  const moov = findMoov(view, start, end)
  if (!moov) return null
  // Find the tmcd-handler trak
  let tmcdTrak = null
  for (const trak of iterateTraks(view, moov)) {
    if (readTrakHandler(view, trak) === 'tmcd') { tmcdTrak = trak; break }
  }
  if (!tmcdTrak) return null
  const mdia = findChildBox(view, tmcdTrak, 'mdia')
  if (!mdia) return null
  const minf = findChildBox(view, mdia, 'minf')
  if (!minf) return null
  const stbl = findChildBox(view, minf, 'stbl')
  if (!stbl) return null
  const stsd = findChildBox(view, stbl, 'stsd')
  if (!stsd) return null
  // stsd: version(1) + flags(3) + entry_count(4) + entries...
  // each entry: size(4) + type(4) + entry-specific data
  // For tmcd: reserved(6) + data_reference_index(2) + reserved(4) +
  //          flags(4) + timescale(4) + frame_duration(4) + number_of_frames(1) + reserved(1)
  if (stsd.payloadEnd - stsd.payloadStart < 16) return null
  const firstEntryStart = stsd.payloadStart + 8
  if (firstEntryStart + 8 > stsd.payloadEnd) return null
  const entrySize = readU32BE(view, firstEntryStart)
  const entryType = readFourCC(view, firstEntryStart + 4)
  if (entryType !== 'tmcd') return null
  if (firstEntryStart + entrySize > stsd.payloadEnd) return null
  const tmcdDataStart = firstEntryStart + 8
  // Skip reserved(6) + dataRefIdx(2) + reserved(4) = 12 bytes
  const flagsOff = tmcdDataStart + 12
  if (flagsOff + 14 > stsd.payloadEnd) return null
  const tmcdFlags = readU32BE(view, flagsOff)
  const tmcdTimescale = readU32BE(view, flagsOff + 4)
  const tmcdFrameDur = readU32BE(view, flagsOff + 8)
  const numFrames = view.getUint8(flagsOff + 12)
  const dropFrame = (tmcdFlags & 0x1) !== 0
  if (!tmcdTimescale || !tmcdFrameDur || !numFrames) return null
  // First sample value (start TC frame number) is stored in mdat at offset
  // given by stco[0] (or co64[0]). Sample is a 32-bit BE integer.
  const stco = findChildBox(view, stbl, 'stco') || findChildBox(view, stbl, 'co64')
  if (!stco) return null
  if (stco.payloadEnd - stco.payloadStart < 12) return null
  const offsetCount = readU32BE(view, stco.payloadStart + 4)
  if (offsetCount === 0) return null
  let sampleOffset
  if (stco.type === 'stco') {
    sampleOffset = readU32BE(view, stco.payloadStart + 8)
  } else {
    const big = readU64BE(view, stco.payloadStart + 8)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null
    sampleOffset = Number(big)
  }
  if (sampleOffset + 4 > end) return null
  const startFrames = readU32BE(view, sampleOffset)
  // Format as HH:MM:SS:FF (or HH:MM:SS;FF for DF)
  const fps = numFrames
  const totalFrames = startFrames
  const ff = totalFrames % fps
  const totalSec = Math.floor(totalFrames / fps)
  const ss = totalSec % 60
  const mm = Math.floor(totalSec / 60) % 60
  const hh = Math.floor(totalSec / 3600)
  const sep = dropFrame ? ';' : ':'
  const pad = n => String(n).padStart(2, '0')
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${sep}${pad(ff)}`
}

export const _internal = { readU32BE, readU64BE, readFourCC, readBoxHeader, iterateBoxes, validateFtypBrand, ACCEPTED_BRANDS, findMoov, findChildBox, iterateTraks, readTrakHandler, readMdhd, readSttsEntries, normalizeFrameRate, readVideoTrakRate, readTkhdDims, readVideoTrakDurationSeconds, readEmbeddedTimecode }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_HEAD_RANGE = 1024 * 1024  // 1 MB
const DEFAULT_TIMEOUT_MS = 10_000

function noopEmit() {}

async function fetchRange(fetchFn, url, start, end) {
  const headers = (start === 0 && end === undefined)
    ? {}
    : { Range: `bytes=${start}-${end ?? ''}` }
  const res = await fetchFn(url, { headers })
  if (!res.ok && res.status !== 206 && res.status !== 200) {
    throw new Error(`fetch returned ${res.status}`)
  }
  const ab = await res.arrayBuffer()
  return new DataView(ab)
}

// Like readBoxHeader but allows the box payload to extend past bufferEnd.
// Used only for top-level type/size detection — never for descending into
// payload bytes that may not be present in the buffer.
function readBoxHeaderPartial(view, offset, bufferEnd) {
  if (offset + 8 > bufferEnd) return null
  let size = readU32BE(view, offset)
  const type = readFourCC(view, offset + 4)
  let headerSize = 8
  if (size === 1) {
    if (offset + 16 > bufferEnd) return null
    const big = readU64BE(view, offset + 8)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null
    size = Number(big)
    headerSize = 16
  } else if (size === 0) {
    // Runs to end-of-file/buffer — treat as "rest of buffer" for advancement
    size = bufferEnd - offset
  }
  if (size < headerSize) return null
  // NOTE: unlike readBoxHeader, we do NOT reject boxes that extend past bufferEnd.
  return {
    type,
    size,
    headerSize,
    payloadStart: offset + headerSize,
    payloadEnd: offset + size,
    truncated: offset + size > bufferEnd,
  }
}

// Scans top-level boxes and returns ftyp, moov, and mdat (the first mdat seen).
// Returns the mdat box object (not just a boolean) so the tail-range path can
// use mdat.payloadEnd to compute the exact moov start offset.
// Uses readBoxHeaderPartial so mdat is detected even when its payload is truncated
// by the Range request — only the 8-byte box header needs to be in the buffer.
function parseFromView(view, startInBuffer, endInBuffer) {
  let ftyp = null
  let moov = null
  let mdat = null
  let cursor = startInBuffer
  while (cursor < endInBuffer) {
    const box = readBoxHeaderPartial(view, cursor, endInBuffer)
    if (!box) break
    if (box.type === 'ftyp' && !box.truncated) {
      // ftyp must be fully readable to validate brand bytes
      ftyp = box
    } else if (box.type === 'moov' && !box.truncated) {
      moov = box
      break
    } else if (box.type === 'mdat') {
      // Record mdat even if truncated — we only need payloadEnd (offset math)
      mdat = box
    }
    if (box.truncated) break  // can't advance past a truncated box
    cursor = box.payloadEnd
  }
  return { ftyp, moov, mdat, sawMdat: mdat !== null }
}

function extractMetadataFromMoov(view, moov, bufferEnd) {
  const traks = [...iterateTraks(view, moov)]
  const videoTrak = traks.find(t => readTrakHandler(view, t) === 'vide')
  if (!videoTrak) return null
  const { frameRate, ntsc, isVfr, isBogus } = readVideoTrakRate(view, videoTrak)
  if (isBogus || frameRate === null) return { bogus: true }
  const { width, height } = readTkhdDims(view, videoTrak)
  const durationSeconds = readVideoTrakDurationSeconds(view, videoTrak)
  const embeddedTimecode = readEmbeddedTimecode(view, 0, bufferEnd)
  return { frameRate, ntsc, width, height, durationSeconds, embeddedTimecode, isVfr }
}

export async function probeMp4File(fileUrl, opts = {}) {
  const {
    fetchFn = globalThis.fetch,
    emit = noopEmit,
    headRangeBytes = DEFAULT_HEAD_RANGE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    // Optional caller-supplied total file size. Lets the moov-at-end
    // fallback skip a `fetch(url, { method: 'HEAD' })` round-trip, which
    // returns no usable content-length for file:// URLs in Chrome MV3 SW
    // (the cause of all "no_total_size" failures observed on real Envato
    // .mov / .mp4 files that have moov at the end). Extension callers pass
    // item.total_bytes from chrome.downloads. HTTP-based tests can omit
    // and rely on the HEAD fallback below.
    totalBytes: callerTotalBytes,
  } = opts

  const probeStart = Date.now()
  const ctx = { url: fileUrl }
  let timer

  try {
    const result = await Promise.race([
      (async () => {
        let view
        try {
          view = await fetchRange(fetchFn, fileUrl, 0, headRangeBytes - 1)
        } catch (err) {
          emit('fps_probe_failed_fetch', { ...ctx, error: String(err?.message || err) })
          return null
        }
        if (view.byteLength < 16) {
          emit('fps_probe_failed_not_mp4', { ...ctx, byteLength: view.byteLength })
          return null
        }
        const { ftyp, moov: moovInHead, mdat: mdatInHead, sawMdat } = parseFromView(view, 0, view.byteLength)
        if (!ftyp || !validateFtypBrand(view, ftyp)) {
          emit('fps_probe_failed_unsupported_brand', { ...ctx })
          return null
        }
        let moov = moovInHead
        let bufferEnd = view.byteLength
        if (!moov && sawMdat) {
          let total = (typeof callerTotalBytes === 'number' && callerTotalBytes > 0)
            ? callerTotalBytes
            : 0
          if (!total) {
            // Best-effort HEAD fallback for callers that didn't supply totalBytes.
            // Chrome MV3 file:// returns no content-length for HEAD, so on the
            // file:// path this falls through to no_total_size — extension callers
            // should always pass totalBytes from item.total_bytes.
            try {
              const headRes = await fetchFn(fileUrl, { method: 'HEAD' })
              total = Number(headRes.headers.get('content-length') || '0')
            } catch {
              emit('fps_probe_failed_moov_not_located', { ...ctx, reason: 'head_failed' })
              return null
            }
          }
          if (!total || total <= headRangeBytes) {
            emit('fps_probe_failed_moov_not_located', { ...ctx, reason: 'no_total_size' })
            return null
          }
          // Use mdat's payloadEnd (from the head fetch parse) as the moov start.
          // mdat's box header was readable since it was within headRangeBytes
          // (otherwise sawMdat would be false). Falls back to a generous window
          // if mdat's end is past total or otherwise unusable.
          let moovStart
          if (mdatInHead && mdatInHead.payloadEnd > 0 && mdatInHead.payloadEnd < total) {
            moovStart = mdatInHead.payloadEnd
          } else {
            // Fall back: fetch a generous window at end (whichever is larger:
            // headRangeBytes, or total/4)
            moovStart = Math.max(0, total - Math.max(headRangeBytes, Math.floor(total / 4)))
          }
          let tailView
          try {
            tailView = await fetchRange(fetchFn, fileUrl, moovStart, total - 1)
          } catch {
            emit('fps_probe_failed_moov_not_located', { ...ctx, reason: 'tail_fetch_failed' })
            return null
          }
          const { moov: moovInTail } = parseFromView(tailView, 0, tailView.byteLength)
          if (!moovInTail) {
            emit('fps_probe_failed_moov_not_located', { ...ctx, reason: 'tail_no_moov' })
            return null
          }
          moov = moovInTail
          view = tailView
          bufferEnd = tailView.byteLength
        }
        if (!moov) {
          emit('fps_probe_failed_moov_not_located', { ...ctx, reason: 'not_in_head' })
          return null
        }
        let meta
        try {
          meta = extractMetadataFromMoov(view, moov, bufferEnd)
        } catch (err) {
          emit('fps_probe_failed_parse_error', { ...ctx, error: String(err?.message || err) })
          return null
        }
        if (!meta) {
          emit('fps_probe_failed_no_timing', ctx)
          return null
        }
        if (meta.bogus) {
          emit('fps_probe_failed_bogus_value', ctx)
          return null
        }
        if (meta.isVfr) {
          emit('fps_probe_vfr_detected', { ...ctx, frameRate: meta.frameRate })
        }
        emit('fps_probe_success', {
          ...ctx,
          frameRate: meta.frameRate,
          ntsc: meta.ntsc,
          width: meta.width,
          height: meta.height,
          durationSeconds: meta.durationSeconds,
          embeddedTimecode: meta.embeddedTimecode,
          elapsedMs: Date.now() - probeStart,
        })
        return {
          frameRate: meta.frameRate,
          ntsc: meta.ntsc,
          width: meta.width,
          height: meta.height,
          durationSeconds: meta.durationSeconds,
          embeddedTimecode: meta.embeddedTimecode,
        }
      })(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          emit('fps_probe_timeout', { ...ctx, timeoutMs })
          resolve(null)
        }, timeoutMs)
      }),
    ])
    return result
  } finally {
    if (timer) clearTimeout(timer)
  }
}
