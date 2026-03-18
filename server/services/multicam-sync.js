import db from '../db.js'

/**
 * Analyze a group of raw footage videos for multicam sync.
 * 1. Compare transcripts to find multicam pairs (same audio)
 * 2. Group multicam videos, pick longest transcript as primary
 * 3. Order non-matching segments using Gemini
 * 4. Assemble final combined transcript
 */
export async function analyzeMulticam(groupId) {
  updateStatus(groupId, 'syncing')

  const videos = db.prepare(`
    SELECT v.id, v.title, v.duration_seconds, t.content AS transcript
    FROM videos v
    LEFT JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
    WHERE v.group_id = ? AND v.video_type = 'raw'
    ORDER BY v.id
  `).all(groupId)

  if (videos.length === 0) {
    return updateStatus(groupId, 'failed', 'No transcribed raw videos in group')
  }

  if (videos.length === 1) {
    return updateStatus(groupId, 'done', null, videos[0].transcript, JSON.stringify({
      segments: [{ videoIds: [videos[0].id], primaryVideoId: videos[0].id, primaryTitle: videos[0].title, isMulticam: false }],
    }))
  }

  try {
    // Extract normalized words from each transcript
    const items = videos.map(v => ({
      ...v,
      words: extractWords(v.transcript || ''),
    }))

    // Pairwise overlap using trigram matching (tolerates Whisper errors)
    console.log(`[multicam] Comparing ${videos.length} transcripts...`)
    const overlap = {}
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const score = computeOverlap(items[i].words, items[j].words)
        overlap[`${i}-${j}`] = score
        console.log(`[multicam]   ${videos[i].title} vs ${videos[j].title}: ${(score * 100).toFixed(1)}%`)
      }
    }

    // Group multicam videos (>30% trigram overlap = same scene)
    const groups = clusterMulticam(items.length, overlap, 0.30)
    console.log(`[multicam] ${groups.length} distinct segments (${groups.filter(g => g.length > 1).length} multicam groups)`)

    // For each cluster pick the longest-duration video as primary,
    // then merge any non-overlapping content from other cameras
    const segments = groups.map(group => {
      const vids = group.map(i => items[i])
      const primary = vids.reduce((best, v) =>
        (v.duration_seconds || 0) > (best.duration_seconds || 0) ? v : best
      )
      const others = vids.filter(v => v.id !== primary.id)
      const transcript = group.length > 1
        ? mergeMulticamTranscript(primary, others)
        : primary.transcript
      return {
        videoIds: vids.map(v => v.id),
        titles: vids.map(v => v.title),
        primaryVideoId: primary.id,
        primaryTitle: primary.title,
        transcript,
        duration: primary.duration_seconds,
        isMulticam: group.length > 1,
      }
    })

    // If multiple non-overlapping segments, ask Gemini for logical order
    let ordered = segments
    let geminiData = null
    if (segments.length > 1) {
      updateStatus(groupId, 'ordering')
      console.log(`[multicam] Ordering ${segments.length} segments with Gemini...`)
      const result = await orderWithGemini(segments)
      ordered = result.ordered
      geminiData = result.gemini
    }

    // Assemble final transcript — resets all timecodes to be continuous
    updateStatus(groupId, 'assembling')
    const assembled = assemble(ordered)

    const details = {
      overlapScores: overlap,
      gemini: geminiData,
      segments: ordered.map(s => ({
        videoIds: s.videoIds,
        titles: s.titles,
        primaryVideoId: s.primaryVideoId,
        primaryTitle: s.primaryTitle,
        isMulticam: s.isMulticam,
        duration: s.duration,
      })),
    }

    updateStatus(groupId, 'done', null, assembled, JSON.stringify(details))
    console.log(`[multicam] Group ${groupId} done: ${ordered.length} segments assembled`)
  } catch (err) {
    const reason = err.message || String(err)
    const detail = reason.includes('Gemini') ? `Gemini API error during ordering: ${reason}`
      : reason.includes('GOOGLE_API_KEY') ? 'Google API key not configured'
      : `Multicam analysis error: ${reason}`
    console.error(`[multicam] Group ${groupId} failed:`, detail)
    updateStatus(groupId, 'failed', detail)
  }
}

function updateStatus(groupId, status, error = null, transcript = null, details = null) {
  if (transcript !== null) {
    db.prepare('UPDATE video_groups SET assembly_status = ?, assembly_error = ?, assembled_transcript = ?, assembly_details_json = ? WHERE id = ?')
      .run(status, error, transcript, details, groupId)
  } else {
    db.prepare('UPDATE video_groups SET assembly_status = ?, assembly_error = ? WHERE id = ?')
      .run(status, error, groupId)
  }
}

/**
 * Merge non-overlapping content from other cameras into the primary transcript.
 * Finds portions at the start/end of other videos that the primary didn't capture.
 */
function mergeMulticamTranscript(primary, others) {
  if (!primary.transcript) return primary.transcript
  const validOthers = others.filter(v => v.transcript)
  if (validOthers.length === 0) return primary.transcript

  const primaryWords = extractWords(primary.transcript)
  if (primaryWords.length < 4) return primary.transcript

  const primaryTrigrams = new Set()
  for (let i = 0; i <= primaryWords.length - 3; i++) {
    primaryTrigrams.add(`${primaryWords[i]} ${primaryWords[i+1]} ${primaryWords[i+2]}`)
  }

  let bestPrefix = null // { text, source }
  let bestSuffix = null

  for (const other of validOthers) {
    // Split transcript into timecoded blocks
    const blocks = other.transcript.split(/(?=\[\d{2}:\d{2}:\d{2}\])/).map(b => b.trim()).filter(Boolean)
    if (blocks.length === 0) continue

    // Check each block for overlap with primary
    const overlaps = blocks.map(block => {
      const words = extractWords(block)
      if (words.length < 3) return true // too short to judge, assume overlap
      let hits = 0
      for (let i = 0; i <= words.length - 3; i++) {
        if (primaryTrigrams.has(`${words[i]} ${words[i+1]} ${words[i+2]}`)) hits++
      }
      return hits / Math.max(1, words.length - 2) > 0.3
    })

    const firstOverlap = overlaps.indexOf(true)
    const lastOverlap = overlaps.lastIndexOf(true)
    if (firstOverlap < 0) continue

    // Blocks before first overlap = unique prefix (this camera started earlier)
    if (firstOverlap > 0) {
      const pre = blocks.slice(0, firstOverlap).join('\n\n')
      if (!bestPrefix || pre.length > bestPrefix.text.length) {
        bestPrefix = { text: pre, source: other.title }
      }
    }

    // Blocks after last overlap = unique suffix (this camera kept rolling)
    if (lastOverlap < blocks.length - 1) {
      const suf = blocks.slice(lastOverlap + 1).join('\n\n')
      if (!bestSuffix || suf.length > bestSuffix.text.length) {
        bestSuffix = { text: suf, source: other.title }
      }
    }
  }

  let result = primary.transcript

  if (bestPrefix) {
    // Prefix timecodes are already correct (they start from [00:00:00] of that camera).
    // Shift the PRIMARY forward by the prefix duration so timecodes are continuous.
    const prefixDuration = getLastTimecode(bestPrefix.text)
    console.log(`[multicam] Merging prefix from ${bestPrefix.source} (${bestPrefix.text.split(/\s+/).length} words, ${prefixDuration}s)`)
    result = offsetTimecodes(result, prefixDuration)
    result = `[Additional from: ${bestPrefix.source}]\n\n${bestPrefix.text}\n\n${result}`
  }

  if (bestSuffix) {
    // Shift suffix timecodes to continue after the primary ends
    const primaryEnd = getLastTimecode(result)
    console.log(`[multicam] Merging suffix from ${bestSuffix.source} (${bestSuffix.text.split(/\s+/).length} words, offset +${primaryEnd}s)`)
    const shiftedSuffix = offsetTimecodes(bestSuffix.text, primaryEnd)
    result = `${result}\n\n[Additional from: ${bestSuffix.source}]\n\n${shiftedSuffix}`
  }

  return result
}

/** Extract the last timecode in a transcript as total seconds */
function getLastTimecode(text) {
  const matches = [...text.matchAll(/\[(\d{2}):(\d{2}):(\d{2})\]/g)]
  if (matches.length === 0) return 0
  const last = matches[matches.length - 1]
  return +last[1] * 3600 + +last[2] * 60 + +last[3]
}

/** Strip timecodes and punctuation, return lowercase word array */
function extractWords(transcript) {
  return transcript
    .replace(/\[\d{2}:\d{2}:\d{2}\]/g, '')
    .replace(/[.,!?;:'"()\-—]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 1) // skip single-char noise
}

/**
 * Trigram overlap ratio between two word arrays.
 * Robust to Whisper errors: a single wrong word breaks at most 3 trigrams
 * out of potentially hundreds, so the overall ratio barely moves.
 */
function computeOverlap(a, b) {
  if (a.length < 4 || b.length < 4) return 0

  const triA = new Set()
  for (let i = 0; i <= a.length - 3; i++) triA.add(`${a[i]} ${a[i+1]} ${a[i+2]}`)

  let hits = 0
  const countB = Math.max(1, b.length - 2)
  for (let i = 0; i <= b.length - 3; i++) {
    if (triA.has(`${b[i]} ${b[i+1]} ${b[i+2]}`)) hits++
  }

  return Math.min(1, hits / Math.min(triA.size, countB))
}

/** Union-find clustering of videos above overlap threshold */
function clusterMulticam(n, overlap, threshold) {
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const union = (a, b) => { parent[find(a)] = find(b) }

  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if ((overlap[`${i}-${j}`] || 0) >= threshold) union(i, j)

  const groups = {}
  for (let i = 0; i < n; i++) {
    const root = find(i)
    if (!groups[root]) groups[root] = []
    groups[root].push(i)
  }
  return Object.values(groups)
}

/**
 * Use Gemini 3 Pro to determine logical order of non-overlapping segments.
 * Returns { ordered, gemini: { prompt, response, order } }
 */
async function orderWithGemini(segments) {
  const noGemini = { ordered: segments, gemini: null }
  const apiKey = process.env.GOOGLE_API_KEY
  if (!apiKey) {
    console.log('[multicam] No GOOGLE_API_KEY, keeping upload order')
    return noGemini
  }

  const previews = segments.map((s, i) => {
    const text = (s.transcript || '')
      .replace(/\[\d{2}:\d{2}:\d{2}\]/g, '').trim()
    return `--- SEGMENT ${i + 1} (source: "${s.primaryTitle}", ${s.duration || '?'}s) ---\n${text}`
  }).join('\n\n')

  const prompt = `You have ${segments.length} transcript segments from different parts of a video shoot. They do NOT overlap — each covers a different scene or topic. Determine the most logical chronological order.\n\n${previews}\n\nRespond with ONLY a JSON array of segment numbers in the correct order. Example: [2, 1, 3]`

  const geminiResult = { prompt, response: null, order: null }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${apiKey}`
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: 'You analyze transcript segments and determine their chronological order. Respond ONLY with a JSON array of 1-based segment numbers. No explanation.' }] },
        generationConfig: {
          maxOutputTokens: 10000,
          temperature: 1,
          thinkingConfig: { thinkingLevel: 'HIGH' },
        },
      })
    })
    if (!r.ok) throw new Error(`Gemini ${r.status}`)

    const data = await r.json()
    const parts = data.candidates?.[0]?.content?.parts || []
    // With thinking enabled, parts may include thought parts — grab the last text part
    const textPart = [...parts].reverse().find(p => p.text !== undefined)
    const text = textPart?.text || ''
    const thoughtPart = parts.find(p => p.thought === true)
    geminiResult.response = text
    if (thoughtPart?.text) geminiResult.thinking = thoughtPart.text

    const match = text.match(/\[[\d,\s]+\]/)
    if (match) {
      const order = JSON.parse(match[0])
      if (order.length === segments.length && order.every(n => n >= 1 && n <= segments.length)) {
        console.log(`[multicam] Gemini order: ${JSON.stringify(order)}`)
        geminiResult.order = order
        return { ordered: order.map(n => segments[n - 1]), gemini: geminiResult }
      }
    }
    console.log('[multicam] Could not parse Gemini order, keeping original')
    return { ordered: segments, gemini: geminiResult }
  } catch (err) {
    console.error('[multicam] Gemini ordering failed:', err.message)
    geminiResult.response = `Error: ${err.message}`
    return { ordered: segments, gemini: geminiResult }
  }
}

/**
 * Assemble final transcript from ordered segments with continuous timecodes.
 * Each segment's internal timecodes start from [00:00:00] — we shift them
 * so segment 2 continues where segment 1 left off, etc.
 */
function assemble(segments) {
  let result = ''
  let offset = 0

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (i > 0) result += '\n\n'

    // Transcript with offset timecodes (no source headers or separators)
    const text = cleanTranscript(seg.transcript || '(no transcript)')
    result += offset > 0 ? offsetTimecodes(text, offset) : text

    // Use the actual last timecode in transcript (accounts for merged prefix/suffix)
    // rather than just the primary's duration
    const lastTC = getLastTimecode(text)
    offset += lastTC > 0 ? lastTC : (seg.duration || 0)
  }

  return result
}

/** Remove source headers, separators, and other assembly artifacts */
function cleanTranscript(text) {
  return text
    .replace(/\[Source:[^\]]*\]\n*/g, '')
    .replace(/\[Additional from:[^\]]*\]\n*/g, '')
    .replace(/--- --- ---\n*/g, '')
    .trim()
}

function offsetTimecodes(text, secs) {
  return text.replace(/\[(\d{2}):(\d{2}):(\d{2})\]/g, (_, h, m, s) => {
    const total = +h * 3600 + +m * 60 + +s + secs
    const hh = String(Math.floor(total / 3600)).padStart(2, '0')
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
    const ss = String(Math.floor(total % 60)).padStart(2, '0')
    return `[${hh}:${mm}:${ss}]`
  })
}
