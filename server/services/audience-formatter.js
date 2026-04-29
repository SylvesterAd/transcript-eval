// Formats a video group's audience JSON into a short, prompt-friendly phrase.
// Goal: a few adjectives the planner can use to contextualize people in b-roll
// (e.g. "older white American couple") — never a paragraph, never raw JSON.

const AGE_LABELS = {
  gen_alpha: 'Gen Alpha',
  teens: 'teens',
  gen_z: 'Gen Z',
  millennial: 'millennials',
  gen_x: 'Gen X',
  boomer: 'boomers',
}

const ETHNICITY_LABELS = {
  white: 'white',
  black: 'Black',
  hispanic: 'Hispanic',
  asian_ea: 'East Asian',
  asian_sa: 'South Asian',
  mena: 'MENA',
  indigenous: 'Indigenous',
  pacific: 'Pacific Islander',
}

const SEX_LABELS = {
  female: 'female',
  male: 'male',
  nonbinary: 'nonbinary',
}

function pickMulti(list, labels) {
  if (!Array.isArray(list)) return ''
  const cleaned = list.filter(v => v && v !== 'any')
  if (!cleaned.length) return ''
  return cleaned.map(v => labels[v] || v).join('/')
}

export function formatAudience(audience) {
  if (!audience || typeof audience !== 'object') return ''
  const parts = []

  const age = pickMulti(audience.age, AGE_LABELS)
  if (age) parts.push(age)

  const sex = pickMulti(audience.sex, SEX_LABELS)
  if (sex) parts.push(sex)

  const ethnicity = pickMulti(audience.ethnicity, ETHNICITY_LABELS)
  if (ethnicity) parts.push(ethnicity)

  const region = (audience.region || '').trim()
  if (region) parts.push(region)

  const language = (audience.language || '').trim()
  if (language && language !== 'English') parts.push(`${language}-speaking`)

  return parts.join(', ')
}
