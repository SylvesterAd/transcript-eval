import { computeDiff, extractDeletions, calculateSimilarity, checkTimecodePreservation, checkPausePreservation } from './diff-engine.js'
import { classifyDeletions, reasonStats } from './classifier.js'

/**
 * Weighted scoring model:
 * - 50% Human-vs-Current overall match
 * - 20% Correct removals
 * - 15% Avoidance of wrong removals
 * - 10% Formatting/timecode preservation
 * - 5%  Pause marker preservation
 *
 * Also computes reason-aware sub-scores.
 */

const WEIGHTS = {
  humanMatch: 0.50,
  correctRemovals: 0.20,
  avoidWrongRemovals: 0.15,
  timecodePreservation: 0.10,
  pausePreservation: 0.05
}

/**
 * Score a workflow output against reference transcripts.
 *
 * @param {string} raw - Raw transcript
 * @param {string} humanEdited - Human-edited transcript
 * @param {string} current - Workflow output to evaluate
 * @returns {object} Full scoring breakdown
 */
export function scoreOutput(raw, humanEdited, current) {
  // 1. Human-vs-Current similarity (the most important metric)
  const humanVsCurrent = calculateSimilarity(humanEdited, current)
  const humanMatchScore = humanVsCurrent.similarityPercent / 100

  // 2. Correct removals — what human deleted that workflow also deleted
  const rawVsHumanDiff = computeDiff(raw, humanEdited)
  const humanDeletions = extractDeletions(rawVsHumanDiff)

  const rawVsCurrentDiff = computeDiff(raw, current)
  const workflowDeletions = extractDeletions(rawVsCurrentDiff)

  const { correctRate, wrongRate, missedRate, correctDeletions, wrongDeletions, missedDeletions } =
    compareDeletions(humanDeletions, workflowDeletions)

  // 3. Timecode and pause preservation (relative to raw)
  const timecodes = checkTimecodePreservation(raw, current)
  const pauses = checkPausePreservation(raw, current)

  // Weighted total score
  const totalScore = round(
    WEIGHTS.humanMatch * humanMatchScore +
    WEIGHTS.correctRemovals * correctRate +
    WEIGHTS.avoidWrongRemovals * (1 - wrongRate) +
    WEIGHTS.timecodePreservation * timecodes.score +
    WEIGHTS.pausePreservation * pauses.score
  )

  // Reason-aware sub-scores
  const classifiedHumanDeletions = classifyDeletions(humanDeletions)
  const classifiedWorkflowDeletions = classifyDeletions(workflowDeletions)
  const classifiedCorrect = classifyDeletions(correctDeletions)
  const classifiedWrong = classifyDeletions(wrongDeletions)
  const classifiedMissed = classifyDeletions(missedDeletions)

  const reasonScores = computeReasonScores(
    classifiedHumanDeletions,
    classifiedWorkflowDeletions,
    classifiedCorrect,
    classifiedMissed,
    classifiedWrong
  )

  return {
    totalScore,
    breakdown: {
      humanMatch: round(humanMatchScore),
      correctRemovals: round(correctRate),
      avoidWrongRemovals: round(1 - wrongRate),
      timecodePreservation: timecodes.score,
      pausePreservation: pauses.score
    },
    weights: WEIGHTS,
    similarity: {
      humanVsCurrent: humanVsCurrent,
      rawVsHuman: calculateSimilarity(raw, humanEdited),
      rawVsCurrent: calculateSimilarity(raw, current)
    },
    deletions: {
      humanTotal: humanDeletions.length,
      workflowTotal: workflowDeletions.length,
      correct: correctDeletions.length,
      wrong: wrongDeletions.length,
      missed: missedDeletions.length,
      correctRate: round(correctRate),
      wrongRate: round(wrongRate),
      missedRate: round(missedRate)
    },
    reasonScores,
    reasonStats: {
      humanDeletions: reasonStats(classifiedHumanDeletions),
      workflowDeletions: reasonStats(classifiedWorkflowDeletions),
      correct: reasonStats(classifiedCorrect),
      wrong: reasonStats(classifiedWrong),
      missed: reasonStats(classifiedMissed)
    },
    timecodes,
    pauses
  }
}

/**
 * Compare two sets of deletions to find correct, wrong, and missed.
 * Uses fuzzy text matching since exact positions may differ.
 */
function compareDeletions(humanDeletions, workflowDeletions) {
  const correctDeletions = []
  const missedDeletions = []
  const matchedWorkflow = new Set()

  // For each human deletion, check if workflow also deleted similar text
  for (const hd of humanDeletions) {
    const hdNorm = normalize(hd.text)
    let found = false

    for (let i = 0; i < workflowDeletions.length; i++) {
      if (matchedWorkflow.has(i)) continue
      const wdNorm = normalize(workflowDeletions[i].text)

      if (isSimilarDeletion(hdNorm, wdNorm)) {
        correctDeletions.push(hd)
        matchedWorkflow.add(i)
        found = true
        break
      }
    }

    if (!found) {
      missedDeletions.push(hd)
    }
  }

  // Wrong deletions = workflow deletions not matched to any human deletion
  const wrongDeletions = workflowDeletions.filter((_, i) => !matchedWorkflow.has(i))

  const totalHuman = humanDeletions.length || 1
  const totalWorkflow = workflowDeletions.length || 1

  return {
    correctRate: correctDeletions.length / totalHuman,
    wrongRate: wrongDeletions.length / totalWorkflow,
    missedRate: missedDeletions.length / totalHuman,
    correctDeletions,
    wrongDeletions,
    missedDeletions
  }
}

/**
 * Check if two deleted text spans are "similar enough" to count as the same deletion.
 */
function isSimilarDeletion(a, b) {
  if (a === b) return true
  if (!a || !b) return false

  // One contains the other
  if (a.includes(b) || b.includes(a)) return true

  // Word overlap
  const wordsA = new Set(a.split(/\s+/))
  const wordsB = new Set(b.split(/\s+/))
  const intersection = [...wordsA].filter(w => wordsB.has(w))
  const union = new Set([...wordsA, ...wordsB])

  const jaccard = intersection.length / union.size
  return jaccard >= 0.5
}

function normalize(text) {
  return (text || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Compute per-reason accuracy scores.
 */
function computeReasonScores(humanDels, workflowDels, correctDels, missedDels, wrongDels) {
  const reasons = ['filler_word', 'false_start', 'meta_commentary']
  const scores = {}

  for (const reason of reasons) {
    const humanCount = humanDels.filter(d => d.reason === reason).length
    const correctCount = correctDels.filter(d => d.reason === reason).length
    const missedCount = missedDels.filter(d => d.reason === reason).length
    const wrongCount = wrongDels.filter(d => d.reason === reason).length

    scores[reason] = {
      accuracy: humanCount > 0 ? round(correctCount / humanCount) : null,
      correct: correctCount,
      missed: missedCount,
      wrong: wrongCount,
      humanTotal: humanCount
    }
  }

  return scores
}

function round(n) {
  return Math.round(n * 1000) / 1000
}
