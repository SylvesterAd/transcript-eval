// Mirrors the backend augmentation logic so the UI can show the full system prompt
// that gets sent to the LLM at runtime.

const SEGMENT_RULES_BASE = `\n\n## SEGMENT BOUNDARY FORMAT
The transcript uses ***** markers and XML-style tags:
- <context> sections = surrounding text for continuity — READ for context awareness but do NOT modify or include in output
- <segment> section (between ***** markers) = ONLY text to process
- Use <context> to maintain natural transitions, avoid abrupt starts/ends, and understand what comes before/after`

const SEGMENT_RULES_STANDARD_ENDING = `
- Output ONLY the processed <segment> content — no markers, no tags, no context text`

const SEGMENT_RULES_JSON_ENDING = `
- Your JSON array must reference ONLY timecodes found within the <segment> section — ignore timecodes in <context>
- Do NOT output markers, tags, or context text — output ONLY the JSON array as specified above`

export const DEFAULT_SEGMENT_RULES = SEGMENT_RULES_BASE + SEGMENT_RULES_STANDARD_ENDING

export function getSegmentRules(outputMode) {
  if (outputMode === 'deletion' || outputMode === 'keep_only' || outputMode === 'identify') {
    return SEGMENT_RULES_BASE + SEGMENT_RULES_JSON_ENDING
  }
  return DEFAULT_SEGMENT_RULES
}

const SEGMENT_RULES_MARKER = '## SEGMENT BOUNDARY FORMAT'
const SEGMENT_RULES_OLD_MARKER = '## Important\nYou receive transcript segments'

export function hasSegmentRules(systemInstruction) {
  const sys = systemInstruction || ''
  return sys.includes(SEGMENT_RULES_MARKER) || sys.includes(SEGMENT_RULES_OLD_MARKER)
}

export function stripSegmentRules(systemInstruction) {
  let sys = systemInstruction || ''
  for (const marker of [SEGMENT_RULES_MARKER, SEGMENT_RULES_OLD_MARKER]) {
    const idx = sys.indexOf(marker)
    if (idx !== -1) {
      let start = idx
      while (start > 0 && sys[start - 1] === '\n') start--
      sys = sys.slice(0, start)
    }
  }
  return sys
}

export function updateSegmentRulesInSystem(systemInstruction, outputMode) {
  const newRules = getSegmentRules(outputMode)
  const sys = systemInstruction || ''

  // Check for new-format marker
  let idx = sys.indexOf(SEGMENT_RULES_MARKER)
  if (idx !== -1) {
    let start = idx
    while (start > 0 && sys[start - 1] === '\n') start--
    return sys.slice(0, start) + newRules
  }

  // Check for old AI-propose format marker
  idx = sys.indexOf(SEGMENT_RULES_OLD_MARKER)
  if (idx !== -1) {
    let start = idx
    while (start > 0 && sys[start - 1] === '\n') start--
    return sys.slice(0, start) + newRules
  }

  return sys + newRules
}

export function previewAugmentedSystem(systemInstruction, outputMode, stageType, identifyPreselect) {
  let result = systemInstruction || ''
  if (outputMode === 'deletion') {
    result += `\n\n## CRITICAL OUTPUT FORMAT — DELETION MODE\nYou are in DELETION mode. Instead of returning a cleaned transcript, you must return a JSON array identifying what to DELETE.\n\nReturn ONLY a valid JSON array like this:\n\`\`\`json\n[\n  {"timecode": "[00:01:23]", "text": "Um, you know,"},\n  {"timecode": "[00:02:45]"},\n  {"timecode": "[00:03:10]", "text": "basically like"}\n]\n\`\`\`\n\nRules:\n- "timecode" (REQUIRED) — the exact timecode from the transcript (e.g., "[00:01:23]")\n- If "text" is OMITTED, the ENTIRE timecoded segment is deleted (timecode + all its text)\n- If "text" is provided, only those exact words are deleted from that segment. The timecode and remaining words are preserved.\n- "text" must be a VERBATIM substring copied from the transcript\n- Return ONLY the JSON array — no commentary, no explanation, no markdown outside the JSON block\n- Be precise — the text must match EXACTLY what appears in the transcript`
  } else if (outputMode === 'keep_only') {
    result += `\n\n## CRITICAL OUTPUT FORMAT — KEEP ONLY MODE\nYou are in KEEP ONLY mode. Instead of returning a cleaned transcript, you must return a JSON array identifying the text to KEEP. Everything else will be removed.\n\nReturn ONLY a valid JSON array like this:\n\`\`\`json\n[\n  {"timecode": "[00:00:15]"},\n  {"timecode": "[00:01:23]", "text": "The main point is that we need to focus"},\n  {"timecode": "[00:05:30]"}\n]\n\`\`\`\n\nRules:\n- Include "timecode" — the exact timecode from the transcript (e.g., "[00:01:23]")\n- Include "text" — the specific text to keep from that segment. Must be a verbatim substring.\n- If "text" is OMITTED, the ENTIRE segment at that timecode is kept (timecode + all its text)\n- Return ONLY the JSON array — no commentary, no explanation, no markdown outside the JSON block\n- All timecodes for kept segments are preserved in the output\n- Be precise — the text must match exactly what appears in the transcript`
  } else if (outputMode === 'identify') {
    result += `\n\n## CRITICAL OUTPUT FORMAT — IDENTIFY MODE\nYou are in IDENTIFY mode. Instead of editing the transcript, classify problematic segments by category.\n\nReturn ONLY a valid JSON array like this:\n\`\`\`json\n[\n  {"timecode": "[00:01:23]", "text": "Um, you know, basically", "category": "repetition"},\n  {"timecode": "[00:02:45]", "category": "lengthy"}\n]\n\`\`\`\n\nCategories (use EXACTLY these values):\n- "repetition" — Same idea repeated, duplicate examples, saying it twice in different words\n- "lengthy" — Over-explanation, too much setup, hedging, unnecessary detail\n- "technical_unclear" — Too technical, vague phrasing, unclear structure, assumed context\n- "irrelevance" — Irrelevant jokes, tangents, tone mismatch, distracting from the point\n\nRules:\n- "timecode" (REQUIRED) — exact timecode from transcript\n- "category" (REQUIRED) — one of the four categories above\n- "text" (OPTIONAL) — the specific problematic text. If omitted, the entire segment is flagged\n- Return ONLY the JSON array — no commentary`
  }
  // Append reason tracking preview if identifyPreselect is enabled
  if (identifyPreselect?.enabled && identifyPreselect?.categories?.length > 0 &&
      (outputMode === 'deletion' || outputMode === 'keep_only')) {
    const allCategories = {
      filler_words: 'Filler words: um, uh, you know, like, basically, I mean',
      false_starts: 'False starts: abandoned sentences, self-corrections, incomplete thoughts',
      repetition: 'Same idea repeated, duplicate examples',
      lengthy: 'Over-explanation, unnecessary detail',
      technical_unclear: 'Too technical, vague phrasing, unclear',
      irrelevance: 'Irrelevant tangents, jokes, off-topic',
    }
    const selected = identifyPreselect.categories
    const focusLabels = selected.map(c => `"${c}"`).join(', ')
    const categoryList = Object.entries(allCategories)
      .map(([key, desc]) => `- "${key}" — ${desc}${selected.includes(key) ? ' ✓ PRIMARY' : ''}`)
      .join('\n')
    result += `\n\n## REASON TRACKING (IDENTIFICATION PRESELECT)\nEvery item in your JSON array MUST also include "category" and "reason" fields.\n\nUpdated format example:\n\`\`\`json\n[\n  {"timecode": "[00:01:23]", "text": "Um, you know,", "category": "filler_words", "reason": "Verbal fillers that add no content"},\n  {"timecode": "[00:02:45]", "category": "false_starts", "reason": "Speaker abandons sentence and restarts"}\n]\n\`\`\`\n\nCategories:\n${categoryList}\n\nPRIMARY FOCUS: ${focusLabels}\n\nAdditional rules:\n- "category" (REQUIRED) — one of the six categories above\n- "reason" (REQUIRED) — brief explanation`
  }

  // Segment rules are now part of the system_instruction field itself (not auto-appended)
  return result
}
