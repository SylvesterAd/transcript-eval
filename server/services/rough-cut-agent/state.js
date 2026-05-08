// Per-run mutable state for the rough-cut agent. Pure JS — no DB, no I/O.

let nextCutCounter = 0
let nextUncertainCounter = 0

/**
 * @param {{assembledTranscript: string, wordTimestamps: Array}} init
 */
export function createState({ assembledTranscript, wordTimestamps, acousticFeatures = null }) {
  const cuts = []
  const uncertain = []
  let chapters = null
  let acoustic = acousticFeatures

  return {
    assembledTranscript,
    wordTimestamps,
    cuts,
    uncertain,
    get chapters() { return chapters },
    setChapters(value) { chapters = value },
    get acousticFeatures() { return acoustic },
    setAcousticFeatures(value) { acoustic = value },

    addCut({ start, end, category, reason, confidence, evidence }) {
      const id = `cut_${++nextCutCounter}_${Math.random().toString(36).slice(2, 8)}`
      cuts.push({
        id,
        start,
        end,
        category,
        reason: reason || '',
        confidence: typeof confidence === 'number' ? confidence : 0.5,
        evidence: Array.isArray(evidence) ? evidence : [],
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
