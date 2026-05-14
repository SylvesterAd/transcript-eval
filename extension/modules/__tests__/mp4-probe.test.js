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
