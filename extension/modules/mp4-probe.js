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

export const _internal = { readU32BE, readU64BE, readFourCC, readBoxHeader, iterateBoxes }
