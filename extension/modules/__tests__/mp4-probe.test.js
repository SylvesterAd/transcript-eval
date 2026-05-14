import { describe, it, expect } from 'vitest'
import { _internal } from '../mp4-probe.js'

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
