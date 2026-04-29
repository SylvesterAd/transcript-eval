// Reduces a per-chapter strategy LLM output to "Chapter + Beats strategy" — the
// chapter-level strategy block and per-beat strategies. Drops bookkeeping
// fields (matched_reference_chapter, frequency_targets) so the slim text is
// focused on what the LLM is asked NOT to copy.
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
  const slim = {
    strategy: parsed.strategy ?? null,
    beat_strategies: parsed.beat_strategies ?? [],
  }
  return JSON.stringify(slim, null, 2)
}

function tryParse(text) {
  try { return JSON.parse(text) } catch { return null }
}

import db from '../db.js'

// For each prior strategy pipeline, fetch its chapter-N sub-run from
// broll_runs, slim the output, and concatenate into one block prefixed with
// the "do NOT produce a similar strategy" directive. Returns '' when the
// prior list is empty (favorite case). Throws on any missing sub-run so the
// caller fails loudly rather than sending an under-specified prompt.
export async function loadPriorChapterStrategies(priorPids, chapterIndex) {
  if (!priorPids?.length) return ''
  const blocks = []
  for (const pid of priorPids) {
    const subRun = await db.prepare(
      `SELECT br.output_text, br.video_id, v.title FROM broll_runs br
       LEFT JOIN videos v ON v.id = br.video_id
       WHERE br.metadata_json LIKE ?
         AND br.metadata_json LIKE ?
         AND br.metadata_json LIKE '%"isSubRun":true%'
         AND br.status = 'complete'
       ORDER BY br.id DESC LIMIT 1`
    ).get(`%"pipelineId":"${pid}"%`, `%"subIndex":${chapterIndex}%`)
    if (!subRun) {
      throw new Error(`[broll-chain] missing sub-run: pid=${pid} chapter=${chapterIndex}`)
    }
    const slim = slimChapterStrategy(subRun.output_text)
    const label = subRun.title ? `Reference: ${subRun.title}` : pid
    blocks.push(`=== Source: ${label} ===\n${slim}`)
  }
  return `## Prior strategies for this chapter (do NOT produce a similar strategy):\n${blocks.join('\n\n')}`
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
