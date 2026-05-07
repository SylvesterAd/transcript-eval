// server/services/rough-cut-agent/tools.js
//
// 12 tool implementations + Anthropic JSON schemas. dispatchTool is the
// single entry point used by the agent loop and tests.

import { deriveSilences } from './silences.js'
import { findInterruptionClusters } from './clusters.js'

// ── JSON Schemas (Anthropic Messages API tool format) ─────────────────

export const TOOL_SCHEMAS = [
  {
    name: 'get_transcript',
    description: 'Read the verbatim transcript with word timestamps. Optionally limited to a time scope.',
    input_schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'object',
          properties: { start: { type: 'number' }, end: { type: 'number' } },
        },
      },
    },
  },
  {
    name: 'get_chapters',
    description: 'Get chapter breakdown of the video. Cached after first call.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_silences',
    description: 'Find silence gaps between words longer than min_duration seconds.',
    input_schema: {
      type: 'object',
      properties: {
        min_duration: { type: 'number', description: 'Minimum gap in seconds (default 0.75).' },
        scope: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } },
      },
    },
  },
  {
    name: 'get_audio_events',
    description: 'Get audio_event tokens (laughter, keyboard, music, etc.) from the transcript.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } },
        types: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'search_transcript',
    description: 'Regex search over the assembled transcript. Returns matching lines with timecodes.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        scope: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'find_interruption_clusters',
    description: 'Detect interruption clusters around audio_event tokens. Returns whole spans, not fragments.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } },
        max_gap_sec: { type: 'number' },
      },
    },
  },
  {
    name: 'propose_cut',
    description: 'Propose a cut. Each cut requires category, reason, confidence, evidence.',
    input_schema: {
      type: 'object',
      properties: {
        start: { type: 'number' },
        end: { type: 'number' },
        category: { type: 'string', enum: [
          'meta_commentary', 'false_start', 'filler_word', 'retake',
          'silence', 'tangent', 'discourse_marker', 'custom',
        ] },
        reason: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        evidence: { type: 'array', items: { type: 'string' } },
      },
      required: ['start', 'end', 'category', 'reason', 'confidence', 'evidence'],
    },
  },
  {
    name: 'mark_uncertain',
    description: 'Flag a span for human review without cutting it.',
    input_schema: {
      type: 'object',
      properties: {
        start: { type: 'number' },
        end: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['start', 'end', 'reason'],
    },
  },
  {
    name: 'remove_cut',
    description: 'Undo a previously-proposed cut by id.',
    input_schema: {
      type: 'object',
      properties: { cut_id: { type: 'string' } },
      required: ['cut_id'],
    },
  },
  {
    name: 'adjust_cut',
    description: 'Modify start/end of an existing cut.',
    input_schema: {
      type: 'object',
      properties: {
        cut_id: { type: 'string' },
        new_start: { type: 'number' },
        new_end: { type: 'number' },
      },
      required: ['cut_id'],
    },
  },
  {
    name: 'preview_diff',
    description: 'Show the transcript as it would appear with current cuts applied. Optionally limited to a time scope (recommended when working chunk-by-chunk).',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } },
      },
    },
  },
  {
    name: 'commit_chunk',
    description: 'Lock in cuts for a chunk. Emit your prediction of what the chunk should READ LIKE after your cuts apply. The system applies the cuts, computes the actual surviving text, and reports match_percent + mismatches. If the score is low, your cuts and your understanding of them disagree — re-read preview_diff and fix before advancing.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } },
        expected_text_after_cuts: { type: 'string', description: '1–3 sentences predicting what survives in the chunk after your cuts apply.' },
      },
      required: ['scope', 'expected_text_after_cuts'],
    },
  },
  {
    name: 'finish',
    description: 'Terminate the agent loop. Persists current cuts.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
  },
]

// ── Implementations ───────────────────────────────────────────────────

function inScope(start, end, scope) {
  if (!scope) return true
  return end >= scope.start && start <= scope.end
}

async function get_transcript(params, state) {
  const { scope } = params || {}
  // pause_before is computed on the FULL timeline (not the filtered window)
  // so the discourse-marker discriminator stays intact even at chunk edges.
  const all = state.wordTimestamps
  const enriched = all.map((w, i) => {
    const pause_before = i === 0 ? 0 : Math.max(0, w.start - all[i - 1].end)
    return { ...w, pause_before }
  })
  const words = scope ? enriched.filter(w => inScope(w.start, w.end, scope)) : enriched
  return { words }
}

async function get_chapters(params, state, ctx) {
  if (state.chapters) return { chapters: state.chapters }
  if (!ctx?.chaptersFetcher) {
    return { chapters: [], note: 'chaptersFetcher not configured for this run' }
  }
  const chapters = await ctx.chaptersFetcher({
    transcript: state.assembledTranscript,
    words: state.wordTimestamps,
  })
  state.setChapters(chapters)
  return { chapters }
}

async function get_silences(params, state) {
  const minDuration = params?.min_duration ?? 0.75
  const silences = deriveSilences(state.wordTimestamps, minDuration, params?.scope || null)
  return { silences }
}

async function get_audio_events(params, state) {
  const { scope, types } = params || {}
  // Detect both the unit-test shape ({type: 'audio_event'}) and the
  // production shape (bracketed word text, no type field).
  const isAudioEvent = (w) => w.type === 'audio_event' || (typeof w.word === 'string' && /^\[.*\]$/.test(w.word.trim()))
  let events = state.wordTimestamps.filter(isAudioEvent)
  if (scope) events = events.filter(w => inScope(w.start, w.end, scope))
  if (types?.length) {
    const wantedSet = new Set(types.map(t => t.toLowerCase()))
    events = events.filter(w => {
      const m = (w.word || '').toLowerCase()
      for (const t of wantedSet) if (m.includes(t)) return true
      return false
    })
  }
  return { events: events.map(e => ({ tc: e.word, type: 'audio_event', start: e.start, end: e.end })) }
}

async function search_transcript(params, state) {
  const { pattern, scope } = params || {}
  if (!pattern) return { matches: [] }
  let re
  try { re = new RegExp(pattern, 'g') } catch { return { matches: [], error: 'invalid regex' } }
  const matches = []
  const lines = state.assembledTranscript.split('\n')
  for (const line of lines) {
    const m = line.match(/^(\[[\d:\.]+\])\s*(.*)/)
    if (!m) continue
    const tc = m[1]
    const text = m[2]
    const tcSec = parseTimecode(tc)
    if (scope && !inScope(tcSec, tcSec, scope)) continue
    if (re.test(text)) matches.push({ tc, text })
    re.lastIndex = 0
  }
  return { matches }
}

function parseTimecode(tc) {
  const m = tc.match(/\[?(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,2}))?)?\]?/)
  if (!m) return 0
  let s = 0
  if (m[3] !== undefined) {
    s = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
  } else {
    s = parseInt(m[1]) * 60 + parseInt(m[2])
  }
  if (m[4]) s += parseInt(m[4], 10) / 100
  return s
}

async function find_interruption_clusters(params, state) {
  const clusters = findInterruptionClusters(state.wordTimestamps, {
    maxGapSec: params?.max_gap_sec,
    scope: params?.scope || null,
  })
  return { clusters }
}

async function propose_cut(params, state) {
  const cut_id = state.addCut(params)
  return { cut_id }
}

async function mark_uncertain(params, state) {
  const uncertain_id = state.addUncertain(params)
  return { uncertain_id }
}

async function remove_cut(params, state) {
  const removed = state.removeCut(params.cut_id)
  return { removed }
}

async function adjust_cut(params, state) {
  const adjusted = state.adjustCut(params.cut_id, {
    start: params.new_start,
    end: params.new_end,
  })
  return { adjusted }
}

async function preview_diff(params, state) {
  // Build the transcript text minus any line whose [tcSec, lineEnd] overlaps a cut.
  // lineEnd is approximated as the next line's tcSec (or +5s if last line).
  const scope = params?.scope || null
  const cutRanges = state.cuts.map(c => [c.start, c.end])
  const overlaps = (start, end) =>
    cutRanges.some(([cs, ce]) => start < ce && end > cs)

  const transcriptLines = state.assembledTranscript.split('\n')
  // Pre-compute parsed timecodes for each line (or null for non-timecoded lines).
  const parsed = transcriptLines.map(line => {
    const m = line.match(/^(\[[\d:\.]+\])\s*(.*)/)
    if (!m) return null
    return { tcSec: parseTimecode(m[1]) }
  })

  const out = []
  for (let i = 0; i < transcriptLines.length; i++) {
    const line = transcriptLines[i]
    const p = parsed[i]
    if (!p) {
      // Only emit non-timecoded lines when no scope filter; otherwise drop
      // header/spacing lines that fall outside the chunk being previewed.
      if (!scope) out.push(line)
      continue
    }
    // Find the next timecoded line's tcSec for this line's end; fall back to +5s.
    let lineEnd = p.tcSec + 5
    for (let j = i + 1; j < parsed.length; j++) {
      if (parsed[j]) { lineEnd = parsed[j].tcSec; break }
    }
    // Scope semantics: include a line iff its start tcSec lies within the
    // chunk window. Lines straddling the chunk boundary are dropped — the
    // agent should request adjacent chunks rather than half-overlap.
    if (scope && (p.tcSec < scope.start || p.tcSec > scope.end)) continue
    if (!overlaps(p.tcSec, lineEnd)) out.push(line)
  }
  return { preview: out.join('\n') }
}

function normalizeForCompare(text) {
  return text
    .toLowerCase()
    .replace(/\[.*?\]/g, ' ')         // strip bracketed tokens (audio events, timecodes)
    .replace(/[^\p{L}\p{N}\s']/gu, ' ') // strip punctuation, keep apostrophes
    .split(/\s+/)
    .filter(Boolean)
}

function jaccardWordSimilarity(a, b) {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0
  // multiset intersection / union
  const countA = new Map()
  const countB = new Map()
  for (const w of a) countA.set(w, (countA.get(w) || 0) + 1)
  for (const w of b) countB.set(w, (countB.get(w) || 0) + 1)
  let inter = 0
  for (const [w, c] of countA) {
    const cb = countB.get(w) || 0
    inter += Math.min(c, cb)
  }
  const union = a.length + b.length - inter
  return union === 0 ? 1 : inter / union
}

async function commit_chunk(params, state) {
  if (!params?.scope || typeof params.scope.start !== 'number' || typeof params.scope.end !== 'number') {
    throw new Error('commit_chunk: scope { start, end } is required')
  }
  if (typeof params.expected_text_after_cuts !== 'string') {
    throw new Error('commit_chunk: expected_text_after_cuts (string) is required')
  }
  const { scope, expected_text_after_cuts } = params

  const cutRanges = state.cuts.map(c => [c.start, c.end])
  const isCut = (wStart, wEnd) =>
    cutRanges.some(([cs, ce]) => wStart < ce && wEnd > cs)

  // Surviving words inside the chunk window.
  const surviving = state.wordTimestamps.filter(w =>
    inScope(w.start, w.end, scope) && !isCut(w.start, w.end)
  )
  const actual_text = surviving.map(w => w.word).join(' ').trim()

  const actualTokens = normalizeForCompare(actual_text)
  const expectedTokens = normalizeForCompare(expected_text_after_cuts)
  const match_percent = jaccardWordSimilarity(actualTokens, expectedTokens)

  // Cheap mismatch report: surviving content words the prediction missed,
  // and predicted content words that aren't actually present.
  const expectedSet = new Set(expectedTokens)
  const actualSet = new Set(actualTokens)
  const mismatches = []
  const unexpected_survival = actualTokens.filter(w => !expectedSet.has(w))
  const expected_but_missing = expectedTokens.filter(w => !actualSet.has(w))
  if (unexpected_survival.length > 0) {
    mismatches.push({ kind: 'unexpected_survival', words: unexpected_survival.slice(0, 10) })
  }
  if (expected_but_missing.length > 0) {
    mismatches.push({ kind: 'expected_but_missing', words: expected_but_missing.slice(0, 10) })
  }

  return { match_percent, actual_text, mismatches }
}

async function finish(params, state) {
  return {
    cuts_emitted: state.cuts.length,
    marked_uncertain: state.uncertain.length,
    summary: params.summary || '',
  }
}

const TOOLS = {
  get_transcript,
  get_chapters,
  get_silences,
  get_audio_events,
  search_transcript,
  find_interruption_clusters,
  propose_cut,
  mark_uncertain,
  remove_cut,
  adjust_cut,
  preview_diff,
  commit_chunk,
  finish,
}

export async function dispatchTool(name, params, state, ctx = {}) {
  const fn = TOOLS[name]
  if (!fn) throw new Error(`unknown tool: ${name}`)
  return await fn(params || {}, state, ctx)
}
