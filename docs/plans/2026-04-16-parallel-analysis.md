# Parallel Video Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run reference video analysis for all example videos concurrently instead of sequentially, cutting analysis time from N*T to ~T.

**Architecture:** Extract a `runVideoAnalysis()` function with isolated per-video state (transcript, segments, timeWindows, chapterSplits, llmAnswer/llmAnswers, stageOutputs). Run all videos via `Promise.all` as a pre-step before the main stage loop. Each stage within a video gets retry logic (5s, 20s, then error). The main loop only processes plan + alt_plan stages.

**Tech Stack:** Node.js, existing `callLLM`, `extractVideoSegment`, Gemini API

**File:** `server/services/broll.js` (all changes in this single file)

---

### Task 1: Add `withStageRetry` utility

**Files:**
- Modify: `server/services/broll.js` — add after `cleanupTempFiles` function (~line 34)

- [ ] **Step 1: Add the retry helper**

Insert after the `cleanupTempFiles` function (around line 34, before `extractJSON`):

```javascript
/**
 * Retry a stage function with escalating delays: 5s, then 20s, then give up.
 * Designed for Gemini API rate limit / connection errors during parallel analysis.
 */
async function withStageRetry(fn, { label, abortSignal } = {}) {
  const delays = [5000, 20000]
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (abortSignal?.aborted || err.name === 'AbortError') throw err
      if (attempt === delays.length) throw err
      console.log(`[broll-pipeline] ${label || 'Stage'} failed (attempt ${attempt + 1}/${delays.length + 1}), retrying in ${delays[attempt] / 1000}s: ${err.message}`)
      await new Promise(r => setTimeout(r, delays[attempt]))
    }
  }
}
```

- [ ] **Step 2: Verify no syntax errors**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && node -c server/services/broll.js`
Expected: no output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add server/services/broll.js
git commit -m "feat: add withStageRetry utility for parallel analysis"
```

---

### Task 2: Add `runVideoAnalysis` function

**Files:**
- Modify: `server/services/broll.js` — add new function before `executePipeline` (before line 1682)

This is the core new function. It runs analysis stages for a single video with isolated state. Insert it right before the `export async function executePipeline` line.

- [ ] **Step 1: Add the function**

The function must handle these analysis stage types (same logic as the main loop, but with local state):
- `video_llm` target `examples` (with and without `per_window`)
- `programmatic` actions: `segment`, `build_time_windows`, `split_by_chapter`, `compute_chapter_stats`, `reassemble`, `assemble_full_analysis`
- `transcript_question` target `text_only` or `examples`
- `transcript_llm`

```javascript
/**
 * Run analysis stages for a single reference video with isolated state.
 * Called in parallel for each example video.
 *
 * Returns: { videoId, assembledOutput, chapterAnalysis, stageOutputs, totalTokensIn, totalTokensOut, totalCost }
 */
async function runVideoAnalysis(video, analysisStagesTemplate, {
  pipelineId, strategyId, mainVideoId, groupId, pipelineAbort,
  abortedSet, // abortedBrollPipelines
  progressMap, // brollPipelineProgress
  pipelineMeta,
  exampleVideos, // full list, for runOnExamples
  mainTranscript,
}) {
  const videoLabel = video.title || `Video #${video.id}`
  const isFavorite = !!video.isFavorite

  // ── Isolated state for this video's analysis ──
  let currentTranscript = mainTranscript
  let segments = null
  let timeWindows = null
  let chapterSplits = null
  let llmAnswer = ''
  const llmAnswers = {}
  let questionCount = 0
  let examplesOutput = ''
  const stageOutputs = []
  let totalTokensIn = 0, totalTokensOut = 0, totalCost = 0

  // Load this video's transcript for transcript-targeted stages
  const videoTranscript = await (async () => {
    const t = await db.prepare(
      "SELECT content FROM transcripts WHERE video_id = ? ORDER BY CASE type WHEN 'raw' THEN 1 WHEN 'human_edited' THEN 2 ELSE 3 END LIMIT 1"
    ).get(video.id)
    return t?.content || mainTranscript
  })()

  // Local replacePlaceholders using isolated state
  function replacePlaceholders(text) {
    let result = text
      .replace(/\{\{transcript\}\}/g, currentTranscript)
      .replace(/\{\{llm_answer\}\}/g, llmAnswer)
      .replace(/\{\{examples_output\}\}/g, examplesOutput)
      .replace(/\{\{reference_analysis\}\}/g, '') // not available during analysis
      .replace(/\{\{favorite_plan\}\}/g, '') // not available during analysis
      .replace(/\{\{all_chapter_analyses\}\}/g, '')
    for (const [num, ans] of Object.entries(llmAnswers)) {
      result = result.replace(new RegExp(`\\{\\{llm_answer_${num}\\}\\}`, 'g'), ans)
    }
    stageOutputs.forEach((out, i) => {
      result = result.replace(new RegExp(`\\{\\{stage_${i + 1}_output\\}\\}`, 'g'), out || '')
    })
    return result
  }

  // Local LLM call helper
  async function runLLMCall(stage, videoFile, transcriptOverride) {
    const prompt = replacePlaceholders(stage.prompt || '')
    const systemInstruction = replacePlaceholders(stage.system_instruction || '')
    const finalPrompt = transcriptOverride
      ? prompt.replace(/\{\{transcript\}\}/g, transcriptOverride)
      : prompt
    const result = await callLLM({
      model: stage.model || 'gemini-3-flash-preview',
      systemInstruction,
      prompt: finalPrompt,
      params: stage.params || { temperature: 0.2 },
      experimentId: null,
      videoFile: videoFile || undefined,
      abortSignal: pipelineAbort.signal,
    })
    result._resolvedPrompt = finalPrompt
    result._resolvedSystem = systemInstruction
    return result
  }

  // Local sub-run storage
  async function storeSubRun({ stageIndex, stageName, subIndex, subLabel, prompt, systemInstruction, input, output, model, tokensIn, tokensOut, cost, runtime }) {
    const result = await db.prepare(`
      INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      strategyId, mainVideoId, 'analysis', 'complete',
      input, output, prompt, systemInstruction,
      model || 'gemini-3-flash-preview',
      tokensIn || 0, tokensOut || 0, cost || 0, runtime || 0,
      JSON.stringify({ pipelineId, stageIndex, stageName, subIndex, subLabel, isSubRun: true, phase: 'analysis', videoId: video.id, videoLabel, isFavorite, analysisStageCount: analysisStagesTemplate.length }),
    )
    const verify = await db.prepare('SELECT id FROM broll_runs WHERE id = ?').get(result.lastInsertRowid)
    if (!verify) console.error(`[broll-analysis] SUB-RUN LOST: stage=${stageIndex} sub=${subIndex} id=${result.lastInsertRowid}`)
  }

  console.log(`[broll-analysis] Starting analysis for "${videoLabel}" (${analysisStagesTemplate.length} stages)`)

  // ── Execute stages sequentially, each with retry ──
  for (let i = 0; i < analysisStagesTemplate.length; i++) {
    if (abortedSet.has(pipelineId) || pipelineAbort.signal.aborted) {
      throw new Error('Aborted by user')
    }

    const stage = { ...analysisStagesTemplate[i], _videoId: video.id, _videoLabel: videoLabel, _isFavorite: isFavorite }
    const stageName = stage.name || `Stage ${i + 1}`
    const target = stage.target || 'main_video'
    const isVideoType = stage.type === 'video_llm' || stage.type === 'video_question'
    const isQuestion = stage.type === 'video_question' || stage.type === 'transcript_question'

    console.log(`[broll-analysis] "${videoLabel}" stage ${i + 1}/${analysisStagesTemplate.length}: ${stageName} (${stage.type})`)

    const stageStart = Date.now()

    // ── Per-stage retry wrapper (5s, 20s, error) ──
    const output = await withStageRetry(async () => {
      let stageOutput = ''
      let stageTokensIn = 0, stageTokensOut = 0, stageCost = 0

      if (target === 'examples' && stage.per_window) {
        // ── Per-window on this video ──
        if (!timeWindows) throw new Error('per_window stage requires a preceding build_time_windows stage')
        const videoFile = isVideoType ? await getVideoFilePath(video.id) : null
        const windowResults = new Array(timeWindows.length).fill(null)
        const WINDOW_CONCURRENCY = 5

        async function processWindow(w) {
          if (abortedSet.has(pipelineId)) return
          const win = timeWindows[w]

          let winPrompt = replacePlaceholders(stage.prompt || '')
            .replace(/\{\{window_id\}\}/g, String(win.window_id))
            .replace(/\{\{window_start\}\}/g, String(win.start_seconds))
            .replace(/\{\{window_end\}\}/g, String(win.end_seconds))
            .replace(/\{\{window_start_tc\}\}/g, win.start_tc)
            .replace(/\{\{window_end_tc\}\}/g, win.end_tc)
            .replace(/\{\{window_chapter\}\}/g, win.chapter_name)
            .replace(/\{\{window_beats\}\}/g, win.beats_in_window.join(', '))
          const winSystem = replacePlaceholders(stage.system_instruction || '')

          let windowVideoFile = videoFile
          if (videoFile) {
            windowVideoFile = await extractVideoSegment(videoFile, win.start_seconds, win.end_seconds, `broll-seg-${video.id}-${win.start_seconds}-${win.end_seconds}.mp4`)
          }

          const result = await callLLM({
            model: stage.model || 'gemini-3-flash-preview',
            systemInstruction: winSystem,
            prompt: winPrompt,
            params: stage.params || { temperature: 0.2 },
            experimentId: null,
            videoFile: windowVideoFile || undefined,
            abortSignal: pipelineAbort.signal,
          })

          // Convert relative timestamps to absolute
          let outputText = result.text
          try {
            const parsed = extractJSON(outputText)
            if (parsed.elements) {
              const offset = win.start_seconds
              const toTC = (s) => `[${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}]`
              const parseMmSs = (tc) => { if (!tc) return null; const m = String(tc).match(/(\d{1,2}):(\d{2})/); if (!m) return null; return parseInt(m[1]) * 60 + parseInt(m[2]) }
              for (const el of parsed.elements) {
                let startSec = el.start_seconds ?? parseMmSs(el.start)
                let endSec = el.end_seconds ?? parseMmSs(el.end)
                if (startSec != null) { el.start_seconds = startSec + offset; el.start_tc = toTC(el.start_seconds) }
                if (endSec != null) { el.end_seconds = endSec + offset; el.end_tc = toTC(el.end_seconds) }
                delete el.start; delete el.end
              }
              outputText = JSON.stringify(parsed)
            }
          } catch {}

          windowResults[w] = outputText
          stageTokensIn += result.tokensIn || 0
          stageTokensOut += result.tokensOut || 0
          stageCost += result.cost || 0

          await storeSubRun({
            stageIndex: i, stageName, subIndex: w,
            subLabel: `${videoLabel} · Window ${win.start_tc}-${win.end_tc}`,
            prompt: winPrompt, systemInstruction: winSystem,
            input: `[video: ${videoLabel}] Window ${win.start_tc}-${win.end_tc}`,
            output: outputText, model: stage.model,
            tokensIn: result.tokensIn, tokensOut: result.tokensOut, cost: result.cost,
            runtime: 0,
          })
        }

        // Pool concurrency
        let nextW = 0
        async function runNext() {
          while (nextW < timeWindows.length && !abortedSet.has(pipelineId)) {
            const w = nextW++
            await processWindow(w)
          }
        }
        await Promise.all(Array.from({ length: Math.min(WINDOW_CONCURRENCY, timeWindows.length) }, () => runNext()))

        stageOutput = `=== Example: ${videoLabel} ===\n${windowResults.filter(Boolean).join('\n')}`

      } else if (target === 'examples') {
        // ── Run on this video (non per_window) ──
        let videoFile = null
        if (isVideoType) videoFile = await getVideoFilePath(video.id)

        let exTranscript = null
        if (!isVideoType) exTranscript = videoTranscript

        const result = await runLLMCall(stage, videoFile, exTranscript)
        stageOutput = `=== Example: ${videoLabel} ===\n${result.text}`
        stageTokensIn += result.tokensIn || 0
        stageTokensOut += result.tokensOut || 0
        stageCost += result.cost || 0

      } else if (stage.type === 'transcript_llm') {
        const result = await runLLMCall(stage, null, null)
        stageOutput = result.text
        currentTranscript = stageOutput
        stageTokensIn += result.tokensIn || 0
        stageTokensOut += result.tokensOut || 0
        stageCost += result.cost || 0

      } else if (stage.type === 'transcript_question') {
        const result = await runLLMCall(stage, null, null)
        stageOutput = result.text
        stageTokensIn += result.tokensIn || 0
        stageTokensOut += result.tokensOut || 0
        stageCost += result.cost || 0

      } else if (stage.type === 'programmatic') {
        const action = stage.action || 'segment'
        const params = stage.actionParams || {}

        function tcToSec(tc) {
          if (!tc) return null
          const m = String(tc).match(/\[?(\d{1,2}):(\d{2}):(\d{2})\]?/)
          if (!m) return null
          return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
        }
        function normalizeTimestamps(obj) {
          if (!obj || typeof obj !== 'object') return
          if (obj.start && !obj.start_seconds) obj.start_seconds = tcToSec(obj.start) ?? 0
          if (obj.end && !obj.end_seconds) obj.end_seconds = tcToSec(obj.end) ?? 0
          if (obj.change_at && !obj.change_at_seconds) obj.change_at_seconds = tcToSec(obj.change_at) ?? 0
          for (const v of Object.values(obj)) {
            if (Array.isArray(v)) v.forEach(normalizeTimestamps)
            else if (v && typeof v === 'object') normalizeTimestamps(v)
          }
        }

        if (action === 'segment') {
          segments = segmentTranscript(currentTranscript, params)
          stageOutput = JSON.stringify(segments.map((s, idx) => ({ index: idx, lines: (s.mainText || '').split('\n').length })))
        } else if (action === 'segment_by_chapters') {
          segments = segmentByChapters(currentTranscript, llmAnswer, params)
          stageOutput = JSON.stringify(segments.map((s, idx) => ({ index: idx, chapter: s.chapter || idx })))
        } else if (action === 'reassemble') {
          if (!segments) throw new Error('reassemble requires preceding segments')
          currentTranscript = reassembleSegments(segments)
          stageOutput = currentTranscript
        } else if (action === 'build_time_windows') {
          const chaptersSource = params.chaptersStageIndex != null ? stageOutputs[params.chaptersStageIndex] : (llmAnswers[1] || llmAnswer)
          let parsed
          try { parsed = JSON.parse(chaptersSource) } catch { parsed = extractJSON(chaptersSource) }
          normalizeTimestamps(parsed)
          let totalDuration = 600
          const { getVideoDuration } = await import('./video-processor.js')
          const vPath = await getVideoFilePath(video.id)
          const realDuration = await getVideoDuration(vPath)
          if (realDuration) totalDuration = Math.round(realDuration)

          const targetSec = params.windowSeconds || 60
          const chapters = parsed.chapters || []
          const toTC = (s) => `[${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}]`
          const numWindows = Math.max(1, totalDuration % targetSec === 0 ? totalDuration / targetSec : Math.floor(totalDuration / targetSec))
          const windowSec = totalDuration / numWindows
          const windows = []
          for (let w = 0; w < numWindows; w++) {
            const start = Math.round(w * windowSec)
            const end = w === numWindows - 1 ? totalDuration : Math.round((w + 1) * windowSec)
            const ch = chapters.find(c => c.start_seconds <= start && c.end_seconds > start)
            const beats = (ch?.beats || []).filter(b => b.start_seconds < end && b.end_seconds > start).map(b => b.name)
            windows.push({ window_id: w + 1, start_seconds: start, end_seconds: end, start_tc: toTC(start), end_tc: toTC(end), chapter_name: ch?.name || 'Unknown', beats_in_window: beats })
          }
          timeWindows = windows
          stageOutput = JSON.stringify({ windows })
        } else if (action === 'split_by_chapter') {
          const chaptersSource = params.chaptersStageIndex != null ? stageOutputs[params.chaptersStageIndex] : (llmAnswers[1] || llmAnswer)
          let parsed
          try { parsed = JSON.parse(chaptersSource) } catch { parsed = extractJSON(chaptersSource) }
          normalizeTimestamps(parsed)
          const chapters = parsed.chapters || []
          let aRolls = parsed.a_roll_appearances || parsed.a_rolls || []
          if (!aRolls.length && params.aRollStageIndex != null) {
            try {
              const aRollParsed = extractJSON(stageOutputs[params.aRollStageIndex] || '')
              aRolls = aRollParsed.a_roll_appearances || aRollParsed.a_rolls || []
              normalizeTimestamps({ a_roll_appearances: aRolls })
            } catch {}
          }
          const elementsSource = params.elementsStageIndex != null ? stageOutputs[params.elementsStageIndex] : stageOutputs[2]
          const stage3raw = elementsSource || '[]'
          const allElements = []
          let elId = 1
          const jsonBlocks = stage3raw.match(/\{[\s\S]*?"elements"\s*:\s*\[[\s\S]*?\]\s*\}/g) || []
          for (const block of jsonBlocks) {
            try { const w = JSON.parse(block); for (const el of (w.elements || [])) allElements.push({ id: elId++, ...el }) } catch {}
          }
          if (!allElements.length) {
            try { let allWindows = JSON.parse(stage3raw); if (!Array.isArray(allWindows)) allWindows = [allWindows]; for (const w of allWindows) for (const el of (w.elements || [])) allElements.push({ id: elId++, ...el }) } catch {}
          }
          const transcriptLines = currentTranscript.split('\n')
          function parseLineTime(line) { const m = line.match(/\[(\d{1,2}):(\d{2}):?(\d{2})?(?:\.\d+)?\]/); if (!m) return null; return (parseInt(m[1]) * 3600) + (parseInt(m[2]) * 60) + (parseInt(m[3] || '0')) }
          const toTC = (s) => `[${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}]`
          chapterSplits = chapters.map((ch, idx) => {
            const chElements = allElements.filter(e => e.start_seconds >= ch.start_seconds && e.start_seconds < ch.end_seconds)
            const chTranscriptLines = transcriptLines.filter(line => { const t = parseLineTime(line); if (t === null) return false; return t >= ch.start_seconds && t < ch.end_seconds })
            const beatsRaw = ch.beats || []
            const beats = beatsRaw.map(b => `  - ${b.name} (${toTC(b.start_seconds)}-${toTC(b.end_seconds)}): ${b.description}${b.purpose ? ' | Purpose: ' + b.purpose : ''}`).join('\n')
            return { chapter_number: idx + 1, chapter_name: ch.name || `Chapter ${idx + 1}`, chapter_purpose: ch.purpose || ch.description || '', chapter_start: ch.start_seconds, chapter_end: ch.end_seconds, chapter_start_tc: toTC(ch.start_seconds), chapter_end_tc: toTC(ch.end_seconds), chapter_duration_seconds: ch.end_seconds - ch.start_seconds, content_type: ch.content_type || '', beats_formatted: beats, beats_raw: beatsRaw, elements: chElements, transcript: chTranscriptLines.join('\n') }
          })
          const allChaptersSummary = chapters.map((ch, idx) => { const beats = (ch.beats || []).map(b => `    - ${b.name} (${toTC(b.start_seconds)}-${toTC(b.end_seconds)})`).join('\n'); return `### Chapter ${idx + 1}: ${ch.name} (${toTC(ch.start_seconds)}-${toTC(ch.end_seconds)})\nPurpose: ${ch.purpose || ch.description || ''}\nBeats:\n${beats}` }).join('\n\n')
          const aRollSummary = aRolls.map(a => { const changeAt = a.change_at_seconds != null ? ` — change at ${toTC(a.change_at_seconds)}` : ''; const note = a.change_note ? ` (${a.change_note})` : ''; return `A-Roll #${a.id}: ${a.description}${changeAt}${note}` }).join('\n')
          chapterSplits._allChaptersContext = `## A-Rolls:\n${aRollSummary}\n\n## Chapters & Beats:\n${allChaptersSummary}`
          stageOutput = JSON.stringify({ total_chapters: chapterSplits.length, total_elements: allElements.length, chapters: chapterSplits.map(c => ({ name: c.chapter_name, start: c.chapter_start_tc, end: c.chapter_end_tc, element_count: c.elements.length })) })
        } else if (action === 'compute_chapter_stats') {
          if (!chapterSplits) throw new Error('compute_chapter_stats requires a preceding split_by_chapter stage')
          function groupBy(arr, key) { const map = {}; for (const el of arr) { const v = el[key] || 'unknown'; map[v] = (map[v] || 0) + 1 }; return map }
          function avgDuration(els) { if (!els.length) return 0; const total = els.reduce((s, e) => s + ((e.end_seconds || 0) - (e.start_seconds || 0)), 0); return Math.round(total / els.length * 10) / 10 }
          function avgGap(els) { if (els.length < 2) return 0; const sorted = [...els].sort((a, b) => a.start_seconds - b.start_seconds); let totalGap = 0; for (let i = 1; i < sorted.length; i++) totalGap += sorted[i].start_seconds - (sorted[i - 1].end_seconds || sorted[i - 1].start_seconds); return Math.round(totalGap / (sorted.length - 1) * 10) / 10 }
          function catStats(els) { if (!els.length) return { count: 0 }; return { count: els.length, avg_duration_seconds: avgDuration(els), avg_gap_seconds: avgGap(els), by_type_group: groupBy(els, 'type_group'), by_function: groupBy(els, 'function') } }
          const chapterStats = chapterSplits.map(ch => {
            const brolls = ch.elements.filter(e => e.category === 'broll')
            const gps = ch.elements.filter(e => e.category === 'graphic_package')
            const overlays = ch.elements.filter(e => e.category === 'overlay_image')
            const byBeat = (ch.beats_raw || []).map(b => { const beatEls = ch.elements.filter(e => e.start_seconds >= b.start_seconds && e.start_seconds < b.end_seconds); return { beat_name: b.name, broll: beatEls.filter(e => e.category === 'broll').length, graphic_package: beatEls.filter(e => e.category === 'graphic_package').length, overlay_image: beatEls.filter(e => e.category === 'overlay_image').length } })
            return { chapter_name: ch.chapter_name, duration_seconds: ch.chapter_duration_seconds, broll: { ...catStats(brolls), by_source_feel: groupBy(brolls, 'source_feel') }, graphic_package: catStats(gps), overlay_image: { ...catStats(overlays), by_position: groupBy(overlays, 'position') }, by_beat: byBeat }
          })
          chapterSplits._stats = chapterStats
          stageOutput = JSON.stringify(chapterStats)
        } else if (action === 'assemble_full_analysis') {
          if (!chapterSplits) throw new Error('assemble_full_analysis requires preceding split_by_chapter')
          const stats = chapterSplits._stats || []
          const lastPerChapterOutput = stageOutputs[stageOutputs.length - 1] || '[]'
          let llmResults = []; try { llmResults = JSON.parse(lastPerChapterOutput) } catch {}
          const parsedLlmResults = llmResults.map(r => { try { return extractJSON(r) } catch { return r } })
          let aRollData = null
          try {
            const stage0Out = llmAnswers[1] || stageOutputs[0] || ''
            const parsed0 = extractJSON(stage0Out)
            aRollData = { has_talking_head: parsed0.has_talking_head, appearances: parsed0.a_roll_appearances || parsed0.a_rolls || [] }
          } catch {}
          const toTC = (s) => `[${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}]`
          let totalBroll = 0, totalGP = 0, totalOverlay = 0
          for (const s of stats) { totalBroll += s.broll?.count || 0; totalGP += s.graphic_package?.count || 0; totalOverlay += s.overlay_image?.count || 0 }
          const totalElements = totalBroll + totalGP + totalOverlay || 1
          function toPct(countMap, total) { if (!countMap || !total) return {}; const result = {}; for (const [key, count] of Object.entries(countMap)) result[key] = `${Math.round(count / total * 100)}%`; return result }
          const chapters = chapterSplits.map((ch, idx) => {
            const chStats = stats[idx] || {}; const durationMin = ch.chapter_duration_seconds / 60
            const beats = (ch.beats_raw || []).map(b => ({ name: b.name, time: `${toTC(b.start_seconds)} - ${toTC(b.end_seconds)}`, description: b.description, purpose: b.purpose || '' }))
            const brollCount = chStats.broll?.count || 0; const gpCount = chStats.graphic_package?.count || 0; const overlayCount = chStats.overlay_image?.count || 0; const chTotal = brollCount + gpCount + overlayCount || 1
            return {
              chapter_number: ch.chapter_number, chapter_name: ch.chapter_name, time: `${ch.chapter_start_tc} - ${ch.chapter_end_tc}`, duration_seconds: ch.chapter_duration_seconds, purpose: ch.chapter_purpose, beats,
              frequency_and_timing: {
                broll: { count: brollCount, per_minute: Math.round(brollCount / durationMin * 10) / 10, avg_duration_seconds: chStats.broll?.avg_duration_seconds, what_footage_looks_like: toPct(chStats.broll?.by_source_feel, brollCount), what_content_is_shown: toPct(chStats.broll?.by_type_group, brollCount), why_its_used: toPct(chStats.broll?.by_function, brollCount) },
                graphic_package: { count: gpCount, per_minute: Math.round(gpCount / durationMin * 10) / 10, avg_duration_seconds: chStats.graphic_package?.avg_duration_seconds },
                overlay_image: { count: overlayCount, per_minute: Math.round(overlayCount / durationMin * 10) / 10, where_placed: toPct(chStats.overlay_image?.by_position, overlayCount) },
                usage_split: { broll_pct: Math.round(brollCount / chTotal * 100), graphic_package_pct: Math.round(gpCount / chTotal * 100), overlay_image_pct: Math.round(overlayCount / chTotal * 100) },
                by_beat: (chStats.by_beat || []).map(b => { const total = (b.broll || 0) + (b.graphic_package || 0) + (b.overlay_image || 0) || 1; return { beat_name: b.beat_name, broll_pct: `${Math.round((b.broll || 0) / total * 100)}%`, graphic_package_pct: `${Math.round((b.graphic_package || 0) / total * 100)}%`, overlay_image_pct: `${Math.round((b.overlay_image || 0) / total * 100)}%`, total } }),
              },
              pattern_analysis: parsedLlmResults[idx] || null,
            }
          })
          stageOutput = JSON.stringify({ a_roll: aRollData, total_chapters: chapters.length, overall_usage_split: { broll: { count: totalBroll, pct: Math.round(totalBroll / totalElements * 100) }, graphic_package: { count: totalGP, pct: Math.round(totalGP / totalElements * 100) }, overlay_image: { count: totalOverlay, pct: Math.round(totalOverlay / totalElements * 100) } }, chapters }, null, 2)
        } else {
          stageOutput = currentTranscript
        }
      }

      // Update isolated state
      totalTokensIn += stageTokensIn
      totalTokensOut += stageTokensOut
      totalCost += stageCost
      return stageOutput
    }, { label: `"${videoLabel}" stage "${stageName}"`, abortSignal: pipelineAbort.signal })

    // Post-stage state updates (outside retry — only runs on success)
    stageOutputs.push(output)

    const isQuestion = stage.type === 'video_question' || stage.type === 'transcript_question'
    if (isQuestion || (target === 'examples' && (stage.type === 'video_llm'))) {
      if (isQuestion) {
        questionCount++
        llmAnswer = output
        llmAnswers[questionCount] = output
      }
      examplesOutput = output
    }

    // Store main stage run in DB
    const stageRuntime = Date.now() - stageStart
    await db.prepare(`
      INSERT INTO broll_runs (strategy_id, video_id, step_name, status, input_text, output_text, prompt_used, system_instruction_used, model, tokens_in, tokens_out, cost, runtime_ms, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      strategyId, mainVideoId, 'analysis', 'complete',
      '', output,
      stage.prompt || '', stage.system_instruction || '',
      stage.model || 'programmatic',
      0, 0, 0, stageRuntime,
      JSON.stringify({ pipelineId, stageIndex: i, totalStages: analysisStagesTemplate.length, stageName, stageType: stage.type, target, phase: 'analysis', videoLabel, videoId: video.id, isFavorite, analysisStageCount: analysisStagesTemplate.length, groupId }),
    )

    if (totalCost > 0) {
      await db.prepare('INSERT INTO spending_log (total_cost, total_tokens, total_runtime_ms, source, created_at) VALUES (?, ?, ?, ?, ?)').run(
        totalCost, totalTokensIn + totalTokensOut, stageRuntime, `broll analysis ${pipelineId} ${videoLabel} stage ${i}`, new Date().toISOString()
      )
    }

    console.log(`[broll-analysis] "${videoLabel}" stage ${i + 1}/${analysisStagesTemplate.length} done ($${totalCost.toFixed(4)})`)
  }

  // Return results — last stageOutput is the assembled analysis, stage index 1 output is chapter analysis
  return {
    videoId: video.id,
    videoLabel,
    isFavorite,
    assembledOutput: stageOutputs[stageOutputs.length - 1] || '',
    chapterAnalysis: stageOutputs[1] || '', // template index 1 = chapters stage (matches existing logic)
    stageOutputs,
    totalTokensIn,
    totalTokensOut,
    totalCost,
  }
}
```

- [ ] **Step 2: Verify no syntax errors**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && node -c server/services/broll.js`
Expected: no output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add server/services/broll.js
git commit -m "feat: add runVideoAnalysis function for parallel analysis"
```

---

### Task 3: Modify `executePipeline` to run analysis in parallel

**Files:**
- Modify: `server/services/broll.js` — replace lines ~1730-1800 (analysis expansion + standalone expansion)

The key change: instead of expanding analysis stages into the combined array and running them sequentially in the main loop, run them as a parallel pre-step.

- [ ] **Step 1: Replace the analysis expansion block**

Replace the block at lines 1730-1800 (from `if (analysisStagesTemplate.length && exampleVideos.length) {` through the standalone analysis expansion) with parallel execution:

**Old code** (lines 1730-1800): builds `combined` array by iterating each video × each analysis stage, then the plan stages, then alt plan stages. Also handles standalone analysis (lines 1777-1800).

**New code:**

```javascript
    if (analysisStagesTemplate.length && exampleVideos.length) {
      // ── Run analysis for all videos in PARALLEL ──
      console.log(`[broll-pipeline] Starting parallel analysis for ${exampleVideos.length} videos`)
      brollPipelineProgress.set(pipelineId, { ...pipelineMeta, stageIndex: 0, totalStages: analysisStagesTemplate.length + planStages.length, status: 'running', stageName: `Analyzing ${exampleVideos.length} videos in parallel...`, phase: 'analysis', subDone: 0, subTotal: exampleVideos.length, subLabel: '' })

      const analysisPromises = exampleVideos.map(vid =>
        runVideoAnalysis(vid, analysisStagesTemplate, {
          pipelineId,
          strategyId,
          mainVideoId: videoId,
          groupId,
          pipelineAbort,
          abortedSet: abortedBrollPipelines,
          progressMap: brollPipelineProgress,
          pipelineMeta,
          exampleVideos,
          mainTranscript,
        })
      )

      let completedCount = 0
      const analysisResults = await Promise.all(
        analysisPromises.map(p => p.then(result => {
          completedCount++
          brollPipelineProgress.set(pipelineId, {
            ...pipelineMeta,
            stageIndex: 0,
            totalStages: analysisStagesTemplate.length + planStages.length,
            status: 'running',
            stageName: `Analysis: ${completedCount}/${exampleVideos.length} videos done`,
            phase: 'analysis',
            subDone: completedCount,
            subTotal: exampleVideos.length,
            subLabel: `${result.videoLabel} complete`,
          })
          console.log(`[broll-pipeline] Analysis complete for "${result.videoLabel}" (${completedCount}/${exampleVideos.length})`)
          return result
        }))
      )

      // Merge results into pipeline state
      for (const result of analysisResults) {
        analysisOutputs[result.videoId] = result.assembledOutput
        if (result.chapterAnalysis) {
          chapterAnalyses[result.videoId] = result.chapterAnalysis
        }
        totalTokensIn += result.totalTokensIn
        totalTokensOut += result.totalTokensOut
        totalCost += result.totalCost
      }

      // Set referenceAnalysis from favorite
      if (favoriteVideo) {
        referenceAnalysis = analysisOutputs[favoriteVideo.id] || ''
        console.log(`[broll-pipeline] referenceAnalysis from favorite "${favoriteVideo.title || favoriteVideo.id}" (${referenceAnalysis.length} chars)`)
      }

      console.log(`[broll-pipeline] All ${exampleVideos.length} analyses complete ($${totalCost.toFixed(4)})`)

      // Build stages: plan + alt_plan only (analysis already done)
      const combined = []
      planPhaseStartIdx = 0
      for (const s of planStages) {
        combined.push({ ...JSON.parse(JSON.stringify(s)), _phase: 'plan' })
      }

      if (altPlanStagesTemplate.length) {
        for (const vid of altVideos) {
          const label = vid.title || `Video #${vid.id}`
          const startIdx = combined.length
          for (const s of altPlanStagesTemplate) {
            combined.push({ ...JSON.parse(JSON.stringify(s)), _phase: 'alt_plan', _videoId: vid.id, _videoLabel: label })
          }
          altPlanPhases.push({ videoId: vid.id, videoTitle: label, startIdx, endIdx: combined.length - 1, stageCount: altPlanStagesTemplate.length })
        }
      }

      stages = combined
      analysisStageCount = 0 // analysis is done, not in stages array
      console.log(`[broll-pipeline] Remaining stages: ${planStages.length} plan + ${altPlanPhases.length * (altPlanStagesTemplate.length || 0)} alt plan`)
    }
```

- [ ] **Step 2: Update the standalone analysis path**

Replace the standalone analysis expansion block (was lines ~1777-1800) similarly. This handles analysis-only strategies (no plan) with multiple videos:

```javascript
  // For standalone analysis strategies with multiple example videos: run in parallel
  if (!strategy.main_strategy_id && exampleVideos.length > 1) {
    console.log(`[broll-pipeline] Starting parallel standalone analysis for ${exampleVideos.length} videos`)

    const analysisPromises = exampleVideos.map(vid =>
      runVideoAnalysis(vid, planStages, {
        pipelineId,
        strategyId,
        mainVideoId: videoId,
        groupId,
        pipelineAbort,
        abortedSet: abortedBrollPipelines,
        progressMap: brollPipelineProgress,
        pipelineMeta,
        exampleVideos,
        mainTranscript,
      })
    )

    const analysisResults = await Promise.all(analysisPromises)

    for (const result of analysisResults) {
      analysisOutputs[result.videoId] = result.assembledOutput
      if (result.chapterAnalysis) chapterAnalyses[result.videoId] = result.chapterAnalysis
      totalTokensIn += result.totalTokensIn
      totalTokensOut += result.totalTokensOut
      totalCost += result.totalCost
    }

    // No more stages to run — return directly
    const totalRuntime = Date.now() - Date.now() // will be set properly below
    // Set stages to empty so the main loop is skipped
    stages = []
    analysisStageCount = 0
    console.log(`[broll-pipeline] Standalone parallel analysis complete for ${exampleVideos.length} videos`)
  }
```

- [ ] **Step 3: Remove phase transition analysis logic from main loop**

In the main `for` loop (around line 2050-2062), the phase transition code that collects `analysisOutputs` after each video's analysis stages is no longer needed (analysis is done before the loop). Remove or guard the analysis phase transition block:

```javascript
      // ── Phase transitions ──
      // Analysis is now done as a parallel pre-step.
      // Only alt_plan phase transitions remain:
```

The block at lines 2050-2062 should be removed:
```javascript
      // DELETE: for (const ap of analysisPhases) { ... }
```

The plan phase start block (lines 2066-2071) should also be removed since `referenceAnalysis` is already set after parallel analysis:
```javascript
      // DELETE: if (analysisStageCount && i === planPhaseStartIdx && !referenceAnalysis && favoriteVideo) { ... }
```

Keep the alt_plan phase transition (lines 2074-2081) and the favorite plan capture (lines 2085-2093) — these still apply.

- [ ] **Step 4: Move `totalTokensIn/Out/Cost` declarations before the parallel analysis block**

The `totalTokensIn`, `totalTokensOut`, `totalCost` variables are currently declared at line 1863, which is after the parallel analysis block. They need to be declared before. Move them up or ensure the parallel block can accumulate into them.

Check that lines 1852-1863 (pipeline state declarations) appear BEFORE the parallel analysis code. If the parallel analysis code is inserted at ~1730 (before pipeline state), move the cost/token declarations to before the parallel block.

Actually — the parallel analysis code runs at ~1730, but `totalTokensIn/Out/Cost` and `mainTranscript` are declared at ~1853-1863, AFTER the parallel block. We need to restructure: move `mainTranscript` resolution and cost variable declarations to BEFORE the parallel analysis block.

Move these lines (currently ~1802-1863) to before the analysis parallel block (~before 1714):

```javascript
  // Resolve main video transcript (needed for parallel analysis)
  const { content: mainTranscript, resolved: resolvedSource } = await resolveTranscript(videoId, transcriptSource)

  // Cost tracking
  let totalTokensIn = 0, totalTokensOut = 0, totalCost = 0
```

The remaining pipeline state vars (`currentTranscript`, `segments`, etc.) stay where they are — they're only needed by the main loop.

- [ ] **Step 5: Verify no syntax errors**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && node -c server/services/broll.js`
Expected: no output (clean parse)

- [ ] **Step 6: Commit**

```bash
git add server/services/broll.js
git commit -m "feat: run reference video analysis in parallel via Promise.all"
```

---

### Task 4: Manual testing

- [ ] **Step 1: Start the dev server**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval" && npm run dev
```

- [ ] **Step 2: Test with multiple reference videos**

From the B-Roll page in the browser:
1. Select a group that has 2-3 reference videos
2. Click Run on a plan strategy
3. Watch the progress — should show "Analyzing N videos in parallel" then "Analysis: X/N videos done"
4. After analysis completes, plan phase should proceed normally
5. Verify the assembled outputs appear in the pipeline results

- [ ] **Step 3: Test with single reference video**

1. Select a group with only 1 reference video
2. Run the pipeline — should still work (parallel with 1 video = sequential)

- [ ] **Step 4: Test abort during analysis**

1. Start a pipeline with multiple reference videos
2. Abort mid-analysis
3. Verify clean shutdown — no hanging promises or error spam

- [ ] **Step 5: Check logs for retry behavior**

If rate limits are hit during parallel analysis, logs should show:
```
[broll-pipeline] "Video A" stage "Analyze B-Roll per minute" failed (attempt 1/3), retrying in 5s: ...
```
