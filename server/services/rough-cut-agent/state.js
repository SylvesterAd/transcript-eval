// Per-run mutable state for the rough-cut agent. Pure JS — no DB, no I/O.

import { computeBaselines } from './boundaries.js'

let nextCutCounter = 0
let nextUncertainCounter = 0

// Strength derivation rules. Counts the *distinct* evidence types present in
// support.items[] and classifies overall support quality.
//   strong: text + (audio_event OR acoustic_boundary OR cluster) AND ≥3 types
//   medium: text + 1 other type, OR ≥2 types
//   weak:   1 type, OR no support
const TYPE_TEXT     = 'transcript_quote'
const TYPE_AUDIO    = 'audio_event'
const TYPE_ACOUSTIC = 'acoustic_boundary'
const TYPE_CLUSTER  = 'cluster'
const TYPE_LEGACY   = 'legacy'           // unmigrated legacy strings

function deriveStrength(items) {
  const types = new Set(items.map(it => it.type))
  const hasText = types.has(TYPE_TEXT)
  const hasAudio = types.has(TYPE_AUDIO)
  const hasAcoustic = types.has(TYPE_ACOUSTIC)
  const hasCluster = types.has(TYPE_CLUSTER)
  if (hasText && (hasAudio || hasAcoustic || hasCluster) && types.size >= 3) return 'strong'
  if (types.size >= 2) return 'medium'
  return 'weak'
}

function normalizeSupport({ support, evidence, confidence }) {
  // New path: explicit support.items[].
  if (support && Array.isArray(support.items)) {
    const items = support.items.filter(it => it && typeof it.type === 'string')
    return { items, strength: deriveStrength(items), evidence: items }
  }
  // Legacy path: evidence strings + confidence number.
  if (Array.isArray(evidence) && evidence.length > 0) {
    const items = evidence.map(s => ({ type: TYPE_LEGACY, text: String(s) }))
    // Map old confidence to a strength bucket so back-compat callers still
    // produce something usable.
    let strength = 'weak'
    if (typeof confidence === 'number') {
      if (confidence >= 0.85) strength = 'strong'
      else if (confidence >= 0.65) strength = 'medium'
    }
    return { items, strength, evidence: items }
  }
  return { items: [], strength: 'weak', evidence: [] }
}

/**
 * @param {{assembledTranscript: string, wordTimestamps: Array}} init
 */
export function createState({ assembledTranscript, wordTimestamps, acousticFeatures = null }) {
  const cuts = []
  const uncertain = []
  let chapters = null
  let acoustic = acousticFeatures
  let baselines = null

  return {
    assembledTranscript,
    wordTimestamps,
    cuts,
    uncertain,
    get chapters() { return chapters },
    setChapters(value) { chapters = value },
    get acousticFeatures() { return acoustic },
    setAcousticFeatures(value) { acoustic = value; baselines = null },
    // Lazy per-video baselines. Computed once on first access.
    get acousticBaselines() {
      if (baselines) return baselines
      if (!acoustic?.frames?.length) return null
      baselines = computeBaselines(acoustic.frames, wordTimestamps || [])
      return baselines
    },

    addCut(input) {
      const { start, end, category, reason } = input
      // Normalize: prefer typed support.items[]; fall back to legacy evidence
      // strings + confidence number with strength derived from the latter.
      const { items, strength, evidence } = normalizeSupport(input)
      const id = `cut_${++nextCutCounter}_${Math.random().toString(36).slice(2, 8)}`
      cuts.push({
        id,
        start,
        end,
        category,
        reason: reason || '',
        strength,             // 'strong' | 'medium' | 'weak'
        evidence,             // typed items[] for new path; legacy strings preserved as untyped
      })
      return id
    },

    removeCut(id) {
      const idx = cuts.findIndex(c => c.id === id)
      if (idx === -1) return false
      cuts.splice(idx, 1)
      return true
    },

    adjustCut(id, { start, end }) {
      const cut = cuts.find(c => c.id === id)
      if (!cut) return false
      if (typeof start === 'number') cut.start = start
      if (typeof end === 'number') cut.end = end
      return true
    },

    addUncertain({ start, end, reason }) {
      const id = `uncertain_${++nextUncertainCounter}_${Math.random().toString(36).slice(2, 8)}`
      uncertain.push({ id, start, end, reason: reason || '' })
      return id
    },
  }
}
