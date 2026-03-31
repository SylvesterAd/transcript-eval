// Format instruction templates — injected into system_instruction when output_mode is set.
// Editable by the user after injection. Used as-is at runtime.

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
const FORMAT_MARKER = '## CRITICAL OUTPUT FORMAT'

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

// ── Format instruction templates (with centisecond timecode examples) ──

const FORMAT_TEMPLATES = {
  deletion: `

## CRITICAL OUTPUT FORMAT — DELETION MODE
You are in DELETION mode. Instead of returning a cleaned transcript, you must return a JSON array identifying what to DELETE.

Return ONLY a valid JSON array like this:
\`\`\`json
[
  {"timecode": "[00:01:23]", "text": "Um, you know,"},
  {"timecode": "[00:02:45]"},
  {"timecode": "[00:02:45.80]"},
  {"timecode": "[00:03:10.50]", "text": "basically like"}
]
\`\`\`

Rules:
- "timecode" (REQUIRED) — the EXACT timecode copied from the transcript, including any sub-second precision (e.g., "[00:01:23]" or "[00:01:23.50]")
- If "text" is OMITTED, the ENTIRE timecoded segment is deleted (timecode + all its text)
- If "text" is provided, only those exact words are deleted from that segment. The timecode and remaining words are preserved.
- "text" must be a VERBATIM substring copied from the transcript
- Return ONLY the JSON array — no commentary, no explanation, no markdown outside the JSON block
- Be precise — timecodes and text must match EXACTLY what appears in the transcript`,

  keep_only: `

## CRITICAL OUTPUT FORMAT — KEEP ONLY MODE
You are in KEEP ONLY mode. Instead of returning a cleaned transcript, you must return a JSON array identifying the text to KEEP. Everything else will be removed.

Each item references a timecode from the transcript. You can keep an entire timecoded segment or specific text within it.

Return ONLY a valid JSON array like this:
\`\`\`json
[
  {"timecode": "[00:00:15]"},
  {"timecode": "[00:01:23.50]", "text": "The main point is that we need to focus"},
  {"timecode": "[00:05:30]"}
]
\`\`\`

Rules:
- "timecode" — the EXACT timecode copied from the transcript, including any sub-second precision (e.g., "[00:01:23]" or "[00:01:23.50]")
- "text" — the specific text to keep from that segment. Must be a verbatim substring.
- If "text" is OMITTED, the ENTIRE segment at that timecode is kept (timecode + all its text)
- Return ONLY the JSON array — no commentary, no explanation, no markdown outside the JSON block
- All timecodes for kept segments are preserved in the output
- Be precise — timecodes and text must match exactly what appears in the transcript`,

  identify: `

## CRITICAL OUTPUT FORMAT — IDENTIFY MODE
You are in IDENTIFY mode. Instead of editing the transcript, flag problematic segments.

Return ONLY a valid JSON array like this:
\`\`\`json
[
  {"timecode": "[00:01:23]", "text": "Um, you know, basically"},
  {"timecode": "[00:02:45.80]"}
]
\`\`\`

Rules:
- "timecode" (REQUIRED) — the EXACT timecode copied from the transcript, including any sub-second precision (e.g., "[00:01:23]" or "[00:01:23.50]")
- "text" (OPTIONAL) — the specific problematic text. If omitted, the entire segment is flagged
- Return ONLY the JSON array — no commentary`,
}

const FOCUS_MARKER = '## FOCUS'

const CATEGORY_DESCRIPTIONS = {
  filler_words: 'filler words (um, uh, you know, like, basically, I mean)',
  false_starts: 'false starts (abandoned sentences, self-corrections, incomplete thoughts)',
  meta_commentary: 'meta commentary (talking about the recording process, directing crew, discussing takes, behind-the-scenes remarks not meant for the final video)',
  repetition: 'repetition (same idea repeated, duplicate examples)',
  lengthy: 'lengthy sections (over-explanation, unnecessary detail)',
  technical_unclear: 'too technical or unclear (vague phrasing, assumed context)',
  irrelevance: 'irrelevance (tangents, jokes, off-topic)',
}

/**
 * Strip the format section from a system instruction.
 * Removes everything from "## CRITICAL OUTPUT FORMAT" to end (or to next known section).
 */
function stripFormatSection(sys) {
  const idx = sys.indexOf(FORMAT_MARKER)
  if (idx === -1) return sys
  let start = idx
  while (start > 0 && sys[start - 1] === '\n') start--
  return sys.slice(0, start)
}

/**
 * Strip the FOCUS section from a system instruction.
 */
function stripFocusSection(sys) {
  const idx = sys.indexOf(FOCUS_MARKER)
  if (idx === -1) return sys
  let start = idx
  while (start > 0 && sys[start - 1] === '\n') start--
  // Find end: next ## heading or end of string
  const afterMarker = sys.slice(idx)
  const nextHeading = afterMarker.slice(1).search(/\n## /)
  if (nextHeading !== -1) {
    return sys.slice(0, start) + sys.slice(idx + 1 + nextHeading)
  }
  return sys.slice(0, start)
}

/**
 * Inject or replace the format section in a system instruction.
 * Called when output_mode changes.
 */
export function updateFormatInSystem(systemInstruction, outputMode) {
  const sys = stripFormatSection(systemInstruction || '')
  if (!outputMode || outputMode === 'passthrough' || !FORMAT_TEMPLATES[outputMode]) {
    return sys
  }
  return sys + FORMAT_TEMPLATES[outputMode]
}

/**
 * Inject or replace the FOCUS section in a system instruction.
 * Called when identifyPreselect categories change.
 */
export function updateFocusInSystem(systemInstruction, identifyPreselect) {
  const sys = stripFocusSection(systemInstruction || '')
  if (!identifyPreselect?.enabled || !identifyPreselect?.categories?.length) {
    return sys
  }
  const focusDescriptions = identifyPreselect.categories
    .map(c => CATEGORY_DESCRIPTIONS[c] || c)
    .join('; ')
  return sys + `\n\n## FOCUS\nFocus on finding: ${focusDescriptions}.\nDo NOT include "category" or "reason" fields — just "timecode" and optionally "text".`
}

/**
 * Preview: show the full system instruction as-is (no runtime additions).
 * Format + focus sections are already embedded in the saved instruction.
 */
export function previewAugmentedSystem(systemInstruction) {
  return systemInstruction || '(empty)'
}
