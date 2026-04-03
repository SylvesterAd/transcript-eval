import { useParams, Link } from 'react-router-dom'
import { useState } from 'react'
import { useApi, apiPut, apiPost } from '../../hooks/useApi.js'
import { supabase } from '../../lib/supabaseClient.js'
import DiffPanel from '../shared/DiffPanel.jsx'
import { Upload, Loader2 } from 'lucide-react'

const API_BASE = import.meta.env.VITE_API_URL || '/api'
async function authFetch(path, opts = {}) {
  const headers = { ...opts.headers }
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  return fetch(`${API_BASE}${path}`, { ...opts, headers })
}
import { expandText } from '../../lib/textExpander.js'
import { detectRepeatedTakes } from '../../lib/repeatedTakes.js'

const TABS = ['comparison_v4', 'strategies', 'raw', 'raw_normalized', 'raw_paragraphs', 'human_edited', 'human_normalized', 'human_paragraphs']

export default function VideoDetailView() {
  const { id } = useParams()
  const { data, loading, refetch } = useApi(`/videos/${id}`)
  const { data: diffData, loading: diffLoading, refetch: refetchDiff } = useApi(`/diffs/video/${id}/raw-vs-human`)
  const { data: videoRankings } = useApi(`/rankings/video/${id}`)
  const [activeTab, setActiveTab] = useState('comparison_v4')
  const [showUpload, setShowUpload] = useState(false)

  if (loading) return <div className="p-6 text-zinc-500 text-sm">Loading...</div>
  if (!data) return <div className="p-6 text-red-400 text-sm">Video not found</div>

  const raw = data.transcripts?.find(t => t.type === 'raw')
  const human = data.transcripts?.find(t => t.type === 'human_edited')
    // Fall back to human_edited transcript from a sibling video in the same group
    || data.siblingTranscripts?.find(t => t.type === 'human_edited')

  // Use group's assembled transcript if available (combined from multiple raw videos)
  const rawContent = data.groupTranscript || raw?.content
  const humanContent = human?.content

  // Determine what type of footage can be added
  const isRaw = data.video_type === 'raw'
  const hasRawSibling = data.groupVideos?.some(v => v.video_type === 'raw' && v.id !== data.id)
  const hasHumanSibling = data.groupVideos?.some(v => v.video_type === 'human_edited' && v.id !== data.id)
  const canAddRaw = !hasRawSibling
  const canAddHuman = !hasHumanSibling

  const isGroup = data.group_id && data.groupVideos?.length > 0
  const allGroupVideos = isGroup ? [data, ...data.groupVideos] : []
  const rawVideos = allGroupVideos.filter(v => v.video_type === 'raw')
  const humanVideos = allGroupVideos.filter(v => v.video_type === 'human_edited')

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold">{data.title}</h2>
          <div className="text-sm text-zinc-400 mt-1 flex gap-4 flex-wrap">
            {data.duration_seconds && <span>{formatDuration(data.duration_seconds)}</span>}
            <TypeBadge type={data.video_type} />
            {diffData && (
              <>
                <span>Similarity: <strong className={simColor(diffData.similarity?.similarityPercent)}>{diffData.similarity?.similarityPercent}%</strong></span>
                <span>Deletions: <strong>{diffData.deletions?.length}</strong></span>
              </>
            )}
          </div>
        </div>
        {(canAddRaw || canAddHuman) && (
          <button
            onClick={() => setShowUpload(!showUpload)}
            className="flex items-center gap-1 text-sm bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded transition-colors shrink-0"
          >
            <Upload size={14} />
            Add {isRaw ? 'Human Edited' : 'Raw Footage'}
          </button>
        )}
      </div>

      {isGroup && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-300 mb-2">
            <span className="text-blue-400">Combined Group:</span>
            <span className="text-zinc-500">{data.group_name}</span>
            <span className="text-zinc-600">|</span>
            <span className="text-zinc-500">{rawVideos.length} raw + {humanVideos.length} edited</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {allGroupVideos.map(v => (
              <Link
                key={v.id}
                to={`/admin/videos/${v.id}`}
                className={`text-xs px-2 py-1 rounded border transition-colors ${
                  v.id === data.id
                    ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                }`}
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${v.video_type === 'raw' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                {v.title || `Video ${v.id}`}
                {v.id === data.id && <span className="ml-1 text-zinc-500">(viewing)</span>}
              </Link>
            ))}
          </div>
          {data.groupTranscript && (
            <p className="text-xs text-zinc-500 mt-2">
              Raw transcript is the combined assembly of all {rawVideos.length} raw videos.
              {humanContent ? ' Human edit applies to the combined transcript.' : ' Upload a human edit to compare against the combined transcript.'}
            </p>
          )}
        </div>
      )}

      {showUpload && (
        <AddFootagePanel
          currentVideo={data}
          canAddRaw={canAddRaw}
          canAddHuman={canAddHuman}
          defaultType={isRaw ? 'human_edited' : 'raw'}
          onDone={() => { setShowUpload(false); refetch(); refetchDiff() }}
        />
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-800">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm transition-colors ${
              activeTab === tab
                ? 'text-white border-b-2 border-white'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {tab === 'raw' ? 'Raw' : tab === 'raw_normalized' ? 'Raw - Normalized' : tab === 'raw_paragraphs' ? 'Raw - Normalized & Paragraphs' : tab === 'human_edited' ? 'Human Edited' : tab === 'human_normalized' ? 'Human Edit - Normalized' : tab === 'human_paragraphs' ? 'Human Edit - Normalized & Paragraphs' : tab === 'strategies' ? 'Strategy Comparison' : tab === 'comparison_v4' ? 'Diff Analysis' : tab}
          </button>
        ))}
      </div>

      {activeTab === 'raw' && <TranscriptPanel label={data.groupTranscript ? 'Raw Transcript (combined from group)' : 'Raw Transcript'} content={rawContent} />}
      {activeTab === 'raw_normalized' && <TranscriptPanel label="Raw - Normalized" content={rawContent ? expandText(rawContent) : null} />}
      {activeTab === 'raw_paragraphs' && <RepeatedTakesPanel label="Raw - Normalized & Paragraphs" content={rawContent ? expandText(rawContent) : null} />}
      {activeTab === 'human_edited' && <TranscriptPanel label={human?.video_title ? `Human Edited (${human.video_title})` : 'Human Edited'} content={humanContent} />}
      {activeTab === 'human_normalized' && <TranscriptPanel label="Human Edit - Normalized" content={humanContent ? expandText(humanContent) : null} />}
      {activeTab === 'human_paragraphs' && <RepeatedTakesPanel label="Human Edit - Normalized & Paragraphs" content={humanContent ? expandText(humanContent) : null} />}
      {activeTab === 'comparison_v4' && <ComparisonPanelV4 rawContent={rawContent} humanContent={humanContent} />}
      {activeTab === 'strategies' && <StrategyComparisonPanel videoRankings={videoRankings} videoId={id} />}
    </div>
  )
}

function StrategyComparisonPanel({ videoRankings }) {
  if (!videoRankings?.rankings || videoRankings.rankings.length === 0) {
    return <p className="text-zinc-500 text-sm">No experiment results for this video yet.</p>
  }

  const { rankings } = videoRankings

  return (
    <div className="space-y-4">
      {/* Rankings table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-2 border-b border-zinc-800 text-sm text-zinc-400 font-medium">
          Strategy Rankings for This Video
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500 text-left">
              <th className="px-4 py-2 w-8">#</th>
              <th className="px-4 py-2">Experiment</th>
              <th className="px-4 py-2">Strategy</th>
              <th className="px-4 py-2 text-right">Avg Score</th>
              <th className="px-4 py-2 text-right">Min</th>
              <th className="px-4 py-2 text-right">Max</th>
              <th className="px-4 py-2 text-right">Runs</th>
            </tr>
          </thead>
          <tbody>
            {rankings.map((r, i) => (
              <tr key={r.experiment_id} className={`border-b border-zinc-800/50 ${i === 0 ? 'bg-emerald-900/10' : ''}`}>
                <td className="px-4 py-2 text-zinc-500 font-mono">{i + 1}</td>
                <td className="px-4 py-2 font-medium">{r.experiment_name}</td>
                <td className="px-4 py-2 text-zinc-400">{r.strategy_name} v{r.version_number}</td>
                <td className="px-4 py-2 text-right">
                  <span className={`font-bold ${scoreColor(r.avg_score)}`}>{Math.round(r.avg_score * 100)}%</span>
                </td>
                <td className="px-4 py-2 text-right text-zinc-400">{r.min_score ? Math.round(r.min_score * 100) + '%' : '—'}</td>
                <td className="px-4 py-2 text-right text-zinc-400">{r.max_score ? Math.round(r.max_score * 100) + '%' : '—'}</td>
                <td className="px-4 py-2 text-right text-zinc-500">{r.run_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Stage-by-stage detail for each strategy */}
      {rankings.filter(r => r.stageMetrics?.length > 0).map(r => (
        <div key={r.experiment_id} className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b border-zinc-800 text-sm text-zinc-400 font-medium flex justify-between">
            <span>{r.experiment_name} — Stage Progression</span>
            <span className={scoreColor(r.avg_score)}>{Math.round(r.avg_score * 100)}%</span>
          </div>
          <div className="p-3 flex gap-2 items-center">
            {r.stageMetrics.map((s, i) => (
              <div key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-zinc-600 text-xs px-1">→</span>}
                <div className="bg-zinc-800 rounded px-3 py-2 text-center min-w-20">
                  <div className="text-xs text-zinc-500">{s.stage_name}</div>
                  <div className={`text-sm font-bold ${simColor(s.avg_similarity)}`}>{s.avg_similarity}%</div>
                  {s.avg_delta !== null && (
                    <div className={`text-[10px] ${s.avg_delta < 0 ? 'text-emerald-400' : s.avg_delta > 0 ? 'text-red-400' : 'text-zinc-500'}`}>
                      {s.avg_delta > 0 ? '+' : ''}{s.avg_delta}pp
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Reason stats for final stage */}
          {r.reasonStats?.length > 0 && (
            <div className="px-4 pb-3 flex gap-4 text-xs">
              <span className="text-zinc-500">Final deletions by type:</span>
              {r.reasonStats.map(rs => (
                <span key={rs.reason} className={reasonColor(rs.reason)}>
                  {reasonLabel(rs.reason)}: {rs.count}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function ComparisonPanel({ diffData, diffLoading, rawContent, humanContent }) {
  if (diffLoading) return <div className="text-zinc-500 text-sm">Computing diff...</div>
  if (!diffData) return <div className="text-zinc-500 text-sm">No diff data available.</div>

  const rows = buildComparison(rawContent, humanContent)

  const labelColors = {
    same: 'bg-green-900/30 text-green-400',
    lightly_edited: 'bg-blue-900/30 text-blue-400',
    rewritten: 'bg-yellow-900/30 text-yellow-400',
    moved: 'bg-purple-900/30 text-purple-400',
    deleted: 'bg-red-900/30 text-red-400',
    false_start: 'bg-orange-900/30 text-orange-400',
    new_in_edit: 'bg-emerald-900/30 text-emerald-400',
    low_confidence: 'bg-zinc-800 text-zinc-500',
  }
  const labelNames = {
    same: 'Same', lightly_edited: 'Edited', rewritten: 'Rewritten',
    moved: 'Moved', deleted: 'Deleted', false_start: 'False Start',
    new_in_edit: 'New', low_confidence: 'Uncertain',
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Similarity" value={`${diffData.similarity?.similarityPercent}%`} color={simColor(diffData.similarity?.similarityPercent)} />
        <StatCard label="Diff" value={`${diffData.similarity?.diffPercent}%`} color="text-zinc-300" />
        <StatCard label="Deletions" value={`${diffData.deletions?.length || 0}`} color="text-red-400" />
        <StatCard label="Additions" value={`${diffData.additions?.length || 0}`} color="text-emerald-400" />
      </div>

      <ReasonSummary stats={diffData.reasonStats} />

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="grid grid-cols-3 border-b border-zinc-800 text-xs text-zinc-400 font-medium">
          <div className="px-3 py-2 border-r border-zinc-800">Raw Transcript</div>
          <div className="px-3 py-2 border-r border-zinc-800">Human Edited</div>
          <div className="px-3 py-2">Raw — Deletions Marked</div>
        </div>

        <div className="max-h-[75vh] overflow-auto">
          {rows.map((row, i) => (
            <div key={i} className={`grid grid-cols-3 ${i > 0 ? 'border-t border-zinc-800/30' : ''}`}>
              <div className="px-3 py-1.5 border-r border-zinc-800/50 text-xs font-mono whitespace-pre-wrap leading-relaxed">
                <span className={`inline-block text-[10px] font-sans font-medium px-1.5 py-0.5 rounded mb-1 ${labelColors[row.label]}`}>
                  {labelNames[row.label]} {row.confidence < 100 ? `${row.confidence}%` : ''}
                </span>
                <br />
                {row.raw ? highlightTranscript(row.raw) : <span className="text-zinc-700 italic">—</span>}
              </div>
              <div className="px-3 py-1.5 border-r border-zinc-800/50 text-xs font-mono whitespace-pre-wrap leading-relaxed">
                {row.human || <span className="text-zinc-700 italic">—</span>}
              </div>
              <div className="px-3 py-1.5 text-xs font-mono whitespace-pre-wrap leading-relaxed">
                {row.marked.length > 0 ? row.marked.map((seg, j) => {
                  const stateStyles = {
                    kept: '',
                    kept_elsewhere: 'text-blue-400',
                    false_start: 'bg-orange-900/40 text-orange-300 line-through',
                    deleted: 'bg-red-900/40 text-red-300 line-through',
                    moved: 'text-purple-400',
                  }
                  const cls = stateStyles[seg.state] || ''
                  return <span key={j} className={cls}>{highlightTranscript(seg.text)}</span>
                }) : <span className="text-zinc-700 italic">—</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <DeletionList deletions={diffData.deletions} />
    </div>
  )
}

// =============================================
// HUMAN-ANCHORED ALIGNMENT PIPELINE v2
// =============================================

// -- Step 1: Normalization --

function normalizeForMatching(text) {
  if (!text) return ''
  return text
    .replace(/\[\d{2}:\d{2}:\d{2}\]/g, '')
    .replace(/\[\d+\.?\d*s\]/g, '')
    .toLowerCase()
    .replace(/['\u2018\u2019`]/g, '')
    .replace(/["\u201C\u201D]/g, '')
    .replace(/[.,!?;:()\[\]{}\-\u2014\u2013\u2026]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getWords(text) {
  const n = normalizeForMatching(text)
  return n ? n.split(' ').filter(w => w.length > 0) : []
}

function stripTimecodes(text) {
  if (!text) return ''
  return text.replace(/\[\d{2}:\d{2}:\d{2}\]\s*/g, '').trim()
}

// -- Step 2: Semantic chunking (timecodes as metadata, not primary boundaries) --

function chunkText(text) {
  if (!text) return []

  // Split by timecodes as initial hints
  const tcParts = text.split(/(?=\[\d{2}:\d{2}:\d{2}\])/).map(s => s.trim()).filter(Boolean)
  const rawPieces = tcParts.length > 1 ? tcParts : [text]

  // Further split by sentence boundaries, target 15-40 words per chunk
  const chunks = []
  for (const piece of rawPieces) {
    const words = getWords(piece)
    if (words.length === 0) continue
    if (words.length <= 40) {
      chunks.push({ original: piece, words })
    } else {
      const sents = piece.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean)
      let buf = ''
      for (const sent of sents) {
        const combined = buf ? buf + ' ' + sent : sent
        if (buf && getWords(combined).length > 35) {
          const bw = getWords(buf)
          if (bw.length > 0) chunks.push({ original: buf, words: bw })
          buf = sent
        } else {
          buf = combined
        }
      }
      if (buf) {
        const bw = getWords(buf)
        if (bw.length > 0) chunks.push({ original: buf, words: bw })
      }
    }
  }

  // Merge very short chunks (≤3 words) with neighbors
  if (chunks.length <= 1) return chunks
  const merged = [chunks[0]]
  for (let i = 1; i < chunks.length; i++) {
    if (chunks[i].words.length <= 3) {
      const prev = merged[merged.length - 1]
      prev.original += '\n' + chunks[i].original
      prev.words = [...prev.words, ...chunks[i].words]
    } else {
      merged.push(chunks[i])
    }
  }

  // No-dangling-boundary: merge chunks ending on incomplete clauses with next
  const noDangling = mergeDanglingBoundaries(merged)

  // Split chunks that contain internal restarts (repeated prefix within one block)
  const withRestarts = []
  for (const c of noDangling) withRestarts.push(...splitChunkAtRestarts(c))
  return withRestarts
}

/** Does the next chunk start with a continuation word indicating it's mid-thought? */
function isDirectContinuation(words) {
  if (words.length === 0) return false
  const continuations = new Set([
    'and', 'or', 'but', 'so', 'because', 'which', 'that', 'who', 'where',
    'when', 'while', 'since', 'though', 'although', 'however', 'therefore',
    'meanwhile', 'furthermore', 'moreover', 'nevertheless', 'instead', 'then'
  ])
  return continuations.has(words[0])
}

function mergeDanglingBoundaries(chunks) {
  if (chunks.length <= 1) return chunks
  const result = []
  let i = 0
  while (i < chunks.length) {
    if (i < chunks.length - 1 && chunks[i].words.length + chunks[i + 1].words.length <= 50 &&
        (looksIncomplete(chunks[i].words) || isDirectContinuation(chunks[i + 1].words))) {
      const combined = {
        original: chunks[i].original + '\n' + chunks[i + 1].original,
        words: [...chunks[i].words, ...chunks[i + 1].words]
      }
      result.push(combined)
      i += 2
    } else {
      result.push(chunks[i])
      i++
    }
  }
  return result
}

/** Split a single chunk if it contains a repeated 3+ word prefix (false start inside one block) */
function splitChunkAtRestarts(chunk) {
  const words = chunk.words
  if (words.length < 10) return [chunk]

  // Find word positions in original text (skip timecodes/pauses)
  const orig = chunk.original
  const skipR = []
  let mm
  const tcScan = /\[\d{2}:\d{2}:\d{2}\]/g
  while ((mm = tcScan.exec(orig)) !== null) skipR.push([mm.index, mm.index + mm[0].length])
  const pScan = /\[\d+\.?\d*s\]/g
  while ((mm = pScan.exec(orig)) !== null) skipR.push([mm.index, mm.index + mm[0].length])

  const wPos = []
  const wScan = /[a-zA-Z0-9'\u2018\u2019]+/g
  while ((mm = wScan.exec(orig)) !== null) {
    if (skipR.some(([s, e]) => mm.index >= s && mm.index + mm[0].length <= e)) continue
    const norm = mm[0].toLowerCase().replace(/['\u2018\u2019]/g, '')
    if (norm.length <= 1) continue
    wPos.push({ word: norm, idx: mm.index })
  }

  if (wPos.length < 10) return [chunk]

  // Look for repeated prefix of 3–7 words starting later in the chunk
  for (let pLen = Math.min(7, Math.floor(wPos.length / 3)); pLen >= 3; pLen--) {
    for (let start = pLen + 1; start <= wPos.length - pLen; start++) {
      let ok = true
      for (let k = 0; k < pLen; k++) {
        if (wPos[start + k].word !== wPos[k].word) { ok = false; break }
      }
      if (!ok) continue

      // Found restart at wPos[start]. Split the original text there.
      let splitAt = wPos[start].idx
      // Pull back to include any timecode immediately before the restart
      const before = orig.slice(0, splitAt)
      const tcBefore = before.match(/\[\d{2}:\d{2}:\d{2}\]\s*$/)
      if (tcBefore) splitAt -= tcBefore[0].length

      const part1 = orig.slice(0, splitAt).trim()
      const part2 = orig.slice(splitAt).trim()
      const w1 = getWords(part1)
      const w2 = getWords(part2)
      if (w1.length >= 3 && w2.length >= 3) {
        return [{ original: part1, words: w1 }, { original: part2, words: w2 }]
      }
    }
  }

  return [chunk]
}

// -- Step 3: IDF --

function computeIDF(chunks) {
  const df = new Map()
  const N = chunks.length
  for (const c of chunks) {
    const unique = new Set(c.words)
    for (const w of unique) df.set(w, (df.get(w) || 0) + 1)
  }
  const idf = new Map()
  for (const [w, count] of df) idf.set(w, Math.log((N + 1) / (count + 1)) + 1)
  return idf
}

// -- Step 3.5: False-start / self-repair detection on raw side --

/** Does the word list end on a function word / incomplete phrase? */
function looksIncomplete(words) {
  if (words.length === 0) return true
  const last = words[words.length - 1]
  return new Set([
    'the','a','an','to','for','of','in','on','at','by','with',
    'and','or','but','that','this','its','your','our','their','any','some',
    'all','no','not','if','is','are','was','were','be','has','have','had',
    'will','would','could','should','can','may','just','very','really',
    'so','then','like','about','into','from','more','also'
  ]).has(last)
}

/** Find longest matching word sequence at any positions in two word arrays */
function findBestOverlap(a, b, minLen = 3) {
  let bestLen = 0, bestPosA = -1, bestPosB = -1
  for (let pa = 0; pa <= a.length - minLen; pa++) {
    for (let pb = 0; pb <= b.length - minLen; pb++) {
      let len = 0
      while (pa + len < a.length && pb + len < b.length && a[pa + len] === b[pb + len]) len++
      if (len > bestLen) { bestLen = len; bestPosA = pa; bestPosB = pb }
    }
  }
  return { len: bestLen, posA: bestPosA, posB: bestPosB }
}

/**
 * Detect restart groups across chunk boundaries.
 * Uses sliding-window overlap (not just prefix matching).
 * Returns array of { abandonedIdxs, canonicalIdx, prefixLen, confidence }
 */
function detectRestartGroups(rawChunks) {
  const pairs = []

  // Pairwise: find best overlap at ANY position (gap up to 3)
  for (let i = 0; i < rawChunks.length - 1; i++) {
    for (let gap = 1; gap <= Math.min(3, rawChunks.length - 1 - i); gap++) {
      const j = i + gap
      const a = rawChunks[i].words
      const b = rawChunks[j].words
      if (a.length < 3 || b.length < 3) continue

      const overlap = findBestOverlap(a, b)
      if (overlap.len < 3) continue

      const overlapRatio = overlap.len / Math.min(a.length, b.length)
      const setA = new Set(a), setB = new Set(b)
      let wordOverlap = 0
      for (const w of setA) if (setB.has(w)) wordOverlap++
      const wordOverlapRatio = wordOverlap / Math.max(setA.size, setB.size)

      let confidence = 0
      if (overlapRatio > 0.5) confidence += 0.3
      else if (overlapRatio > 0.3) confidence += 0.15
      if (overlap.len >= 5) confidence += 0.2
      if (wordOverlapRatio > 0.6) confidence += 0.15
      if (b.length >= a.length) confidence += 0.1
      // Cross-boundary bonus: overlap starting later in A
      if (overlap.posA > 0 && overlap.posA >= a.length * 0.4) confidence += 0.1
      if (looksIncomplete(a)) confidence += 0.15
      if (gap === 1) confidence += 0.1

      if (confidence >= 0.45) {
        pairs.push({ abandonedIdx: i, finalIdx: j, prefixLen: overlap.len, confidence })
      }
    }
  }

  // Cross-boundary: concatenate adjacent chunks and check for restart into next
  // Attribution by contribution, not by overlap start position
  for (let i = 0; i + 2 < rawChunks.length; i++) {
    const chunkILen = rawChunks[i].words.length
    const chunkI1Len = rawChunks[i + 1].words.length
    const combined = [...rawChunks[i].words, ...rawChunks[i + 1].words]
    const next = rawChunks[i + 2].words
    if (next.length < 3 || combined.length < 6) continue
    const overlap = findBestOverlap(combined, next)
    if (overlap.len < 4) continue

    // Compute per-chunk contribution to the overlap
    const overlapEnd = overlap.posA + overlap.len
    const wordsFromI = Math.max(0, Math.min(chunkILen, overlapEnd) - Math.max(0, overlap.posA))
    const wordsFromI1 = overlap.len - wordsFromI
    const shareOfI = chunkILen > 0 ? wordsFromI / chunkILen : 0
    const shareOfI1 = chunkI1Len > 0 ? wordsFromI1 / chunkI1Len : 0
    const prefixWordsI = Math.max(0, Math.min(chunkILen, overlap.posA))

    // Only abandon when contribution is dominant and substantial
    // Do not abandon a whole chunk from a small tail carryover
    let abandonedIdx = -1
    if (wordsFromI1 / overlap.len >= 0.5 && shareOfI1 >= 0.3) {
      abandonedIdx = i + 1
    } else if (wordsFromI / overlap.len >= 0.5 && shareOfI >= 0.3 && prefixWordsI <= 4) {
      abandonedIdx = i
    }

    if (abandonedIdx >= 0 && !pairs.some(p => p.abandonedIdx === abandonedIdx && p.finalIdx === i + 2)) {
      const confidence = 0.5 + (overlap.len >= 6 ? 0.15 : 0.05)
      pairs.push({
        abandonedIdx, finalIdx: i + 2, prefixLen: overlap.len, confidence,
        overlapDetail: { chunkI: i, chunkI1: i + 1, wordsFromI, wordsFromI1,
          prefixWordsI, prefixWordsI1: Math.max(0, overlap.posA - chunkILen), chunkILen, chunkI1Len }
      })
    }
  }

  // Merge pairs into multi-abandoned groups
  const used = new Set()
  const groups = []
  pairs.sort((a, b) => a.abandonedIdx - b.abandonedIdx)

  for (const pair of pairs) {
    if (used.has(pair.abandonedIdx)) continue
    const chain = [pair.abandonedIdx]
    let canonical = pair.finalIdx
    let maxConfidence = pair.confidence
    let maxPrefixLen = pair.prefixLen
    used.add(pair.abandonedIdx)

    let extended = true
    while (extended) {
      extended = false
      for (const other of pairs) {
        if (other.abandonedIdx === canonical && !used.has(other.abandonedIdx)) {
          chain.push(canonical)
          used.add(canonical)
          canonical = other.finalIdx
          maxConfidence = Math.max(maxConfidence, other.confidence)
          maxPrefixLen = Math.max(maxPrefixLen, other.prefixLen)
          extended = true
          break
        }
      }
    }

    groups.push({
      abandonedIdxs: chain,
      canonicalIdx: canonical,
      prefixLen: maxPrefixLen,
      confidence: maxConfidence
    })
  }

  return { groups, pairs }
}

// -- Step 3.55: Boundary-overlap resolution into ranges --

function resolveBoundaryOverlaps(pairs, rawChunks) {
  // For chunks partially involved in cross-boundary overlaps,
  // determine if they have a protected prefix that should stay eligible
  const rangeEligibility = new Map()

  for (const pair of pairs) {
    if (!pair.overlapDetail) continue
    const detail = pair.overlapDetail
    const abandonedIdx = pair.abandonedIdx
    const chunkLen = rawChunks[abandonedIdx].words.length

    let prefixWords, overlapWords
    if (abandonedIdx === detail.chunkI) {
      prefixWords = detail.prefixWordsI
      overlapWords = detail.wordsFromI
    } else {
      prefixWords = detail.prefixWordsI1
      overlapWords = detail.wordsFromI1
    }

    // Protected prefix: significant non-overlap words at start of chunk
    if (prefixWords >= 3 && overlapWords / chunkLen < 0.6) {
      rangeEligibility.set(abandonedIdx, {
        protectedPrefix: prefixWords,
        abandonedFrom: prefixWords
      })
    }
  }

  return rangeEligibility
}

// -- Step 3.6: Canonical winner selection (range-aware) --

function selectCanonicalWinners(restartGroups, rawChunks, rangeEligibility) {
  const eligibility = new Map()
  for (const group of restartGroups) {
    // Pick winner from full candidate set: longest complete chunk wins
    const candidates = [...group.abandonedIdxs, group.canonicalIdx]
    let bestIdx = group.canonicalIdx
    let bestScore = -1
    for (const idx of candidates) {
      if (idx >= rawChunks.length) continue
      const words = rawChunks[idx].words
      const score = words.length + (looksIncomplete(words) ? 0 : 3)
      if (score > bestScore) { bestScore = score; bestIdx = idx }
    }
    for (const idx of candidates) {
      if (idx === bestIdx) {
        eligibility.set(idx, 'canonical')
      } else {
        // Range-level: if chunk has protected prefix, keep it partially eligible
        const range = rangeEligibility ? rangeEligibility.get(idx) : null
        if (range && range.protectedPrefix >= 3) {
          eligibility.set(idx, { status: 'partial', protectedPrefix: range.protectedPrefix })
        } else {
          eligibility.set(idx, 'abandoned')
        }
      }
    }
  }
  return eligibility
}

// -- Step 4: Balanced scoring (coverage + precision + bigram + F1) --

function getSpanWords(chunks, start, end) {
  const words = []
  for (let i = start; i <= end; i++) words.push(...chunks[i].words)
  return words
}

/** IDF-weighted fraction of targetWords found in sourceWords */
function coverageOf(targetWords, sourceWords, idf) {
  if (targetWords.length === 0) return 1
  const sourceSet = new Set(sourceWords)
  let covW = 0, totalW = 0
  for (const w of targetWords) {
    const wt = idf.get(w) || 1
    totalW += wt
    if (sourceSet.has(w)) covW += wt
  }
  return totalW > 0 ? covW / totalW : 0
}

function spanMatchScore(rawWords, humanWords, idf) {
  if (rawWords.length === 0 || humanWords.length === 0) return 0

  // Coverage: fraction of human words found in raw (IDF-weighted)
  const coverage = coverageOf(humanWords, rawWords, idf)

  // Precision: fraction of raw words found in human (IDF-weighted)
  const precision = coverageOf(rawWords, humanWords, idf)

  // F1: harmonic mean of coverage and precision
  const f1 = (coverage + precision) > 0 ? 2 * coverage * precision / (coverage + precision) : 0

  // Bigram sequence bonus: ordered word pairs from human found in raw
  let bigramBonus = 0
  if (rawWords.length >= 2 && humanWords.length >= 2) {
    const bgR = new Set()
    for (let i = 0; i < rawWords.length - 1; i++) bgR.add(rawWords[i] + ' ' + rawWords[i + 1])
    let hits = 0
    for (let i = 0; i < humanWords.length - 1; i++) {
      if (bgR.has(humanWords[i] + ' ' + humanWords[i + 1])) hits++
    }
    bigramBonus = hits / Math.max(1, humanWords.length - 1)
  }

  return coverage * 0.35 + precision * 0.25 + bigramBonus * 0.25 + f1 * 0.15
}

// -- Step 5: Global monotonic alignment (DP with human as fixed spine) --

function globalAlign(rawChunks, humanChunks, idf, eligibility) {
  const H = humanChunks.length
  const R = rawChunks.length
  const MAX_H = 3   // max human chunks merged in one span
  const MAX_R = 6   // max raw chunks merged in one span

  // dp[h][r] = max total score for consuming human[0..h-1] and raw[0..r-1]
  const dp = []
  const bt = []
  for (let h = 0; h <= H; h++) {
    dp[h] = new Array(R + 1).fill(-Infinity)
    bt[h] = new Array(R + 1).fill(null)
  }
  dp[0][0] = 0

  for (let h = 0; h <= H; h++) {
    for (let r = 0; r <= R; r++) {
      if (dp[h][r] === -Infinity) continue
      const cur = dp[h][r]

      // Option 1: Skip raw[r] (deleted/abandoned content — no penalty)
      if (r < R && cur > dp[h][r + 1]) {
        dp[h][r + 1] = cur
        bt[h][r + 1] = { ph: h, pr: r, type: 'skip_raw' }
      }

      // Option 2: Skip human[h] (new content — small penalty)
      if (h < H) {
        const v = cur - 0.15
        if (v > dp[h + 1][r]) {
          dp[h + 1][r] = v
          bt[h + 1][r] = { ph: h, pr: r, type: 'skip_human' }
        }
      }

      // Option 3: Match human[h..h+hl-1] to raw[r..r+rl-1]
      for (let hl = 1; hl <= Math.min(MAX_H, H - h); hl++) {
        const hWords = []
        for (let i = h; i < h + hl; i++) hWords.push(...humanChunks[i].words)

        for (let rl = 1; rl <= Math.min(MAX_R, R - r); rl++) {
          // Eligibility: abandoned chunks are transparent (words excluded from scoring)
          // Partial chunks contribute only their protected prefix words
          const rWords = []
          let allAbandoned = true
          for (let i = r; i < r + rl; i++) {
            const elig = eligibility.get(i)
            if (elig === 'abandoned') continue // transparent: skip words
            allAbandoned = false
            if (elig && elig.status === 'partial') {
              rWords.push(...rawChunks[i].words.slice(0, elig.protectedPrefix))
            } else {
              rWords.push(...rawChunks[i].words)
            }
          }
          if (allAbandoned || rWords.length === 0) continue

          const score = spanMatchScore(rWords, hWords, idf)
          if (score < 0.08) continue

          // Small penalty for complex spans (prefer simpler matches)
          const spanPen = (hl + rl - 2) * 0.015
          const v = cur + score - spanPen

          if (v > dp[h + hl][r + rl]) {
            dp[h + hl][r + rl] = v
            bt[h + hl][r + rl] = { ph: h, pr: r, type: 'match', hl, rl, score }
          }
        }
      }
    }
  }

  // Backtrack from dp[H][R]
  const alignment = new Array(H).fill(null)
  const usedRaw = new Set()

  let ch = H, cr = R
  while (ch > 0 || cr > 0) {
    const step = bt[ch][cr]
    if (!step) break

    if (step.type === 'match') {
      alignment[step.ph] = {
        rawStart: step.pr,
        rawEnd: step.pr + step.rl - 1,
        hSpanEnd: step.ph + step.hl - 1,
        score: step.score,
      }
      for (let i = step.pr; i < step.pr + step.rl; i++) usedRaw.add(i)
    }

    ch = step.ph
    cr = step.pr
  }

  return { alignment, usedRaw }
}

// -- Step 5.5: Post-match span extension --

function extendMatchedSpans(rawChunks, humanChunks, alignment, usedRaw, idf, eligibility) {
  for (let h = 0; h < humanChunks.length; h++) {
    const match = alignment[h]
    if (!match || match.moved) continue

    const hEnd = match.hSpanEnd != null ? match.hSpanEnd : h
    const hWords = []
    for (let i = h; i <= hEnd; i++) hWords.push(...humanChunks[i].words)

    // Try extending left (skip abandoned chunks)
    while (match.rawStart > 0 && !usedRaw.has(match.rawStart - 1)) {
      const r = match.rawStart - 1
      if (eligibility.get(r) === 'abandoned') break
      if (rawChunks[r].words.length > 12) break
      const curSpan = getSpanWords(rawChunks, match.rawStart, match.rawEnd)
      const extSpan = getSpanWords(rawChunks, r, match.rawEnd)
      const gain = coverageOf(hWords, extSpan, idf) - coverageOf(hWords, curSpan, idf)
      if (gain < -0.05) break
      match.rawStart = r
      usedRaw.add(r)
    }

    // Try extending right (skip abandoned chunks)
    while (match.rawEnd < rawChunks.length - 1 && !usedRaw.has(match.rawEnd + 1)) {
      const r = match.rawEnd + 1
      if (eligibility.get(r) === 'abandoned') break
      if (rawChunks[r].words.length > 12) break
      const curSpan = getSpanWords(rawChunks, match.rawStart, match.rawEnd)
      const extSpan = getSpanWords(rawChunks, match.rawStart, r)
      const gain = coverageOf(hWords, extSpan, idf) - coverageOf(hWords, curSpan, idf)
      if (gain < -0.05) break
      match.rawEnd = r
      usedRaw.add(r)
    }

    match.score = spanMatchScore(getSpanWords(rawChunks, match.rawStart, match.rawEnd), hWords, idf)
  }
}

// -- Step 5.6: Global token ownership --

function initChunkOwnership(rawChunks, usedRaw, eligibility) {
  const ownership = new Map()
  for (let r = 0; r < rawChunks.length; r++) {
    const elig = eligibility.get(r)
    if (elig === 'abandoned') {
      ownership.set(r, 'false_start')
    } else if (elig && elig.status === 'partial') {
      // Partially abandoned: if used in alignment treat as matched, otherwise provisional
      ownership.set(r, usedRaw.has(r) ? 'matched' : 'partial_abandoned')
    } else if (usedRaw.has(r)) {
      ownership.set(r, 'matched')
    } else {
      ownership.set(r, 'deleted')
    }
  }
  return ownership
}

// -- Step 6: Post-alignment repair (orphan absorption) --

function repairAlignment(rawChunks, humanChunks, alignment, usedRaw, idf, ownership) {
  let changed = true
  let iter = 0
  while (changed && iter < 2) {
    changed = false
    iter++

    for (let r = 0; r < rawChunks.length; r++) {
      const ownState = ownership.get(r)
      // Never absorb false_start or partial_abandoned — they must remain isolated
      if (ownState === 'matched' || ownState === 'moved' || ownState === 'false_start' || ownState === 'partial_abandoned') continue
      if (rawChunks[r].words.length > 10) continue

      // Find adjacent matched span
      let bestH = -1, bestGain = -Infinity
      for (let h = 0; h < humanChunks.length; h++) {
        const match = alignment[h]
        if (!match) continue
        if (r !== match.rawStart - 1 && r !== match.rawEnd + 1) continue

        const hEnd = match.hSpanEnd != null ? match.hSpanEnd : h
        const hWords = []
        for (let i = h; i <= hEnd; i++) hWords.push(...humanChunks[i].words)

        const curSpan = getSpanWords(rawChunks, match.rawStart, match.rawEnd)
        const extStart = Math.min(match.rawStart, r)
        const extEnd = Math.max(match.rawEnd, r)
        const extSpan = getSpanWords(rawChunks, extStart, extEnd)
        const gain = coverageOf(hWords, extSpan, idf) - coverageOf(hWords, curSpan, idf)

        if (gain > bestGain) { bestGain = gain; bestH = h }
      }

      if (bestH >= 0 && bestGain >= -0.03) {
        const match = alignment[bestH]
        if (r < match.rawStart) match.rawStart = r
        else match.rawEnd = r

        const hEnd = match.hSpanEnd != null ? match.hSpanEnd : bestH
        const hWords = []
        for (let i = bestH; i <= hEnd; i++) hWords.push(...humanChunks[i].words)
        match.score = spanMatchScore(getSpanWords(rawChunks, match.rawStart, match.rawEnd), hWords, idf)
        usedRaw.add(r)
        ownership.set(r, 'matched')
        changed = true
      }
    }
  }
}

// -- Step 7: Moved content detection (for unmatched human chunks) --

function detectMovedContent(alignment, humanChunks, rawChunks, usedRaw, idf, ownership) {
  for (let h = 0; h < humanChunks.length; h++) {
    if (alignment[h]) continue

    const hWords = humanChunks[h].words
    let bestScore = 0, bestR = -1

    for (let r = 0; r < rawChunks.length; r++) {
      if (ownership.get(r) !== 'deleted') continue
      const score = spanMatchScore(rawChunks[r].words, hWords, idf)
      if (score > bestScore) { bestScore = score; bestR = r }
    }

    if (bestScore > 0.3 && bestR >= 0) {
      alignment[h] = {
        rawStart: bestR, rawEnd: bestR,
        hSpanEnd: h,
        score: bestScore, moved: true,
      }
      usedRaw.add(bestR)
      ownership.set(bestR, 'moved')
    }
  }
}

// -- Step 8: Classification (separate from alignment) --

function classifyMatch(match, h, rawChunks, humanChunks, idf, ownership) {
  if (!match) return { label: 'new_in_edit', confidence: 100 }

  // Token state authoritative: if all raw chunks in span are false_start, label accordingly
  let allFalseStart = true
  for (let i = match.rawStart; i <= match.rawEnd; i++) {
    if (ownership.get(i) !== 'false_start') { allFalseStart = false; break }
  }
  if (allFalseStart) return { label: 'false_start', confidence: 100 }

  const hEnd = match.hSpanEnd != null ? match.hSpanEnd : h
  const hWords = []
  for (let i = h; i <= hEnd; i++) hWords.push(...humanChunks[i].words)

  const rWords = getSpanWords(rawChunks, match.rawStart, match.rawEnd)
  const cov = coverageOf(hWords, rWords, idf)

  if (match.moved) return { label: 'moved', confidence: Math.round(cov * 100) }
  if (cov > 0.85 && match.score > 0.5) return { label: 'same', confidence: Math.round(cov * 100) }
  if (cov > 0.6 && match.score > 0.3) return { label: 'lightly_edited', confidence: Math.round(cov * 100) }
  if (cov > 0.3 && match.score > 0.15) return { label: 'rewritten', confidence: Math.round(cov * 100) }
  return { label: 'low_confidence', confidence: Math.round(cov * 100) }
}

// -- Step 9: Ownership-aware local diff --

function computeOwnershipSegments(rawText, humanWords, globalHumanWords) {
  // Extract words from raw text, skipping timecodes and pauses
  const skipPos = []
  let m
  const tcRe = /\[\d{2}:\d{2}:\d{2}\]/g
  while ((m = tcRe.exec(rawText)) !== null) skipPos.push({ s: m.index, e: m.index + m[0].length })
  const pRe = /\[\d+\.?\d*s\]/g
  while ((m = pRe.exec(rawText)) !== null) skipPos.push({ s: m.index, e: m.index + m[0].length })

  const rawWordList = []
  const wRe = /[a-zA-Z0-9'\u2018\u2019]+/g
  while ((m = wRe.exec(rawText)) !== null) {
    if (skipPos.some(sp => m.index >= sp.s && m.index + m[0].length <= sp.e)) continue
    const norm = m[0].toLowerCase().replace(/['\u2018\u2019]/g, '')
    if (norm.length <= 1) continue
    rawWordList.push({ word: norm, start: m.index, end: m.index + m[0].length })
  }

  if (rawWordList.length === 0) return [{ text: rawText, state: 'kept' }]

  // LCS between raw word sequence and aligned human word sequence
  const rawNorms = rawWordList.map(w => w.word)
  const n = rawNorms.length
  const hm = humanWords.length

  const lcsTab = []
  for (let i = 0; i <= n; i++) lcsTab[i] = new Array(hm + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= hm; j++) {
      if (rawNorms[i - 1] === humanWords[j - 1]) {
        lcsTab[i][j] = lcsTab[i - 1][j - 1] + 1
      } else {
        lcsTab[i][j] = Math.max(lcsTab[i - 1][j], lcsTab[i][j - 1])
      }
    }
  }

  // Backtrack to find which raw indices are in LCS
  const inLCS = new Set()
  let ri = n, hj = hm
  while (ri > 0 && hj > 0) {
    if (rawNorms[ri - 1] === humanWords[hj - 1]) {
      inLCS.add(ri - 1)
      ri--; hj--
    } else if (lcsTab[ri - 1][hj] > lcsTab[ri][hj - 1]) {
      ri--
    } else {
      hj--
    }
  }

  // Assign per-word state
  const wordStates = rawWordList.map((w, i) => {
    if (inLCS.has(i)) return 'kept'
    if (globalHumanWords.has(w.word)) return 'kept_elsewhere'
    return 'deleted'
  })

  // Build marks and merge adjacent same-state words
  const marks = rawWordList.map((w, i) => ({ start: w.start, end: w.end, state: wordStates[i] }))
  const merged = [{ ...marks[0] }]
  for (let i = 1; i < marks.length; i++) {
    const last = merged[merged.length - 1]
    const gap = rawText.slice(last.end, marks[i].start)
    if (marks[i].state === last.state && /^[\s.,!?;:'"()\-\u2014\u2013\u2026\u2018\u2019\u201C\u201D]*$/.test(gap)) {
      last.end = marks[i].end
    } else {
      merged.push({ ...marks[i] })
    }
  }

  // Build segments
  const segs = []
  let pos = 0
  for (const mk of merged) {
    if (mk.start > pos) segs.push({ text: rawText.slice(pos, mk.start), state: 'kept' })
    segs.push({ text: rawText.slice(mk.start, mk.end), state: mk.state })
    pos = mk.end
  }
  if (pos < rawText.length) segs.push({ text: rawText.slice(pos), state: 'kept' })

  return segs.length > 0 ? segs : [{ text: rawText, state: 'kept' }]
}

// -- Step 9.5: Gap attachment and neighbor-based kept_elsewhere --

function tryAttachToSpan(r, rawChunks, humanChunks, alignment, idf, usedRaw, ownership) {
  if (rawChunks[r].words.length > 15) return false
  // Never attach false_start or partial_abandoned chunks — they must remain isolated
  const attachOwnState = ownership.get(r)
  if (attachOwnState === 'false_start' || attachOwnState === 'partial_abandoned') return false

  for (let h = 0; h < humanChunks.length; h++) {
    const match = alignment[h]
    if (!match) continue
    if (r !== match.rawStart - 1 && r !== match.rawEnd + 1) continue

    const hEnd = match.hSpanEnd != null ? match.hSpanEnd : h
    const hWords = []
    for (let i = h; i <= hEnd; i++) hWords.push(...humanChunks[i].words)

    const curSpan = getSpanWords(rawChunks, match.rawStart, match.rawEnd)
    const extStart = Math.min(match.rawStart, r)
    const extEnd = Math.max(match.rawEnd, r)
    const extSpan = getSpanWords(rawChunks, extStart, extEnd)
    const gain = coverageOf(hWords, extSpan, idf) - coverageOf(hWords, curSpan, idf)

    if (gain >= -0.08) {
      if (r < match.rawStart) match.rawStart = r
      else match.rawEnd = r
      usedRaw.add(r)
      ownership.set(r, 'matched')
      match.score = spanMatchScore(extSpan, hWords, idf)
      return true
    }
  }
  return false
}

function getNeighborHumanWords(h, hEnd, humanChunks, radius = 2) {
  const words = new Set()
  for (let nh = Math.max(0, h - radius); nh <= Math.min(humanChunks.length - 1, hEnd + radius); nh++) {
    if (nh >= h && nh <= hEnd) continue
    for (const w of humanChunks[nh].words) words.add(w)
  }
  return words
}

// -- Step 10: Human-anchored display --

function buildComparison(rawContent, humanContent) {
  const rawChunks = chunkText(rawContent)
  const humanChunks = chunkText(humanContent)

  if (rawChunks.length === 0 && humanChunks.length === 0) return []
  if (rawChunks.length === 0) {
    return humanChunks.map(hc => ({
      raw: '', human: stripTimecodes(hc.original), label: 'new_in_edit',
      confidence: 100, marked: []
    }))
  }
  if (humanChunks.length === 0) {
    return [{ raw: rawContent, human: null, label: 'deleted', confidence: 100,
      marked: [{ text: rawContent, state: 'deleted' }] }]
  }

  const idf = computeIDF([...rawChunks, ...humanChunks])

  // Step 3.5: Detect false starts / self-repairs in raw
  const { groups: restartGroups, pairs: restartPairs } = detectRestartGroups(rawChunks)

  // Step 3.55: Boundary-overlap resolution into ranges
  const rangeEligibility = resolveBoundaryOverlaps(restartPairs, rawChunks)

  // Step 3.6: Canonical winner selection (range-aware)
  const eligibility = selectCanonicalWinners(restartGroups, rawChunks, rangeEligibility)

  // Step 5: Align (DP with transparent abandoned, range-aware eligibility)
  const { alignment, usedRaw } = globalAlign(rawChunks, humanChunks, idf, eligibility)

  // Step 5.25: Post-match span extension (respects eligibility)
  extendMatchedSpans(rawChunks, humanChunks, alignment, usedRaw, idf, eligibility)

  // Step 5.6: Global token ownership (now reflects extended spans)
  const ownership = initChunkOwnership(rawChunks, usedRaw, eligibility)

  // Step 6-7: Repair and detect moved (ownership-aware, absorbs false_start too)
  repairAlignment(rawChunks, humanChunks, alignment, usedRaw, idf, ownership)
  detectMovedContent(alignment, humanChunks, rawChunks, usedRaw, idf, ownership)

  // Build output: HUMAN-ANCHORED (human order is the spine)
  const rows = []
  const processedH = new Set()
  let lastRawEnd = -1

  for (let h = 0; h < humanChunks.length; h++) {
    if (processedH.has(h)) continue
    const match = alignment[h]

    if (match) {
      // Gap chunks between last match and this one — try adjacency attachment first
      if (!match.moved) {
        for (let r = lastRawEnd + 1; r < match.rawStart; r++) {
          const ownState = ownership.get(r)
          if (ownState === 'matched' || ownState === 'moved') continue
          // Try attaching to adjacent matched span before emitting as gap row
          if (tryAttachToSpan(r, rawChunks, humanChunks, alignment, idf, usedRaw, ownership)) continue
          let delParts = [rawChunks[r].original]
          const isFSLike = s => s === 'false_start' || s === 'partial_abandoned'
          let allFalseStart = isFSLike(ownership.get(r))
          while (r + 1 < match.rawStart) {
            const nextState = ownership.get(r + 1)
            if (nextState === 'matched' || nextState === 'moved') break
            if (tryAttachToSpan(r + 1, rawChunks, humanChunks, alignment, idf, usedRaw, ownership)) break
            r++
            delParts.push(rawChunks[r].original)
            if (!isFSLike(nextState)) allFalseStart = false
          }
          const delText = delParts.join('\n')
          const rowState = allFalseStart ? 'false_start' : 'deleted'
          rows.push({
            raw: delText, human: null, label: rowState,
            confidence: 100, marked: [{ text: delText, state: rowState }]
          })
        }
      }

      // Separate false_start/partial_abandoned chunks from clean chunks in the span
      const fsInSpan = []
      const cleanInSpan = []
      for (let ri = match.rawStart; ri <= match.rawEnd; ri++) {
        const ow = ownership.get(ri)
        if (ow === 'false_start' || ow === 'partial_abandoned') {
          fsInSpan.push(rawChunks[ri].original)
        } else {
          cleanInSpan.push(rawChunks[ri].original)
        }
      }

      // Emit false_start chunks as standalone gap rows (raw only, human blank)
      if (fsInSpan.length > 0) {
        const fsText = fsInSpan.join('\n')
        rows.push({
          raw: fsText, human: null, label: 'false_start',
          confidence: 100, marked: [{ text: fsText, state: 'false_start' }]
        })
      }

      // Combine human span
      const hEnd = match.hSpanEnd != null ? match.hSpanEnd : h
      const humanParts = []
      const humanWordList = []
      for (let hi = h; hi <= hEnd; hi++) {
        humanParts.push(stripTimecodes(humanChunks[hi].original))
        humanWordList.push(...humanChunks[hi].words)
        processedH.add(hi)
      }

      if (cleanInSpan.length > 0) {
        // Build match row with clean chunks only — LCS runs on clean text
        const rawCombined = cleanInSpan.join('\n')
        const neighborWords = getNeighborHumanWords(h, hEnd, humanChunks)
        const marked = computeOwnershipSegments(rawCombined, humanWordList, neighborWords)
        const cls = classifyMatch(match, h, rawChunks, humanChunks, idf, ownership)

        rows.push({
          raw: rawCombined,
          human: humanParts.join(' '),
          label: cls.label,
          confidence: cls.confidence,
          marked
        })
      } else {
        // All raw chunks were false starts — human chunk has no clean match
        rows.push({
          raw: '', human: humanParts.join(' '),
          label: 'new_in_edit', confidence: 100, marked: []
        })
      }

      if (!match.moved) lastRawEnd = match.rawEnd
    } else {
      // Unmatched human chunk — shown in-place
      processedH.add(h)
      rows.push({
        raw: '', human: stripTimecodes(humanChunks[h].original),
        label: 'new_in_edit', confidence: 100, marked: []
      })
    }
  }

  // Remaining raw after last match — try adjacency attachment first
  for (let r = lastRawEnd + 1; r < rawChunks.length; r++) {
    const ownState = ownership.get(r)
    if (ownState === 'matched' || ownState === 'moved') continue
    if (tryAttachToSpan(r, rawChunks, humanChunks, alignment, idf, usedRaw, ownership)) continue
    let delParts = [rawChunks[r].original]
    const isFSLike2 = s => s === 'false_start' || s === 'partial_abandoned'
    let allFalseStart = isFSLike2(ownership.get(r))
    while (r + 1 < rawChunks.length) {
      const nextState = ownership.get(r + 1)
      if (nextState === 'matched' || nextState === 'moved') break
      if (tryAttachToSpan(r + 1, rawChunks, humanChunks, alignment, idf, usedRaw, ownership)) break
      r++
      delParts.push(rawChunks[r].original)
      if (!isFSLike2(nextState)) allFalseStart = false
    }
    const delText = delParts.join('\n')
    const rowState = allFalseStart ? 'false_start' : 'deleted'
    rows.push({
      raw: delText, human: null, label: rowState,
      confidence: 100, marked: [{ text: delText, state: rowState }]
    })
  }

  return rows
}

// =============================================
// GLOBAL WORD-LEVEL ALIGNMENT V3
// =============================================

// -- V3 Phase 1: Dual-Track Tokenization --

function normalizeWordV3(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Tokenize raw transcript into flat word array with rawBlockId (timecode block) */
function tokenizeRawV3(text) {
  if (!text) return { tokens: [], blocks: new Map(), blockOrder: [] }
  const blocks = new Map()
  const blockOrder = []
  const tokens = []
  const parts = text.split(/(\[\d{2}:\d{2}:\d{2}\])/)
  let currentBlockId = '__pre'
  let currentBlockText = ''

  for (const part of parts) {
    if (/^\[\d{2}:\d{2}:\d{2}\]$/.test(part)) {
      if (currentBlockText.trim()) {
        blocks.set(currentBlockId, currentBlockText.trim())
        if (!blockOrder.includes(currentBlockId)) blockOrder.push(currentBlockId)
      }
      currentBlockId = part
      currentBlockText = ''
    } else {
      currentBlockText += part
      const wordRe = /[a-zA-Z0-9']+/g
      let m
      while ((m = wordRe.exec(part)) !== null) {
        const norm = normalizeWordV3(m[0])
        if (norm.length > 0) {
          tokens.push({ original: m[0], normalized: norm, rawBlockId: currentBlockId })
        }
      }
    }
  }
  if (currentBlockText.trim()) {
    blocks.set(currentBlockId, currentBlockText.trim())
    if (!blockOrder.includes(currentBlockId)) blockOrder.push(currentBlockId)
  }
  return { tokens, blocks, blockOrder }
}

/** Tokenize edited transcript into flat word array with source positions */
function tokenizeEditedV3(text) {
  if (!text) return { tokens: [], originalText: '' }
  const tokens = []
  const re = /[a-zA-Z0-9']+/g
  let m
  while ((m = re.exec(text)) !== null) {
    const norm = normalizeWordV3(m[0])
    if (norm.length > 0) {
      tokens.push({ original: m[0], normalized: norm, srcStart: m.index, srcEnd: m.index + m[0].length })
    }
  }
  return { tokens, originalText: text }
}

// -- V3 Phase 2: Global LCS with Fuzzy Equality --

function levenshteinDistV3(a, b) {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array(n + 1)
  let curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : Math.min(prev[j - 1], prev[j], curr[j - 1]) + 1
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

function fuzzyEqualV3(a, b) {
  if (a === b) return true
  if (a.length <= 2 || b.length <= 2) return false
  if (Math.abs(a.length - b.length) > 2) return false
  const maxLen = Math.max(a.length, b.length)
  return (levenshteinDistV3(a, b) / maxLen) <= 0.15
}

/**
 * Global LCS alignment with fuzzy word equality.
 * Falls back to greedy for large inputs (m*n > 10M).
 */
function globalAlignV3(rawTokens, editedTokens) {
  const m = rawTokens.length
  const n = editedTokens.length
  if (m === 0 && n === 0) return []
  if (m === 0) return editedTokens.map(t => ({ op: 'insert', editedToken: t }))
  if (n === 0) return rawTokens.map(t => ({ op: 'delete', rawToken: t }))

  if ((m * n) > 10_000_000) return greedyAlignV3(rawTokens, editedTokens)

  const dp = new Array(m + 1)
  for (let i = 0; i <= m; i++) dp[i] = new Array(n + 1).fill(0)
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (fuzzyEqualV3(rawTokens[i - 1].normalized, editedTokens[j - 1].normalized)) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  const ops = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && fuzzyEqualV3(rawTokens[i - 1].normalized, editedTokens[j - 1].normalized) && dp[i][j] === dp[i - 1][j - 1] + 1) {
      ops.unshift({ op: 'equal', rawToken: rawTokens[i - 1], editedToken: editedTokens[j - 1] })
      i--; j--
    } else if (i > 0 && (j === 0 || dp[i - 1][j] >= dp[i][j - 1])) {
      ops.unshift({ op: 'delete', rawToken: rawTokens[i - 1] })
      i--
    } else {
      ops.unshift({ op: 'insert', editedToken: editedTokens[j - 1] })
      j--
    }
  }
  return ops
}

/** Greedy forward alignment for very large inputs */
function greedyAlignV3(rawTokens, editedTokens) {
  const n = editedTokens.length
  const ops = []
  const editedIndex = new Map()
  for (let j = 0; j < n; j++) {
    const norm = editedTokens[j].normalized
    if (!editedIndex.has(norm)) editedIndex.set(norm, [])
    editedIndex.get(norm).push(j)
  }

  let lastJ = -1
  const matchedJ = new Set()

  for (let i = 0; i < rawTokens.length; i++) {
    const norm = rawTokens[i].normalized
    let bestJ = -1
    const candidates = editedIndex.get(norm) || []
    for (const j of candidates) {
      if (j > lastJ && !matchedJ.has(j)) { bestJ = j; break }
    }
    if (bestJ === -1) {
      for (let j = lastJ + 1; j < Math.min(lastJ + 50, n); j++) {
        if (!matchedJ.has(j) && fuzzyEqualV3(norm, editedTokens[j].normalized)) { bestJ = j; break }
      }
    }

    if (bestJ !== -1) {
      for (let j = lastJ + 1; j < bestJ; j++) {
        if (!matchedJ.has(j)) { ops.push({ op: 'insert', editedToken: editedTokens[j] }); matchedJ.add(j) }
      }
      ops.push({ op: 'equal', rawToken: rawTokens[i], editedToken: editedTokens[bestJ] })
      matchedJ.add(bestJ)
      lastJ = bestJ
    } else {
      ops.push({ op: 'delete', rawToken: rawTokens[i] })
    }
  }
  for (let j = lastJ + 1; j < n; j++) {
    if (!matchedJ.has(j)) ops.push({ op: 'insert', editedToken: editedTokens[j] })
  }
  return ops
}

// -- V3 Phase 3: Row Reconstruction --

function extractWordPositionsV3(text) {
  if (!text) return []
  const skipRanges = []
  const tcRe = /\[\d{2}:\d{2}:\d{2}\]/g
  const pRe = /\[\d+\.?\d*s\]/g
  let m
  while ((m = tcRe.exec(text)) !== null) skipRanges.push([m.index, m.index + m[0].length])
  while ((m = pRe.exec(text)) !== null) skipRanges.push([m.index, m.index + m[0].length])
  const words = []
  const wRe = /[a-zA-Z0-9']+/g
  while ((m = wRe.exec(text)) !== null) {
    if (skipRanges.some(([s, e]) => m.index >= s && m.index + m[0].length <= e)) continue
    const norm = normalizeWordV3(m[0])
    if (norm.length > 0) words.push({ start: m.index, end: m.index + m[0].length, norm })
  }
  return words
}

function mergeSegmentsV3(segments) {
  if (segments.length <= 1) return segments
  const merged = [{ ...segments[0] }]
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].state === merged[merged.length - 1].state) {
      merged[merged.length - 1].text += segments[i].text
    } else {
      merged.push({ ...segments[i] })
    }
  }
  return merged
}

/** Build styled segments for raw text, marking words as kept/deleted based on ops */
function buildRawSpans(rawText, blockOps) {
  const wordPos = extractWordPositionsV3(rawText)
  const rawOps = blockOps.filter(o => o.rawToken)
  if (wordPos.length === 0) return [{ text: rawText, state: 'kept' }]

  const segments = []
  let pos = 0
  for (let i = 0; i < wordPos.length; i++) {
    const wp = wordPos[i]
    if (wp.start > pos) segments.push({ text: rawText.slice(pos, wp.start), state: 'kept' })
    const state = (i < rawOps.length && rawOps[i].op === 'delete') ? 'deleted' : 'kept'
    segments.push({ text: rawText.slice(wp.start, wp.end), state })
    pos = wp.end
  }
  if (pos < rawText.length) segments.push({ text: rawText.slice(pos), state: 'kept' })
  return mergeSegmentsV3(segments)
}

/** Build styled segments for edited text slice based on ops */
function buildEditedSpans(editedOriginal, blockOps) {
  const tokenStates = []
  for (const op of blockOps) {
    if (op.editedToken) {
      tokenStates.push({ token: op.editedToken, state: op.op === 'equal' ? 'kept' : 'inserted' })
    }
  }
  if (tokenStates.length === 0) return []
  tokenStates.sort((a, b) => a.token.srcStart - b.token.srcStart)

  const minStart = tokenStates[0].token.srcStart
  const maxEnd = tokenStates[tokenStates.length - 1].token.srcEnd
  const segments = []
  let pos = minStart
  for (const { token, state } of tokenStates) {
    if (token.srcStart > pos) segments.push({ text: editedOriginal.slice(pos, token.srcStart), state: 'kept' })
    segments.push({ text: editedOriginal.slice(token.srcStart, token.srcEnd), state })
    pos = token.srcEnd
  }
  if (pos < maxEnd) segments.push({ text: editedOriginal.slice(pos, maxEnd), state: 'kept' })
  return mergeSegmentsV3(segments)
}

/**
 * Group alignment ops by rawBlockId and build display rows.
 * Rule A: >80% deletes & <3 equals → false_start
 * Rule B: significant equals → matched
 * Rule C: trailing inserts → inserted row
 */
function reconstructRowsV3(ops, rawBlocks, blockOrder, editedOriginal) {
  const opBlocks = new Array(ops.length).fill(null)
  let lastBlockId = null
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].rawToken) lastBlockId = ops[i].rawToken.rawBlockId
    opBlocks[i] = lastBlockId
  }
  let nextBlockId = null
  for (let i = ops.length - 1; i >= 0; i--) {
    if (opBlocks[i] !== null) nextBlockId = opBlocks[i]
    else opBlocks[i] = nextBlockId
  }

  const blockOpsMap = new Map()
  const trailingInserts = []
  for (let i = 0; i < ops.length; i++) {
    const blockId = opBlocks[i]
    if (!blockId) { trailingInserts.push(ops[i]); continue }
    if (!blockOpsMap.has(blockId)) blockOpsMap.set(blockId, [])
    blockOpsMap.get(blockId).push(ops[i])
  }

  const rows = []
  for (const blockId of blockOrder) {
    const bOps = blockOpsMap.get(blockId) || []
    if (bOps.length === 0) continue

    const equals = bOps.filter(o => o.op === 'equal')
    const deletes = bOps.filter(o => o.op === 'delete')
    const totalRaw = equals.length + deletes.length

    const rawText = rawBlocks.get(blockId) || ''
    const rawDisplayText = blockId !== '__pre' ? `${blockId} ${rawText}` : rawText

    // Rule A: False start — >80% deletes and <3 equals
    if (totalRaw > 0 && (deletes.length / totalRaw) > 0.8 && equals.length < 3) {
      rows.push({
        type: 'false_start', rawText: rawDisplayText, editedText: '',
        rawMarked: buildRawSpans(rawDisplayText, bOps), editMarked: [], similarity: 0
      })
      continue
    }

    // Rule B: Matched block
    if (equals.length > 0) {
      const editedTokens = bOps.filter(o => o.editedToken).map(o => o.editedToken)
      let editedText = ''
      if (editedTokens.length > 0) {
        const minStart = Math.min(...editedTokens.map(t => t.srcStart))
        const maxEnd = Math.max(...editedTokens.map(t => t.srcEnd))
        editedText = editedOriginal.slice(minStart, maxEnd)
      }
      const sim = totalRaw > 0 ? equals.length / totalRaw : 0
      rows.push({
        type: 'matched', rawText: rawDisplayText, editedText,
        rawMarked: buildRawSpans(rawDisplayText, bOps),
        editMarked: buildEditedSpans(editedOriginal, bOps),
        similarity: sim
      })
      continue
    }

    // All deletes, no matches
    rows.push({
      type: 'deleted', rawText: rawDisplayText, editedText: '',
      rawMarked: [{ text: rawDisplayText, state: 'deleted' }], editMarked: [], similarity: 0
    })
  }

  // Rule C: Trailing inserts
  const orphanInserts = trailingInserts.filter(o => o.op === 'insert')
  if (orphanInserts.length > 0) {
    const tokens = orphanInserts.map(o => o.editedToken)
    const minStart = Math.min(...tokens.map(t => t.srcStart))
    const maxEnd = Math.max(...tokens.map(t => t.srcEnd))
    const editedText = editedOriginal.slice(minStart, maxEnd)
    rows.push({
      type: 'inserted', rawText: '', editedText,
      rawMarked: [], editMarked: [{ text: editedText, state: 'inserted' }], similarity: 0
    })
  }

  return rows
}

// -- V3 Orchestrator --

function buildComparisonV3(rawContent, humanContent) {
  const rawData = tokenizeRawV3(rawContent)
  const editedData = tokenizeEditedV3(humanContent)
  if (rawData.tokens.length === 0 && editedData.tokens.length === 0) return []
  const ops = globalAlignV3(rawData.tokens, editedData.tokens)
  return reconstructRowsV3(ops, rawData.blocks, rawData.blockOrder, editedData.originalText)
}

// -- V3 UI Component --

function ComparisonPanelV3({ rawContent, humanContent }) {
  if (!rawContent && !humanContent) {
    return <div className="text-zinc-500 text-sm">No transcripts available for comparison.</div>
  }

  const rows = buildComparisonV3(rawContent, humanContent)

  const typeColors = {
    matched: 'bg-green-900/30 text-green-400',
    deleted: 'bg-red-900/30 text-red-400',
    inserted: 'bg-emerald-900/30 text-emerald-400',
    false_start: 'bg-purple-900/30 text-purple-400',
  }
  const typeNames = { matched: 'Matched', deleted: 'Deleted', inserted: 'Inserted', false_start: 'False Start' }

  const matched = rows.filter(r => r.type === 'matched')
  const avgSim = matched.length > 0
    ? Math.round(matched.reduce((s, r) => s + r.similarity, 0) / matched.length * 100)
    : 0

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-5 gap-3">
        <StatCard label="Matched" value={matched.length} color="text-green-400" />
        <StatCard label="False Starts" value={rows.filter(r => r.type === 'false_start').length} color="text-purple-400" />
        <StatCard label="Deleted" value={rows.filter(r => r.type === 'deleted').length} color="text-red-400" />
        <StatCard label="Inserted" value={rows.filter(r => r.type === 'inserted').length} color="text-emerald-400" />
        <StatCard label="Avg Match" value={`${avgSim}%`} color={simColor(avgSim)} />
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="grid grid-cols-2 border-b border-zinc-800 text-xs text-zinc-400 font-medium">
          <div className="px-3 py-2 border-r border-zinc-800">Raw Transcript</div>
          <div className="px-3 py-2">Human Edited</div>
        </div>

        <div className="max-h-[75vh] overflow-auto">
          {rows.map((row, i) => (
            <div key={i} className={`grid grid-cols-2 ${i > 0 ? 'border-t border-zinc-800/30' : ''}`}>
              <div className={`px-3 py-1.5 border-r border-zinc-800/50 text-xs font-mono whitespace-pre-wrap leading-relaxed ${row.type === 'inserted' ? 'bg-zinc-950/50' : ''}`}>
                {row.rawText ? (
                  <>
                    <span className={`inline-block text-[10px] font-sans font-medium px-1.5 py-0.5 rounded mb-1 ${typeColors[row.type]}`}>
                      {typeNames[row.type]}{row.type === 'matched' ? ` ${Math.round(row.similarity * 100)}%` : ''}
                    </span>
                    <br />
                    {renderV3Segments(row.rawMarked)}
                  </>
                ) : (
                  <span className="text-zinc-700 italic">—</span>
                )}
              </div>
              <div className={`px-3 py-1.5 text-xs font-mono whitespace-pre-wrap leading-relaxed ${(row.type === 'deleted' || row.type === 'false_start') ? 'bg-zinc-950/50' : ''}`}>
                {row.editedText ? (
                  <>
                    {row.type === 'inserted' && (
                      <>
                        <span className={`inline-block text-[10px] font-sans font-medium px-1.5 py-0.5 rounded mb-1 ${typeColors.inserted}`}>Inserted</span>
                        <br />
                      </>
                    )}
                    {renderV3Segments(row.editMarked)}
                  </>
                ) : (
                  <span className="text-zinc-700 italic">—</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Render V3 styled segments with timecode/pause highlighting */
function renderV3Segments(segments) {
  if (!segments || segments.length === 0) return null
  const stateStyles = {
    kept: '',
    deleted: 'bg-red-900/40 text-red-300 line-through',
    inserted: 'bg-emerald-900/40 text-emerald-300',
  }
  return segments.map((seg, j) => {
    const cls = stateStyles[seg.state] || ''
    const parts = seg.text.split(/(\[\d{2}:\d{2}:\d{2}\]|\[\d+\.?\d*s\])/g)
    return (
      <span key={j} className={cls}>
        {parts.map((part, k) => {
          if (/^\[\d{2}:\d{2}:\d{2}\]$/.test(part)) return <span key={k} className="text-blue-400">{part}</span>
          if (/^\[\d+\.?\d*s\]$/.test(part)) return <span key={k} className="text-amber-400 bg-amber-900/20 px-0.5 rounded">{part}</span>
          return part
        })}
      </span>
    )
  })
}

// =============================================
// GLOBAL WORD-LEVEL ALIGNMENT V4
// "Destroy boundaries, align globally, reconstruct"
// =============================================

// -- V4 Phase 1: Dual-Track Tokenization --

/**
 * Normalize a word for comparison: lowercase, strip all non-alphanumeric.
 * "S-Corporation," → "scorporation"
 */
function v4Normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Parse raw transcript into a flat Token array.
 * Every word carries its rawBlockId (the timecode it belongs to).
 * Also returns block metadata for reconstruction.
 */
function v4TokenizeRaw(text) {
  if (!text) return { tokens: [], blockTexts: new Map(), blockOrder: [] }

  const blockTexts = new Map()
  const blockOrder = []
  const tokens = []

  // Split keeping timecodes as delimiters
  const segments = text.split(/(\[\d{2}:\d{2}:\d{2}\])/)
  let activeBlock = '__pre'
  let blockBuf = ''

  for (const seg of segments) {
    if (/^\[\d{2}:\d{2}:\d{2}\]$/.test(seg)) {
      // Flush previous block
      if (blockBuf.trim()) {
        blockTexts.set(activeBlock, blockBuf.trim())
        if (!blockOrder.includes(activeBlock)) blockOrder.push(activeBlock)
      }
      activeBlock = seg
      blockBuf = ''
    } else {
      blockBuf += seg
      // Extract every word from this segment
      const re = /[a-zA-Z0-9']+/g
      let m
      while ((m = re.exec(seg)) !== null) {
        const norm = v4Normalize(m[0])
        if (norm) tokens.push({ original: m[0], normalized: norm, rawBlockId: activeBlock })
      }
    }
  }
  // Flush final block
  if (blockBuf.trim()) {
    blockTexts.set(activeBlock, blockBuf.trim())
    if (!blockOrder.includes(activeBlock)) blockOrder.push(activeBlock)
  }

  return { tokens, blockTexts, blockOrder }
}

/**
 * Parse edited transcript into a flat Token array.
 * Every word carries its character position in the original string (for slicing later).
 */
function v4TokenizeEdited(text) {
  if (!text) return { tokens: [], source: '' }

  // Build skip ranges for timecodes and pause markers so their digits
  // don't become junk tokens that poison the LCS alignment
  const skip = []
  const tcRe = /\[\d{2}:\d{2}:\d{2}\]/g
  const pRe = /\[\d+\.?\d*s\]/g
  let m
  while ((m = tcRe.exec(text)) !== null) skip.push([m.index, m.index + m[0].length])
  while ((m = pRe.exec(text)) !== null) skip.push([m.index, m.index + m[0].length])

  const tokens = []
  const re = /[a-zA-Z0-9']+/g
  while ((m = re.exec(text)) !== null) {
    if (skip.some(([s, e]) => m.index >= s && m.index + m[0].length <= e)) continue
    const norm = v4Normalize(m[0])
    if (norm) {
      tokens.push({
        original: m[0],
        normalized: norm,
        rawBlockId: null,
        srcStart: m.index,
        srcEnd: m.index + m[0].length,
      })
    }
  }
  return { tokens, source: text }
}

// -- V4 Phase 2: Global Sequence Alignment --

/** Space-optimized Levenshtein distance */
function v4EditDist(a, b) {
  if (a === b) return 0
  const la = a.length, lb = b.length
  if (!la) return lb
  if (!lb) return la
  let prev = new Array(lb + 1)
  let curr = new Array(lb + 1)
  for (let j = 0; j <= lb; j++) prev[j] = j
  for (let i = 1; i <= la; i++) {
    curr[0] = i
    for (let j = 1; j <= lb; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1])
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[lb]
}

/**
 * Fuzzy equality: >85% similarity.
 * Short words (≤2 chars) require exact match.
 * Length difference >2 chars = instant reject.
 */
function v4FuzzyEq(a, b) {
  if (a === b) return true
  if (a.length <= 2 || b.length <= 2) return false
  if (Math.abs(a.length - b.length) > 2) return false
  return (v4EditDist(a, b) / Math.max(a.length, b.length)) <= 0.15
}

/**
 * Global LCS alignment producing an operation stream.
 * Standard DP for manageable sizes; greedy fallback for large inputs.
 */
function v4Align(rawToks, editToks) {
  const m = rawToks.length, n = editToks.length
  if (!m && !n) return []
  if (!m) return editToks.map(t => ({ op: 'insert', editedToken: t }))
  if (!n) return rawToks.map(t => ({ op: 'delete', rawToken: t }))

  // Greedy fallback for very large inputs
  if (m * n > 10_000_000) return v4GreedyAlign(rawToks, editToks)

  // Standard LCS DP
  const dp = []
  for (let i = 0; i <= m; i++) {
    dp[i] = new Uint32Array(n + 1) // zero-initialized
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = v4FuzzyEq(rawToks[i - 1].normalized, editToks[j - 1].normalized)
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  // Backtrack
  const ops = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0
      && v4FuzzyEq(rawToks[i - 1].normalized, editToks[j - 1].normalized)
      && dp[i][j] === dp[i - 1][j - 1] + 1) {
      ops.push({ op: 'equal', rawToken: rawToks[i - 1], editedToken: editToks[j - 1] })
      i--; j--
    } else if (i > 0 && (j === 0 || dp[i - 1][j] >= dp[i][j - 1])) {
      ops.push({ op: 'delete', rawToken: rawToks[i - 1] })
      i--
    } else {
      ops.push({ op: 'insert', editedToken: editToks[j - 1] })
      j--
    }
  }
  ops.reverse()
  return ops
}

/** Greedy forward-matching alignment for inputs too large for DP */
function v4GreedyAlign(rawToks, editToks) {
  const n = editToks.length
  // Index edited tokens by normalized form for O(1) lookup
  const idx = new Map()
  for (let j = 0; j < n; j++) {
    const k = editToks[j].normalized
    if (!idx.has(k)) idx.set(k, [])
    idx.get(k).push(j)
  }

  const ops = []
  let lastJ = -1
  const used = new Set()

  for (const rt of rawToks) {
    let bestJ = -1
    // Exact lookup
    const cands = idx.get(rt.normalized) || []
    for (const j of cands) {
      if (j > lastJ && !used.has(j)) { bestJ = j; break }
    }
    // Fuzzy scan (narrow window)
    if (bestJ === -1) {
      const lo = lastJ + 1, hi = Math.min(lo + 50, n)
      for (let j = lo; j < hi; j++) {
        if (!used.has(j) && v4FuzzyEq(rt.normalized, editToks[j].normalized)) { bestJ = j; break }
      }
    }

    if (bestJ !== -1) {
      // Emit inserts for skipped edited tokens
      for (let j = lastJ + 1; j < bestJ; j++) {
        if (!used.has(j)) { ops.push({ op: 'insert', editedToken: editToks[j] }); used.add(j) }
      }
      ops.push({ op: 'equal', rawToken: rt, editedToken: editToks[bestJ] })
      used.add(bestJ)
      lastJ = bestJ
    } else {
      ops.push({ op: 'delete', rawToken: rt })
    }
  }
  // Remaining edited tokens
  for (let j = lastJ + 1; j < n; j++) {
    if (!used.has(j)) ops.push({ op: 'insert', editedToken: editToks[j] })
  }
  return ops
}

// -- V4 Phase 2.5: Contiguity Consolidation Pass --

/**
 * Fix the "Greedy Tie-Breaker Bug" on false starts.
 *
 * Problem: When the speaker repeats themselves, LCS can match the PREFIX
 * of take 1 and the SUFFIX of take 2, stitching one match across two
 * raw blocks. Both blocks end up partially matched, so neither triggers
 * Rule A (>80% delete = false start).
 *
 * Solution: Scan for fragmented matches across block boundaries.
 * If block A has equals whose words also appear as deletes in a later
 * block B, shift the matches to B (the contiguous take) and convert
 * A's matches to deletes. After the shift, block A becomes 100% delete
 * → triggers Rule A; block B gets the full contiguous match → Rule B.
 */
function v4ContiguityPass(ops) {
  if (ops.length < 3) return ops
  const out = ops.map(o => ({ ...o }))

  // Step 1: Find equal-runs — maximal consecutive equal ops in the same block
  const runs = []
  for (let i = 0; i < out.length; i++) {
    if (out[i].op !== 'equal') continue
    const bid = out[i].rawToken.rawBlockId
    const last = runs.length ? runs[runs.length - 1] : null
    if (last && last.bid === bid && last.end === i - 1) {
      last.end = i
    } else {
      runs.push({ bid, start: i, end: i })
    }
  }

  // Step 2: For each pair of equal-runs in DIFFERENT blocks, check for
  //         fragmented matches (look ahead up to 5 runs for non-adjacent blocks)
  for (let a = 0; a < runs.length; a++) {
    for (let b = a + 1; b < Math.min(a + 6, runs.length); b++) {
      const rA = runs[a]
      const rB = runs[b]
      if (rA.bid === rB.bid) continue

      // Gather A's equal indices that haven't already been shifted
      const aIdxs = []
      for (let i = rA.start; i <= rA.end; i++) {
        if (out[i].op === 'equal') aIdxs.push(i)
      }
      if (aIdxs.length === 0) continue

      // In the gap between the two runs, find deletes belonging to rB's block
      const gapDels = []
      for (let i = rA.end + 1; i < rB.start; i++) {
        if (out[i].op === 'delete' && out[i].rawToken.rawBlockId === rB.bid) {
          gapDels.push(i)
        }
      }
      if (gapDels.length === 0) continue

      // Step 3: Overlap check — do A's equaled words appear in B's deletes?
      const delNorms = gapDels.map(i => out[i].rawToken.normalized)
      let overlap = 0
      for (const ai of aIdxs) {
        const n = out[ai].rawToken.normalized
        if (delNorms.some(dn => n === dn || v4FuzzyEq(n, dn))) overlap++
      }
      if (overlap / aIdxs.length < 0.5) continue

      // Step 4: Shift — transfer editedTokens from A's equals to B's deletes
      const pool = aIdxs.map(i => ({
        idx: i,
        norm: out[i].rawToken.normalized,
        editedToken: out[i].editedToken,
      }))

      for (const di of gapDels) {
        const dn = out[di].rawToken.normalized
        const pi = pool.findIndex(p => p.editedToken && (p.norm === dn || v4FuzzyEq(p.norm, dn)))
        if (pi === -1) continue

        const p = pool.splice(pi, 1)[0]
        // A's equal → delete (strip editedToken)
        out[p.idx] = { op: 'delete', rawToken: out[p.idx].rawToken }
        // B's delete → equal (attach editedToken)
        out[di] = { op: 'equal', rawToken: out[di].rawToken, editedToken: p.editedToken }
      }
    }
  }

  return out
}

// -- V4 Phase 2.6: Repeated Take Evaluator --

/**
 * If multiple takes exist, pick the one that matches the Edited text best.
 * If they match equally well, pick the latest take.
 *
 * Scans for: large equal block (Take 1) followed by a large delete block (Take 2)
 * whose raw words are highly similar. Scores both takes against the edited tokens
 * and swaps only if Take 2 scores >= Take 1.
 */
function v4RepeatedTakeEval(ops) {
  if (ops.length < 20) return ops
  const out = ops.map(o => ({ ...o }))

  // Build runs of consecutive same-op types
  const runs = []
  let rStart = 0
  for (let i = 1; i <= out.length; i++) {
    if (i === out.length || out[i].op !== out[i - 1].op) {
      runs.push({ op: out[rStart].op, start: rStart, end: i - 1 })
      rStart = i
    }
  }

  // Scan for: large EQUAL run (Take 1) ... large DELETE run (Take 2)
  for (let r = 0; r < runs.length; r++) {
    const take1Run = runs[r]
    if (take1Run.op !== 'equal') continue
    const take1Len = take1Run.end - take1Run.start + 1
    if (take1Len < 15) continue

    // Look ahead (up to 3 intervening runs) for a large delete run
    for (let g = r + 1; g < Math.min(r + 4, runs.length); g++) {
      const take2Run = runs[g]
      if (take2Run.op !== 'delete') continue
      const take2Len = take2Run.end - take2Run.start + 1
      if (take2Len < 10) continue

      // Step 1: Are the raw words similar? (bag-of-words overlap)
      const t1Words = []
      for (let i = take1Run.start; i <= take1Run.end; i++) t1Words.push(out[i].rawToken.normalized)
      const t2Words = []
      for (let i = take2Run.start; i <= take2Run.end; i++) t2Words.push(out[i].rawToken.normalized)

      const t2Bag = new Map()
      for (const w of t2Words) t2Bag.set(w, (t2Bag.get(w) || 0) + 1)
      let rawOverlap = 0
      const used = new Map()
      for (const w of t1Words) {
        const avail = (t2Bag.get(w) || 0) - (used.get(w) || 0)
        if (avail > 0) { rawOverlap++; used.set(w, (used.get(w) || 0) + 1) }
        else {
          for (const [dw, cnt] of t2Bag) {
            if ((cnt - (used.get(dw) || 0)) > 0 && v4FuzzyEq(w, dw)) {
              rawOverlap++; used.set(dw, (used.get(dw) || 0) + 1); break
            }
          }
        }
      }
      if (rawOverlap / t1Words.length < 0.7) continue // not a repeated take

      // Step 2: Score both takes against the edited tokens
      // Take 1's edited tokens (already matched by the algorithm)
      const editedNorms = []
      for (let i = take1Run.start; i <= take1Run.end; i++) {
        editedNorms.push(out[i].editedToken.normalized)
      }

      // Score = fraction of edited words that fuzzy-match the take's raw words
      function scoreTake(rawWords, editedWords) {
        const rBag = new Map()
        for (const w of rawWords) rBag.set(w, (rBag.get(w) || 0) + 1)
        let hits = 0
        const u = new Map()
        for (const ew of editedWords) {
          const avail = (rBag.get(ew) || 0) - (u.get(ew) || 0)
          if (avail > 0) { hits++; u.set(ew, (u.get(ew) || 0) + 1) }
          else {
            for (const [rw, cnt] of rBag) {
              if ((cnt - (u.get(rw) || 0)) > 0 && v4FuzzyEq(ew, rw)) {
                hits++; u.set(rw, (u.get(rw) || 0) + 1); break
              }
            }
          }
        }
        return editedWords.length > 0 ? hits / editedWords.length : 0
      }

      const score1 = scoreTake(t1Words, editedNorms)
      const score2 = scoreTake(t2Words, editedNorms)

      // Step 3: Resolution — swap only if Take 2 is >= Take 1
      if (score2 < score1) continue

      // Build ordered queue of editedTokens from Take 1
      const editedQueue = []
      for (let i = take1Run.start; i <= take1Run.end; i++) {
        editedQueue.push({ idx: i, norm: out[i].rawToken.normalized, editedToken: out[i].editedToken })
      }

      // Walk Take 2's deletes, matching words to consume editedTokens
      let qi = 0
      for (let i = take2Run.start; i <= take2Run.end && qi < editedQueue.length; i++) {
        const dn = out[i].rawToken.normalized
        let found = -1
        for (let q = qi; q < Math.min(qi + 5, editedQueue.length); q++) {
          if (editedQueue[q].norm === dn || v4FuzzyEq(editedQueue[q].norm, dn)) { found = q; break }
        }
        if (found === -1) continue

        // Convert Take 1 equal → delete, Take 2 delete → equal
        for (let q = qi; q < found; q++) {
          out[editedQueue[q].idx] = { op: 'delete', rawToken: out[editedQueue[q].idx].rawToken }
        }
        const src = editedQueue[found]
        out[src.idx] = { op: 'delete', rawToken: out[src.idx].rawToken }
        out[i] = { op: 'equal', rawToken: out[i].rawToken, editedToken: src.editedToken }
        qi = found + 1
      }
      // Remaining unmatched Take 1 equals → deletes
      for (let q = qi; q < editedQueue.length; q++) {
        out[editedQueue[q].idx] = { op: 'delete', rawToken: out[editedQueue[q].idx].rawToken }
      }

      break // one swap per equal run
    }
  }

  return out
}

// -- V4 Phase 3: UI Block Reconstruction --

/**
 * The magic step: group the flat operation stream back into
 * rows keyed by rawBlockId, then classify each block.
 */
function v4ReconstructRows(ops, blockTexts, blockOrder, editedSource) {
  // 1. Assign every op to a block
  const assignments = new Array(ops.length).fill(null)
  let active = null
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].rawToken) active = ops[i].rawToken.rawBlockId
    assignments[i] = active
  }
  // Backward pass: assign leading inserts to the first block they precede
  let next = null
  for (let i = ops.length - 1; i >= 0; i--) {
    if (assignments[i] !== null) next = assignments[i]
    else assignments[i] = next
  }

  // 2. Group ops by block
  const groups = new Map()
  const orphans = []
  for (let i = 0; i < ops.length; i++) {
    const bid = assignments[i]
    if (!bid) { orphans.push(ops[i]); continue }
    if (!groups.has(bid)) groups.set(bid, [])
    groups.get(bid).push(ops[i])
  }

  // 3. Process each block in order → rows
  const rows = []

  for (const bid of blockOrder) {
    const bOps = groups.get(bid)
    if (!bOps || bOps.length === 0) continue

    const eqs = bOps.filter(o => o.op === 'equal')
    const dels = bOps.filter(o => o.op === 'delete')
    const ins = bOps.filter(o => o.op === 'insert')
    const totalRaw = eqs.length + dels.length

    // Original raw text with timecode prefix
    const rawBody = blockTexts.get(bid) || ''
    const rawDisplay = bid !== '__pre' ? `${bid} ${rawBody}` : rawBody

    // -- Rule A: False Start / Cut Footage --
    if (totalRaw > 0 && dels.length / totalRaw > 0.8 && eqs.length < 3) {
      rows.push({
        id: bid,
        type: 'false_start_gap',
        rawText: rawDisplay,
        editedText: null,
        rawSpans: v4BuildRawWordSpans(rawDisplay, bOps),
        editSpans: null,
      })
      continue
    }

    // -- Rule B: Matched block --
    if (eqs.length > 0) {
      // Reconstruct edited slice from srcStart/srcEnd of participating edited tokens
      const eToks = bOps.filter(o => o.editedToken).map(o => o.editedToken)
      let editedSlice = ''
      let editSpans = []
      if (eToks.length > 0) {
        const lo = Math.min(...eToks.map(t => t.srcStart))
        const hi = Math.max(...eToks.map(t => t.srcEnd))
        editedSlice = v4SanitizeEdited(editedSource.slice(lo, hi)).trim()
        editSpans = v4BuildEditedWordSpans(editedSource, bOps)
      }
      rows.push({
        id: bid,
        type: 'matched',
        rawText: rawDisplay,
        editedText: editedSlice,
        rawSpans: v4BuildRawWordSpans(rawDisplay, bOps),
        editSpans,
        similarity: totalRaw > 0 ? eqs.length / totalRaw : 0,
      })
      continue
    }

    // All deletes, zero equals
    rows.push({
      id: bid,
      type: 'false_start_gap',
      rawText: rawDisplay,
      editedText: null,
      rawSpans: [{ text: rawDisplay, state: 'deleted' }],
      editSpans: null,
    })
  }

  // -- Rule C: Massive orphan inserts --
  const oIns = orphans.filter(o => o.op === 'insert')
  if (oIns.length > 0) {
    const toks = oIns.map(o => o.editedToken)
    const lo = Math.min(...toks.map(t => t.srcStart))
    const hi = Math.max(...toks.map(t => t.srcEnd))
    rows.push({
      id: '__inserted',
      type: 'inserted_gap',
      rawText: null,
      editedText: editedSource.slice(lo, hi),
      rawSpans: null,
      editSpans: [{ text: editedSource.slice(lo, hi), state: 'inserted' }],
    })
  }

  // Also check: for matched blocks, if trailing inserts within a block form a big
  // chunk (>15 words), split them out as a separate inserted_gap row.
  // (We do a post-pass to avoid complicating the main loop.)
  const finalRows = []
  for (const row of rows) {
    finalRows.push(row)
    if (row.type === 'matched') {
      const bOps = groups.get(row.id) || []
      // Find trailing inserts in this block
      let trailStart = -1
      for (let k = bOps.length - 1; k >= 0; k--) {
        if (bOps[k].op === 'insert') trailStart = k
        else break
      }
      if (trailStart !== -1 && (bOps.length - trailStart) > 15) {
        const trailOps = bOps.slice(trailStart)
        const toks = trailOps.map(o => o.editedToken)
        const lo = Math.min(...toks.map(t => t.srcStart))
        const hi = Math.max(...toks.map(t => t.srcEnd))
        finalRows.push({
          id: `${row.id}__trail`,
          type: 'inserted_gap',
          rawText: null,
          editedText: editedSource.slice(lo, hi),
          rawSpans: null,
          editSpans: [{ text: editedSource.slice(lo, hi), state: 'inserted' }],
        })
      }
    }
  }

  return finalRows
}

// -- V4 Word Span Builders --

/** Extract word positions from text, skipping timecodes and pause markers */
function v4ExtractWordPositions(text) {
  if (!text) return []
  const skip = []
  let m
  const tcR = /\[\d{2}:\d{2}:\d{2}\]/g
  while ((m = tcR.exec(text)) !== null) skip.push([m.index, m.index + m[0].length])
  const pR = /\[\d+\.?\d*s\]/g
  while ((m = pR.exec(text)) !== null) skip.push([m.index, m.index + m[0].length])

  const words = []
  const wR = /[a-zA-Z0-9']+/g
  while ((m = wR.exec(text)) !== null) {
    if (skip.some(([s, e]) => m.index >= s && m.index + m[0].length <= e)) continue
    const norm = v4Normalize(m[0])
    if (norm) words.push({ start: m.index, end: m.index + m[0].length, norm })
  }
  return words
}

/** Build word-level spans for the raw side of a row */
function v4BuildRawWordSpans(rawText, blockOps) {
  const wps = v4ExtractWordPositions(rawText)
  const rawOps = blockOps.filter(o => o.rawToken)
  if (!wps.length) return [{ text: rawText, state: 'kept' }]

  const segs = []
  let pos = 0
  for (let i = 0; i < wps.length; i++) {
    const wp = wps[i]
    if (wp.start > pos) segs.push({ text: rawText.slice(pos, wp.start), state: 'kept' })
    const st = (i < rawOps.length && rawOps[i].op === 'delete') ? 'deleted' : 'kept'
    segs.push({ text: rawText.slice(wp.start, wp.end), state: st })
    pos = wp.end
  }
  if (pos < rawText.length) segs.push({ text: rawText.slice(pos), state: 'kept' })
  return v4MergeSpans(segs)
}

/** Build word-level spans for the edited side of a row */
function v4BuildEditedWordSpans(editedSource, blockOps) {
  const pairs = []
  for (const op of blockOps) {
    if (op.editedToken) {
      pairs.push({ tok: op.editedToken, state: op.op === 'equal' ? 'kept' : 'inserted' })
    }
  }
  if (!pairs.length) return []
  pairs.sort((a, b) => a.tok.srcStart - b.tok.srcStart)

  const lo = pairs[0].tok.srcStart
  const hi = pairs[pairs.length - 1].tok.srcEnd
  const segs = []
  let pos = lo
  for (const { tok, state } of pairs) {
    if (tok.srcStart > pos) {
      const gap = v4SanitizeEdited(editedSource.slice(pos, tok.srcStart))
      if (gap) segs.push({ text: gap, state: 'kept' })
    }
    segs.push({ text: tok.original, state })
    pos = tok.srcEnd
  }
  if (pos < hi) {
    const tail = v4SanitizeEdited(editedSource.slice(pos, hi))
    if (tail) segs.push({ text: tail, state: 'kept' })
  }
  return v4MergeSpans(segs)
}

/** Sanitize edited text: strip newlines, edited timecodes, collapse whitespace */
function v4SanitizeEdited(text) {
  if (!text) return ''
  return text
    .replace(/[\n\r]+/g, ' ')
    .replace(/\[\d{2}:\d{2}:\d{2}\]/g, ' ')
    .replace(/\s{2,}/g, ' ')
}

/** Merge adjacent spans with the same state */
function v4MergeSpans(segs) {
  if (segs.length <= 1) return segs
  const out = [{ ...segs[0] }]
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].state === out[out.length - 1].state) {
      out[out.length - 1].text += segs[i].text
    } else {
      out.push({ ...segs[i] })
    }
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════
// V4 Pipeline (original)
// ═══════════════════════════════════════════════════════════════════════

// -- V4 Phase 2.7: Repair Orphaned Edited Tokens --

/**
 * Phase 2.5/2.6 can convert equal ops to delete ops, dropping their
 * editedTokens. If the word exists in the edited text but no op carries
 * it, it vanishes from the display. This repair pass detects any such
 * orphaned editedTokens and re-inserts them as insert ops so they
 * appear in the correct block's edited column.
 */
function v4RepairOrphanedEdits(ops, allEditedTokens) {
  if (!allEditedTokens.length) return ops

  const present = new Set()
  for (const op of ops) {
    if (op.editedToken) present.add(op.editedToken.srcStart)
  }

  const missing = allEditedTokens.filter(t => !present.has(t.srcStart))
  if (!missing.length) return ops

  missing.sort((a, b) => a.srcStart - b.srcStart)

  const result = [...ops]
  // Insert in reverse order so earlier splices don't shift later indices
  for (let mi = missing.length - 1; mi >= 0; mi--) {
    const tok = missing[mi]
    // Place after the last op whose editedToken.srcStart < this token's
    let insertAt = result.length
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].editedToken && result[i].editedToken.srcStart < tok.srcStart) {
        insertAt = i + 1
        break
      }
    }
    result.splice(insertAt, 0, { op: 'insert', editedToken: tok })
  }

  return result
}

// -- V4 Orchestrator --

function buildAlignmentV4(rawContent, humanContent) {
  const raw = v4TokenizeRaw(rawContent)
  const edited = v4TokenizeEdited(humanContent)
  if (!raw.tokens.length && !edited.tokens.length) return []

  // Phase 2: Global forward alignment
  const rawOps = v4Align(raw.tokens, edited.tokens)
  // Phase 2.5: Consolidate fragmented cross-block matches
  const consolidated = v4ContiguityPass(rawOps)
  // Phase 2.6: If repeated takes exist, pick the best match (latest wins ties)
  const swapped = v4RepeatedTakeEval(consolidated)
  // Phase 2.7: Re-insert any editedTokens orphaned by Phase 2.5/2.6
  const ops = v4RepairOrphanedEdits(swapped, edited.tokens)
  return v4ReconstructRows(ops, raw.blockTexts, raw.blockOrder, edited.source)
}

// -- V4 UI Component --

function ComparisonPanelV4({ rawContent, humanContent }) {
  if (!rawContent && !humanContent) {
    return <div className="text-zinc-500 text-sm">No transcripts available for comparison.</div>
  }

  const rows = buildAlignmentV4(rawContent, humanContent)

  const badgeStyle = {
    matched: 'bg-green-900/30 text-green-400',
    false_start_gap: 'bg-purple-900/30 text-purple-400',
    inserted_gap: 'bg-emerald-900/30 text-emerald-400',
  }
  const badgeLabel = {
    matched: 'Matched',
    false_start_gap: 'False Start',
    inserted_gap: 'Inserted',
  }

  const matched = rows.filter(r => r.type === 'matched')
  const avgSim = matched.length > 0
    ? Math.round(matched.reduce((s, r) => s + (r.similarity || 0), 0) / matched.length * 100)
    : 0

  const [copied, setCopied] = useState(null)
  const copyText = (text, label) => {
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="grid grid-cols-5 gap-3 flex-1">
          <StatCard label="Matched" value={matched.length} color="text-green-400" />
          <StatCard label="False Starts" value={rows.filter(r => r.type === 'false_start_gap').length} color="text-purple-400" />
          <StatCard label="Inserted" value={rows.filter(r => r.type === 'inserted_gap').length} color="text-emerald-400" />
          <StatCard label="Avg Match" value={`${avgSim}%`} color={simColor(avgSim)} />
          <StatCard label="Total Rows" value={rows.length} color="text-zinc-400" />
        </div>
        <div className="flex gap-2 ml-3 shrink-0">
          <button
            onClick={() => copyText(rawContent, 'raw')}
            disabled={!rawContent}
            className="text-xs px-3 py-1.5 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors disabled:opacity-30"
          >
            {copied === 'raw' ? 'Copied!' : 'Copy Raw'}
          </button>
          <button
            onClick={() => copyText(humanContent, 'human')}
            disabled={!humanContent}
            className="text-xs px-3 py-1.5 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors disabled:opacity-30"
          >
            {copied === 'human' ? 'Copied!' : 'Copy Human Edited'}
          </button>
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="max-h-[75vh] overflow-auto">
          <table className="w-full border-collapse">
            <colgroup>
              <col className="w-1/2" />
              <col className="w-1/2" />
            </colgroup>
            <thead className="sticky top-0 bg-zinc-900 z-10">
              <tr className="border-b border-zinc-800">
                <th className="px-3 py-2 text-left text-xs text-zinc-400 font-medium border-r border-zinc-800">Raw Transcript</th>
                <th className="px-3 py-2 text-left text-xs text-zinc-400 font-medium">Human Edited</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.id + i} className={`align-top ${i > 0 ? 'border-t border-zinc-800/30' : ''}`}>
                  <td className={`px-3 py-1.5 border-r border-zinc-800/50 text-xs font-mono whitespace-pre-wrap leading-relaxed ${row.type === 'inserted_gap' ? 'bg-zinc-950/50' : ''}`}>
                    {row.rawText ? (
                      <>
                        <span className={`inline-block text-[10px] font-sans font-medium px-1.5 py-0.5 rounded mb-1 ${badgeStyle[row.type]}`}>
                          {badgeLabel[row.type]}{row.type === 'matched' && row.similarity != null ? ` ${Math.round(row.similarity * 100)}%` : ''}
                        </span>
                        <br />
                        {v4RenderSpans(row.rawSpans)}
                      </>
                    ) : (
                      <span className="text-zinc-700 italic">—</span>
                    )}
                  </td>
                  <td className={`px-3 py-1.5 text-xs font-mono leading-relaxed ${row.type === 'false_start_gap' ? 'bg-zinc-950/50' : ''}`}>
                    {row.editedText ? (
                      <>
                        {row.type === 'inserted_gap' && (
                          <>
                            <span className={`inline-block text-[10px] font-sans font-medium px-1.5 py-0.5 rounded mb-1 ${badgeStyle.inserted_gap}`}>Inserted</span>
                            <br />
                          </>
                        )}
                        {v4RenderSpans(row.editSpans)}
                      </>
                    ) : (
                      <span className="text-zinc-700 italic">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/** Render word spans with timecode/pause highlighting */
function v4RenderSpans(spans) {
  if (!spans || !spans.length) return null
  const styCls = {
    kept: '',
    deleted: 'bg-red-900/40 text-red-300 line-through',
    inserted: 'bg-emerald-900/40 text-emerald-300',
  }
  return spans.map((sp, j) => {
    const cls = styCls[sp.state] || ''
    const parts = sp.text.split(/(\[\d{2}:\d{2}:\d{2}\]|\[\d+\.?\d*s\])/g)
    return (
      <span key={j} className={cls}>
        {parts.map((part, k) => {
          if (/^\[\d{2}:\d{2}:\d{2}\]$/.test(part)) return <span key={k} className="text-blue-400">{part}</span>
          if (/^\[\d+\.?\d*s\]$/.test(part)) return <span key={k} className="text-amber-400 bg-amber-900/20 px-0.5 rounded">{part}</span>
          return part
        })}
      </span>
    )
  })
}

function ReasonSummary({ stats }) {
  if (!stats) return null
  const reasons = [
    { key: 'filler_word', label: 'Filler', color: 'text-orange-400' },
    { key: 'false_start', label: 'False Start', color: 'text-purple-400' },
    { key: 'meta_commentary', label: 'Meta', color: 'text-cyan-400' },
    { key: 'unclassified', label: 'Other', color: 'text-zinc-400' },
  ]

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex gap-6">
      <span className="text-xs text-zinc-500 self-center">Deletion Reasons:</span>
      {reasons.map(r => (
        <div key={r.key} className="text-center">
          <div className={`text-lg font-bold ${r.color}`}>{stats[r.key]?.count || 0}</div>
          <div className="text-xs text-zinc-500">{r.label}</div>
        </div>
      ))}
      <div className="text-center ml-auto">
        <div className="text-lg font-bold text-zinc-300">{stats.total}</div>
        <div className="text-xs text-zinc-500">Total</div>
      </div>
    </div>
  )
}

function DeletionList({ deletions }) {
  if (!deletions || deletions.length === 0) return null

  const reasonColors = {
    filler_word: 'border-orange-800 bg-orange-900/20',
    false_start: 'border-purple-800 bg-purple-900/20',
    meta_commentary: 'border-cyan-800 bg-cyan-900/20',
    unclassified: 'border-zinc-700 bg-zinc-800/50',
  }
  const reasonLabelsMap = {
    filler_word: 'Filler', false_start: 'False Start',
    meta_commentary: 'Meta Commentary', unclassified: 'Unclassified',
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="px-4 py-2 border-b border-zinc-800 text-sm text-zinc-400 font-medium">
        All Deletions ({deletions.length})
      </div>
      <div className="divide-y divide-zinc-800/50 max-h-96 overflow-auto">
        {deletions.map((d, i) => (
          <div key={i} className={`px-4 py-2 flex items-start gap-3 ${reasonColors[d.reason] || ''}`}>
            <span className="text-xs text-zinc-500 font-mono w-6 shrink-0 pt-0.5">{i + 1}</span>
            <span className="text-sm font-mono text-red-300 flex-1 break-all">{d.text}</span>
            <span className="text-xs text-zinc-400 shrink-0">{reasonLabelsMap[d.reason]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TranscriptPanel({ label, content }) {
  if (!content) return <p className="text-zinc-500 text-sm">No {label} available.</p>
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
      <div className="px-4 py-2 border-b border-zinc-800 text-sm text-zinc-400">{label}</div>
      <pre className="p-4 text-sm whitespace-pre-wrap font-mono leading-relaxed">
        {highlightTranscript(content)}
      </pre>
    </div>
  )
}

const GROUP_COLORS = [
  { bg: 'bg-emerald-900/30', border: 'border-emerald-700', badge: 'bg-emerald-500', text: 'text-emerald-200' },
  { bg: 'bg-blue-900/30', border: 'border-blue-700', badge: 'bg-blue-500', text: 'text-blue-200' },
  { bg: 'bg-amber-900/30', border: 'border-amber-700', badge: 'bg-amber-500', text: 'text-amber-200' },
  { bg: 'bg-red-900/30', border: 'border-red-700', badge: 'bg-red-500', text: 'text-red-200' },
  { bg: 'bg-purple-900/30', border: 'border-purple-700', badge: 'bg-purple-500', text: 'text-purple-200' },
  { bg: 'bg-pink-900/30', border: 'border-pink-700', badge: 'bg-pink-500', text: 'text-pink-200' },
  { bg: 'bg-teal-900/30', border: 'border-teal-700', badge: 'bg-teal-500', text: 'text-teal-200' },
  { bg: 'bg-orange-900/30', border: 'border-orange-700', badge: 'bg-orange-500', text: 'text-orange-200' },
]

function RepeatedTakesPanel({ label, content }) {
  if (!content) return <p className="text-zinc-500 text-sm">No {label} available.</p>

  const { paragraphs, cleaned, groups } = detectRepeatedTakes(content)

  // Build lookup: paraIndex → { groupId, takeNum, totalTakes }
  const groupMap = new Map()
  groups.forEach((grp, gid) => {
    grp.forEach((idx, take) => {
      groupMap.set(idx, { groupId: gid, takeNum: take + 1, totalTakes: grp.length })
    })
  })

  const totalGroups = groups.length
  const totalRepeated = groups.reduce((s, g) => s + g.length, 0)

  return (
    <div className="space-y-3">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
        <div className="px-4 py-2 border-b border-zinc-800 flex items-center justify-between">
          <span className="text-sm text-zinc-400">{label}</span>
          <span className="text-xs text-zinc-500">
            {paragraphs.length} paragraphs &middot;{' '}
            <span className="text-emerald-400 font-medium">{totalGroups} repeated-take group{totalGroups !== 1 ? 's' : ''}</span>
            {totalRepeated > 0 && ` (${totalRepeated} repeated paragraphs)`}
          </span>
        </div>
        <div className="p-4 space-y-2" style={{ maxHeight: '75vh', overflowY: 'auto' }}>
          {paragraphs.map((para, i) => {
            const info = groupMap.get(i)
            const wc = cleaned[i].length

            if (info) {
              const colors = GROUP_COLORS[info.groupId % GROUP_COLORS.length]
              return (
                <div key={i} className={`rounded-lg border-l-4 ${colors.border} ${colors.bg} px-4 py-3`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`text-[10px] font-bold text-black px-2 py-0.5 rounded ${colors.badge}`}>
                      Group {info.groupId + 1} — Take {info.takeNum}/{info.totalTakes}
                    </span>
                    <span className="text-[10px] text-zinc-500">&#182; {i + 1} &middot; {wc} words</span>
                  </div>
                  <pre className={`text-xs whitespace-pre-wrap font-mono leading-relaxed ${colors.text}`}>
                    {highlightTranscript(para)}
                  </pre>
                </div>
              )
            }

            return (
              <div key={i} className="rounded-lg border-l-4 border-zinc-800 bg-zinc-900 px-4 py-3">
                <div className="mb-1">
                  <span className="text-[10px] text-zinc-600">&#182; {i + 1} &middot; {wc} words</span>
                </div>
                <pre className="text-xs whitespace-pre-wrap font-mono leading-relaxed text-zinc-300">
                  {highlightTranscript(para)}
                </pre>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, color = 'text-white' }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-center">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-zinc-500 mt-1">{label}</div>
    </div>
  )
}

function highlightTranscript(text) {
  const parts = text.split(/(\[\d{2}:\d{2}:\d{2}\]|\[\d+\.?\d*s\])/g)
  return parts.map((part, i) => {
    if (/^\[\d{2}:\d{2}:\d{2}\]$/.test(part)) return <span key={i} className="text-blue-400">{part}</span>
    if (/^\[\d+\.?\d*s\]$/.test(part)) return <span key={i} className="text-amber-400 bg-amber-900/20 px-0.5 rounded">{part}</span>
    return part
  })
}

function AddFootagePanel({ currentVideo, canAddRaw, canAddHuman, defaultType, onDone }) {
  const [mode, setMode] = useState('upload') // upload | youtube
  const [file, setFile] = useState(null)
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [title, setTitle] = useState('')
  const [videoType, setVideoType] = useState(defaultType)
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState(null)
  const [error, setError] = useState(null)

  async function linkGroup(newVideoData) {
    // If the current video had no group, update it to join the new group
    if (!currentVideo.group_id && newVideoData.video?.group_id) {
      await apiPut(`/videos/${currentVideo.id}`, {
          title: currentVideo.title,
          video_type: currentVideo.video_type,
          group_id: newVideoData.video.group_id,
          duration_seconds: currentVideo.duration_seconds,
        })
    }
  }

  async function handleUpload(e) {
    e.preventDefault()
    setUploading(true)
    setError(null)

    try {
      if (mode === 'youtube') {
        if (!youtubeUrl.trim()) return
        const data = await apiPost('/videos/import-youtube', {
            url: youtubeUrl.trim(),
            title: title || undefined,
            video_type: videoType,
            link_video_id: currentVideo.id,
          })
        setUploadResult(data)
        await linkGroup(data)
      } else {
        if (!file) return
        const formData = new FormData()
        formData.append('video', file)
        formData.append('title', title || file.name.replace(/\.[^.]+$/, ''))
        formData.append('video_type', videoType)
        if (currentVideo.group_id) {
          formData.append('group_id', currentVideo.group_id)
        } else {
          formData.append('group_name', currentVideo.title)
        }

        const res = await authFetch('/videos/upload', { method: 'POST', body: formData })
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Upload failed' }))
          throw new Error(err.error)
        }
        const data = await res.json()
        setUploadResult(data)
        await linkGroup(data)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  const submitted = !!uploadResult

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-4">
      <div className="text-sm font-medium text-zinc-300">
        Add Footage to {currentVideo.group_name || currentVideo.title}
      </div>

      {!submitted && (
        <form onSubmit={handleUpload} className="space-y-3">
          {/* Mode toggle */}
          <div className="flex gap-2">
            <button type="button" onClick={() => setMode('upload')}
              className={`px-3 py-1.5 text-sm rounded border transition-colors ${
                mode === 'upload' ? 'bg-zinc-700 border-zinc-600 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-300'
              }`}>
              <Upload size={12} className="inline mr-1.5" />File Upload
            </button>
            <button type="button" onClick={() => setMode('youtube')}
              className={`px-3 py-1.5 text-sm rounded border transition-colors ${
                mode === 'youtube' ? 'bg-zinc-700 border-zinc-600 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-300'
              }`}>
              YouTube URL
            </button>
          </div>

          {/* File or YouTube input */}
          {mode === 'upload' ? (
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Video File</label>
              <label className="flex items-center justify-center gap-2 w-full h-20 border-2 border-dashed border-zinc-700 rounded-lg cursor-pointer hover:border-zinc-500 transition-colors">
                <input type="file" accept="video/*,audio/*" onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) { setFile(f); if (!title) setTitle(f.name.replace(/\.[^.]+$/, '')) }
                }} className="hidden" />
                {file ? (
                  <div className="text-sm text-zinc-300">
                    <span className="font-medium">{file.name}</span>
                    <span className="text-zinc-500 ml-2">({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
                  </div>
                ) : (
                  <div className="text-sm text-zinc-500 flex items-center gap-2">
                    <Upload size={16} /> Click to select video or audio file
                  </div>
                )}
              </label>
            </div>
          ) : (
            <div>
              <label className="block text-xs text-zinc-400 mb-1">YouTube URL</label>
              <input type="text" value={youtubeUrl} onChange={e => setYoutubeUrl(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-500"
                placeholder="https://youtube.com/watch?v=..." />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Name</label>
              <input type="text" value={title} onChange={e => setTitle(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-500"
                placeholder={mode === 'youtube' ? 'Auto from YouTube...' : 'Video name...'} />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Footage Type</label>
              <div className="flex gap-2">
                {canAddHuman && (
                  <button type="button" onClick={() => setVideoType('human_edited')}
                    className={`flex-1 px-3 py-1.5 text-sm rounded border transition-colors ${
                      videoType === 'human_edited' ? 'bg-purple-900/30 border-purple-700 text-purple-300' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-300'
                    }`}>Human-Edited</button>
                )}
                {canAddRaw && (
                  <button type="button" onClick={() => setVideoType('raw')}
                    className={`flex-1 px-3 py-1.5 text-sm rounded border transition-colors ${
                      videoType === 'raw' ? 'bg-blue-900/30 border-blue-700 text-blue-300' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-300'
                    }`}>Raw Footage</button>
                )}
              </div>
            </div>
          </div>

          <button type="submit" disabled={(mode === 'upload' ? !file : !youtubeUrl.trim()) || uploading}
            className="bg-white text-black px-4 py-1.5 rounded text-sm font-medium hover:bg-zinc-200 disabled:opacity-50 transition-colors flex items-center gap-2">
            {uploading && <Loader2 size={14} className="animate-spin" />}
            {uploading ? (mode === 'youtube' ? 'Importing...' : 'Uploading...') : (mode === 'youtube' ? 'Import from YouTube' : 'Upload')}
          </button>
        </form>
      )}

      {/* Done — transcription starts automatically in background */}
      {submitted && (
        <div className="space-y-3">
          <div className="bg-emerald-900/20 border border-emerald-800/50 rounded-lg p-3 text-sm text-emerald-300">
            {mode === 'youtube' ? 'YouTube video imported' : 'Video uploaded'}: <strong>{uploadResult.video?.title || title}</strong>
            <div className="text-xs text-emerald-400/70 mt-1">Transcription started in background — check the Videos page for progress.</div>
          </div>
          <div className="flex gap-2">
            {uploadResult.videoId && (
              <Link to={`/admin/videos/${uploadResult.videoId}`}
                className="bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded text-sm transition-colors">View New Video</Link>
            )}
            <button onClick={onDone} className="text-zinc-500 hover:text-zinc-300 px-3 py-1.5 rounded text-sm transition-colors">Done</button>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-lg p-3 text-sm text-red-300">{error}</div>
      )}
    </div>
  )
}

function TypeBadge({ type }) {
  if (type === 'human_edited') {
    return <span className="text-xs px-1.5 py-0.5 rounded border border-purple-800 bg-purple-900/30 text-purple-300">Edited</span>
  }
  return <span className="text-xs px-1.5 py-0.5 rounded border border-blue-800 bg-blue-900/30 text-blue-300">Raw</span>
}

function reasonColor(reason) {
  const m = { filler_word: 'text-orange-400', false_start: 'text-purple-400', meta_commentary: 'text-cyan-400' }
  return m[reason] || 'text-zinc-400'
}

function reasonLabel(reason) {
  const m = { filler_word: 'Filler', false_start: 'False Start', meta_commentary: 'Meta' }
  return m[reason] || 'Other'
}

function scoreColor(score) {
  const pct = score * 100
  if (pct >= 80) return 'text-emerald-400'
  if (pct >= 60) return 'text-amber-400'
  return 'text-red-400'
}

function simColor(pct) {
  if (pct >= 80) return 'text-emerald-400'
  if (pct >= 60) return 'text-amber-400'
  return 'text-red-400'
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
