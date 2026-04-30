// Reduces a per-chapter strategy LLM output to its per-beat array. Drops the
// chapter-level `strategy` block (commonalities/broll sources/etc.) and any
// other top-level bookkeeping (matched_reference_chapter, frequency_targets)
// because the chain only cares about per-beat strategy_points being unique.
export function slimChapterStrategy(rawJsonText) {
  if (!rawJsonText || typeof rawJsonText !== 'string') return ''
  let parsed = tryParse(rawJsonText)
  if (!parsed) {
    const fence = rawJsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) parsed = tryParse(fence[1].trim())
  }
  if (!parsed) {
    const m = rawJsonText.match(/\{[\s\S]*\}/)
    if (m) parsed = tryParse(m[0])
  }
  if (!parsed || typeof parsed !== 'object') return rawJsonText.slice(0, 2000)
  const slim = { beat_strategies: parsed.beat_strategies ?? [] }
  return JSON.stringify(slim, null, 2)
}

function tryParse(text) {
  try { return JSON.parse(text) } catch { return null }
}

import db from '../db.js'

const ORDINAL_WORDS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth']
function ordinalStrategyLabel(idx) {
  return ORDINAL_WORDS[idx] ? `${ORDINAL_WORDS[idx]} Strategy` : `Strategy ${idx + 1}`
}

// For each prior strategy pipeline, fetch its chapter-N sub-run from
// broll_runs and aggregate per-beat strategy_points keyed by beat_name.
//
// canonicalBeatNames (optional but recommended) controls beat ordering:
// the caller passes the chapter's canonical beat list (chSplit.beats_raw),
// and any beat present in priors but NOT in this list is dropped (defensive
// against LLM-hallucinated beat names). When omitted, falls back to the
// union of beat names from priors in first-appearance order.
//
// Output: directive-headed text containing a JSON array of beats, each with
// beat_name, beat_emotion, and prior_strategy_points = [{source, strategy_points}].
//
// Source label format: `First Strategy (from "<title>")`, `Second Strategy ...`.
//
// Returns '' when the prior list is empty (favorite case) or when no prior
// produced any non-empty strategy_points for any canonical beat. Throws on
// any missing sub-run so the caller fails loudly rather than sending an
// under-specified prompt.
export async function loadPriorChapterStrategies(priorPids, chapterIndex, canonicalBeatNames = []) {
  if (!priorPids?.length) return ''

  // 1. Load each prior's chapter-N sub-run + parse its beat_strategies
  const priors = []
  for (const pid of priorPids) {
    const subRun = await db.prepare(
      `SELECT br.output_text, br.video_id, v.title FROM broll_runs br
       LEFT JOIN videos v ON v.id = br.video_id
       WHERE br.metadata_json LIKE ?
         AND br.metadata_json LIKE ?
         AND br.metadata_json LIKE '%"isSubRun":true%'
         AND br.status = 'complete'
       ORDER BY br.id DESC LIMIT 1`
    ).get(`%"pipelineId":"${pid}"%`, `%"subIndex":${chapterIndex},%`)
    if (!subRun) {
      throw new Error(`[broll-chain] missing sub-run: pid=${pid} chapter=${chapterIndex}`)
    }
    let parsed = tryParse(subRun.output_text)
    if (!parsed) {
      const fence = subRun.output_text?.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (fence) parsed = tryParse(fence[1].trim())
    }
    if (!parsed) {
      const m = subRun.output_text?.match(/\{[\s\S]*\}/)
      if (m) parsed = tryParse(m[0])
    }
    priors.push({
      title: subRun.title || null,
      beats: Array.isArray(parsed?.beat_strategies) ? parsed.beat_strategies : [],
    })
  }

  // 2. Decide beat ordering: canonical list if given, else union of priors'
  //    beat names in first-appearance order.
  let orderedBeatNames = canonicalBeatNames
  if (!orderedBeatNames?.length) {
    const seen = new Set()
    orderedBeatNames = []
    for (const prior of priors) {
      for (const b of prior.beats) {
        if (b?.beat_name && !seen.has(b.beat_name)) {
          seen.add(b.beat_name)
          orderedBeatNames.push(b.beat_name)
        }
      }
    }
  }

  // 3. Build per-beat aggregation
  const result = []
  for (const beatName of orderedBeatNames) {
    let beatEmotion = null
    const priorList = []
    for (let i = 0; i < priors.length; i++) {
      const prior = priors[i]
      const beatEntry = prior.beats.find(b => b?.beat_name === beatName)
      if (!beatEntry) continue
      if (!beatEmotion && beatEntry.beat_emotion) beatEmotion = beatEntry.beat_emotion
      const sp = Array.isArray(beatEntry.strategy_points) ? beatEntry.strategy_points : []
      if (sp.length === 0) continue // skip silently per design
      const titlePart = prior.title ? ` (from "${prior.title}")` : ''
      priorList.push({
        source: `${ordinalStrategyLabel(i)}${titlePart}`,
        strategy_points: sp,
      })
    }
    if (priorList.length === 0) continue // every prior was empty/missing for this beat
    result.push({
      beat_name: beatName,
      beat_emotion: beatEmotion,
      prior_strategy_points: priorList,
    })
  }

  if (result.length === 0) return ''

  return `## Prior strategies for this chapter (do NOT repeat strategy_points):\n${JSON.stringify(result, null, 2)}`
}

export function assertNoSelfReference(pipelineId, priorPids) {
  if (priorPids?.includes(pipelineId)) {
    throw new Error(`[broll-chain] self-reference: ${pipelineId} cannot have itself as prior`)
  }
}

export async function assertPriorsComplete(priorPids) {
  if (!priorPids?.length) return
  for (const pid of priorPids) {
    const ok = await db.prepare(
      `SELECT 1 FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' LIMIT 1`
    ).get(`%"pipelineId":"${pid}"%`)
    if (!ok) throw new Error(`[broll-chain] prior pipeline not complete: ${pid}`)
  }
}
