import { describe, it, expect } from 'vitest'
import { formatAudience } from '../audience-formatter.js'

describe('formatAudience', () => {
  it('returns empty string for null/undefined/non-object', () => {
    expect(formatAudience(null)).toBe('')
    expect(formatAudience(undefined)).toBe('')
    expect(formatAudience('boomer')).toBe('')
  })

  it('returns empty string when all fields are empty or "any"', () => {
    expect(formatAudience({ age: [], sex: ['any'], ethnicity: ['any'], language: 'English', region: '', notes: '' })).toBe('')
  })

  it('formats a single age group', () => {
    expect(formatAudience({ age: ['boomer'] })).toBe('boomers')
  })

  it('combines age + ethnicity + region into a short phrase', () => {
    const out = formatAudience({ age: ['boomer'], ethnicity: ['white'], region: 'North America' })
    expect(out).toBe('boomers, white, North America')
  })

  it('skips "any" values in multi-select fields', () => {
    const out = formatAudience({ age: ['millennial'], sex: ['any'], ethnicity: ['any'], language: 'English', region: '' })
    expect(out).toBe('millennials')
  })

  it('omits English (default language) and includes non-English', () => {
    expect(formatAudience({ age: ['gen_z'], language: 'English' })).toBe('Gen Z')
    expect(formatAudience({ age: ['gen_z'], language: 'Spanish' })).toBe('Gen Z, Spanish-speaking')
  })

  it('joins multiple selections within a field with slash', () => {
    expect(formatAudience({ age: ['millennial', 'gen_z'] })).toBe('millennials/Gen Z')
    expect(formatAudience({ ethnicity: ['white', 'hispanic'] })).toBe('white/Hispanic')
  })

  it('renders the user example: boomers + white + American region', () => {
    const out = formatAudience({
      age: ['boomer'],
      sex: ['any'],
      ethnicity: ['white'],
      language: 'English',
      region: 'North America',
      notes: 'irrelevant free-text that should be ignored',
    })
    expect(out).toBe('boomers, white, North America')
  })

  it('handles unknown enum values by passing them through', () => {
    expect(formatAudience({ age: ['something_new'] })).toBe('something_new')
  })

  it('drops empty/whitespace region and notes', () => {
    expect(formatAudience({ age: ['gen_x'], region: '   ', notes: '   ' })).toBe('Gen X')
  })

  it('output stays short — never over ~150 chars even with everything filled', () => {
    const out = formatAudience({
      age: ['gen_alpha', 'teens', 'gen_z', 'millennial', 'gen_x', 'boomer'],
      sex: ['female', 'male', 'nonbinary'],
      ethnicity: ['white', 'black', 'hispanic', 'asian_ea', 'asian_sa', 'mena', 'indigenous', 'pacific'],
      language: 'Mandarin',
      region: 'Global',
    })
    expect(out.length).toBeLessThan(200)
  })
})
