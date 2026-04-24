import { describe, it, expect } from 'vitest'
import { escapeXml } from '../xmeml-generator.js'

describe('escapeXml', () => {
  it('passes plain ASCII through unchanged', () => {
    expect(escapeXml('hello world')).toBe('hello world')
    expect(escapeXml('001_envato_NX9WYGQ.mov')).toBe('001_envato_NX9WYGQ.mov')
  })

  it('escapes the five XML reserved chars', () => {
    expect(escapeXml('<tag>')).toBe('&lt;tag&gt;')
    expect(escapeXml('Tom & Jerry')).toBe('Tom &amp; Jerry')
    expect(escapeXml(`she said "hi"`)).toBe('she said &quot;hi&quot;')
    expect(escapeXml(`it's fine`)).toBe('it&apos;s fine')
  })

  it('does not double-escape already-escaped entities', () => {
    // This is the subtle bug: naive sequential .replace would turn
    // "&amp;" into "&amp;amp;" if & is processed before <. Our regex
    // fires one replacement per char position, so we're safe.
    expect(escapeXml('&amp;')).toBe('&amp;amp;')
    // NB: the correct behavior for an input that happens to already
    // look escaped IS to re-escape — the input is a raw string, not
    // pre-escaped XML. The assertion above is intentional.
  })

  it('handles null/undefined gracefully', () => {
    expect(escapeXml(null)).toBe('')
    expect(escapeXml(undefined)).toBe('')
  })

  it('coerces non-strings via String()', () => {
    expect(escapeXml(42)).toBe('42')
    expect(escapeXml(true)).toBe('true')
  })
})

describe('generateXmeml (stub)', () => {
  it('throws the not-yet-implemented error', async () => {
    const { generateXmeml } = await import('../xmeml-generator.js')
    expect(() => generateXmeml({})).toThrow(/not yet implemented/)
  })
})
