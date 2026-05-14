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

export const _internal = { readU32BE, readU64BE, readFourCC, readBoxHeader, iterateBoxes, validateFtypBrand, ACCEPTED_BRANDS }
