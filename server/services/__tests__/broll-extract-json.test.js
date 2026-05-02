import { describe, it, expect, vi } from 'vitest'

// broll.js → llm-runner.js does a top-level `await db.prepare(...).run()` for
// startup cleanup. Mock prepare to return a chainable stmt that resolves to a
// {changes:0} object; that's enough for module load.
vi.mock('../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      run: vi.fn().mockResolvedValue({ changes: 0 }),
      get: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue([]),
    })),
  },
}))

import { extractJSON } from '../broll.js'

describe('extractJSON — well-formed inputs (regression)', () => {
  it('parses fenced JSON', () => {
    expect(extractJSON('```json\n{"a": 1}\n```')).toEqual({ a: 1 })
  })

  it('parses bare JSON', () => {
    expect(extractJSON('{"a": 1}')).toEqual({ a: 1 })
  })

  it('parses array JSON', () => {
    expect(extractJSON('[1, 2, 3]')).toEqual([1, 2, 3])
  })

  it('returns null for empty input', () => {
    expect(extractJSON('')).toBe(null)
    expect(extractJSON(null)).toBe(null)
  })
})

describe('extractJSON — Gemini Flash JSON tics', () => {
  it('parses JSON with trailing comma before }', () => {
    const text = '```json\n{"a": 1, "b": 2,}\n```'
    expect(extractJSON(text)).toEqual({ a: 1, b: 2 })
  })

  it('parses JSON with trailing comma before ]', () => {
    const text = '```json\n[1, 2, 3,]\n```'
    expect(extractJSON(text)).toEqual([1, 2, 3])
  })

  it('parses nested object with trailing comma (real Flash output shape)', () => {
    // Mirrors the production failure on pipeline 2-409-...-ex408:
    // "emotion": "Practical and strategic, ...",\n    },
    const text = `\`\`\`json
{
  "chapters": [
    {
      "name": "x",
      "emotion": "Practical and strategic, making the viewer think about tax management.",
    }
  ]
}
\`\`\``
    expect(extractJSON(text).chapters[0].emotion).toMatch(/Practical/)
  })

  it('parses JSON with stray duplicate quote on its own line', () => {
    // Mirrors the production failure on pipeline 2-409-...-ex400:
    // "emotion": "Comprehension"\n"\n        },
    const text = `\`\`\`json
{
  "chapters": [
    {
      "emotion": "Comprehension"
"
    }
  ]
}
\`\`\``
    expect(extractJSON(text).chapters[0].emotion).toBe('Comprehension')
  })
})

describe('extractJSON — truly broken inputs', () => {
  it('throws on non-JSON text', () => {
    expect(() => extractJSON('hello world')).toThrow(/No JSON found/)
  })

  it('throws on JSON with unrecoverable structural damage', () => {
    expect(() => extractJSON('{"a": 1, "b":')).toThrow()
  })
})
