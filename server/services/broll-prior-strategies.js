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
