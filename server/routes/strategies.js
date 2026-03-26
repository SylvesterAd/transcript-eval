import { Router } from 'express'
import db from '../db.js'
import { findFirstChangedIndex, invalidateFromIndex } from '../services/stage-diff.js'

const router = Router()

// List all strategies with latest version info
router.get('/', (req, res) => {
  const strategies = db.prepare(`
    SELECT s.*,
      (SELECT MAX(sv.version_number) FROM strategy_versions sv WHERE sv.strategy_id = s.id) AS latest_version,
      (SELECT COUNT(*) FROM strategy_versions sv WHERE sv.strategy_id = s.id) AS version_count,
      (SELECT sv.stages_json FROM strategy_versions sv WHERE sv.strategy_id = s.id ORDER BY sv.version_number DESC LIMIT 1) AS stages_json,
      (SELECT sv.id FROM strategy_versions sv WHERE sv.strategy_id = s.id ORDER BY sv.version_number DESC LIMIT 1) AS latest_version_id,
      COALESCE(
        (SELECT MAX(sv.created_at) FROM strategy_versions sv WHERE sv.strategy_id = s.id),
        s.created_at
      ) AS updated_at
    FROM strategies s ORDER BY s.created_at DESC
  `).all()
  res.json(strategies)
})

// Get strategy with all versions
router.get('/:id', (req, res) => {
  const strategy = db.prepare('SELECT * FROM strategies WHERE id = ?').get(req.params.id)
  if (!strategy) return res.status(404).json({ error: 'Strategy not found' })

  const versions = db.prepare(
    'SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version_number DESC'
  ).all(req.params.id)

  res.json({ ...strategy, versions })
})

// Create strategy
router.post('/', (req, res) => {
  const { name, description } = req.body
  if (!name) return res.status(400).json({ error: 'Name is required' })

  const result = db.prepare(
    'INSERT INTO strategies (name, description) VALUES (?, ?)'
  ).run(name, description || null)

  const strategy = db.prepare('SELECT * FROM strategies WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(strategy)
})

// Create strategy version
router.post('/:id/versions', (req, res) => {
  const { stages, notes } = req.body
  const strategy = db.prepare('SELECT * FROM strategies WHERE id = ?').get(req.params.id)
  if (!strategy) return res.status(404).json({ error: 'Strategy not found' })

  const latest = db.prepare(
    'SELECT MAX(version_number) AS max_v FROM strategy_versions WHERE strategy_id = ?'
  ).get(req.params.id)

  const nextVersion = (latest.max_v || 0) + 1

  const result = db.prepare(
    'INSERT INTO strategy_versions (strategy_id, version_number, stages_json, notes) VALUES (?, ?, ?, ?)'
  ).run(req.params.id, nextVersion, JSON.stringify(stages || []), notes || null)

  const version = db.prepare('SELECT * FROM strategy_versions WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(version)
})

// Get specific version
router.get('/:id/versions/:versionId', (req, res) => {
  const version = db.prepare(
    'SELECT * FROM strategy_versions WHERE id = ? AND strategy_id = ?'
  ).get(req.params.versionId, req.params.id)
  if (!version) return res.status(404).json({ error: 'Version not found' })
  res.json(version)
})

// Update strategy version
router.put('/:id/versions/:versionId', (req, res) => {
  const { stages, notes } = req.body
  const version = db.prepare(
    'SELECT * FROM strategy_versions WHERE id = ? AND strategy_id = ?'
  ).get(req.params.versionId, req.params.id)
  if (!version) return res.status(404).json({ error: 'Version not found' })

  const oldStages = JSON.parse(version.stages_json || '[]')
  const newStages = stages || []

  db.prepare(
    'UPDATE strategy_versions SET stages_json = ?, notes = ? WHERE id = ?'
  ).run(JSON.stringify(newStages), notes !== undefined ? notes : version.notes, req.params.versionId)

  // Invalidate affected experiment runs
  const changedFrom = findFirstChangedIndex(oldStages, newStages)
  let invalidated = 0
  if (changedFrom !== null) {
    invalidated = invalidateFromIndex(db, version.id, changedFrom, newStages.length)
    if (invalidated > 0) {
      console.log(`[strategies] Invalidated ${invalidated} run(s) from stage ${changedFrom} onward`)
    }
  }

  const updated = db.prepare('SELECT * FROM strategy_versions WHERE id = ?').get(req.params.versionId)
  res.json({ ...updated, invalidated })
})

// Generate short LLM description for a strategy
router.post('/:id/summarize', async (req, res) => {
  const strategy = db.prepare('SELECT * FROM strategies WHERE id = ?').get(req.params.id)
  if (!strategy) return res.status(404).json({ error: 'Strategy not found' })

  const version = db.prepare(
    'SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version_number DESC LIMIT 1'
  ).get(req.params.id)

  if (!version) return res.status(400).json({ error: 'No version found' })

  const stages = JSON.parse(version.stages_json || '[]')
  if (stages.length === 0) return res.json({ summary: 'Empty flow — no stages defined.' })

  // Build a concise description of the pipeline
  const stageDescriptions = stages.map((s, i) => {
    if (s.type === 'programmatic') {
      return `Stage ${i+1}: [Programmatic] ${s.action} (${s.description || ''})`
    }
    const mode = s.type === 'llm_parallel' ? 'per-segment' : 'whole-transcript'
    const model = s.model || 'unknown'
    const sysPreview = s.system_instruction ? s.system_instruction.slice(0, 150) : ''
    const promptPreview = s.prompt ? s.prompt.slice(0, 200) : ''
    return `Stage ${i+1}: [${mode}] model=${model}\n  System: ${sysPreview}\n  Prompt: ${promptPreview}`
  }).join('\n\n')

  const prompt = `Describe this transcript processing workflow in 1-2 short sentences. Be specific about what each stage does. No markdown.

Flow name: ${strategy.name}
${stageDescriptions}`

  try {
    const apiKey = process.env.OPENAI_API_KEY
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4.1-nano',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.3,
      })
    })
    if (!r.ok) throw new Error(`API error ${r.status}`)
    const data = await r.json()
    const summary = data.choices?.[0]?.message?.content?.trim() || ''

    // Save to strategy description
    db.prepare('UPDATE strategies SET description = ? WHERE id = ?').run(summary, strategy.id)

    res.json({ summary })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// AI-propose a transcript processing workflow
router.post('/ai-propose', async (req, res) => {
  const { message, history, model = 'gemini-3.1-pro-preview' } = req.body

  const systemInstruction = `You are a transcript processing workflow designer. You design multi-stage pipelines that clean, edit, and improve raw video transcripts.

## YOUR TASK
Design a transcript processing workflow as a JSON array of stages. The user may describe what they want, or ask you to propose a good default. Your response must be a single JSON object (see OUTPUT FORMAT below) that includes both an explanation and the stages array.

## AVAILABLE STAGE TYPES

### 1. Programmatic: "segment"
Splits a long transcript into overlapping time-based segments for parallel processing.
\`\`\`json
{
  "name": "Segment Transcript",
  "type": "programmatic",
  "action": "segment",
  "description": "Split into segments for parallel processing",
  "actionParams": { "preset": "short", "minSeconds": 40, "maxSeconds": 60, "contextSeconds": 30 }
}
\`\`\`
Available presets (use ONLY these):
- "short": 40-60s segments, 30s context — best for dense/technical content
- "medium": 60-100s segments, 30s context — best for interviews, mixed content (RECOMMENDED DEFAULT)
- "long": 100-130s segments, 30s context — best for casual conversation, monologues
Always include both "preset" AND the raw numbers in actionParams.

### 2. Programmatic: "reassemble"
Rejoins processed segments back into a single transcript.
\`\`\`json
{
  "name": "Reassemble",
  "type": "programmatic",
  "action": "reassemble",
  "description": "Rejoin cleaned segments into full transcript"
}
\`\`\`

### 3. LLM: "llm" (whole transcript)
Sends the ENTIRE transcript to an LLM in one call. Best for short transcripts or final cleanup passes.
\`\`\`json
{
  "name": "Final Cleanup",
  "type": "llm",
  "model": "gemini-3-flash-preview",
  "system_instruction": "You are a transcript editor...",
  "prompt": "Clean this transcript:\\n\\n<transcript>",
  "description": "Full-transcript cleanup pass"
}
\`\`\`

### 4. LLM: "llm_parallel" (per segment)
Sends EACH segment separately to an LLM. Must be used between a "segment" and "reassemble" stage. Much more cost-effective for long transcripts.

How it works at runtime:
- The {{transcript}} variable gets replaced with a SINGLE formatted segment (NOT the whole transcript)
- The LLM receives one segment at a time in this exact format:

<context>
[00:01:00] Previous surrounding text for reference...
*****
<segment>
[00:01:30] This is the main text to edit...
*****
<context>
[00:02:35] Following surrounding text for reference...

- <context> = surrounding text, read for continuity, do NOT edit or output
- <segment> (between *****) = the ONLY part to edit and return
- The LLM must output ONLY the cleaned <segment> content, no markers or tags

The system_instruction for llm_parallel stages MUST explain this format. Example:

\`\`\`json
{
  "name": "Clean Segments",
  "type": "llm_parallel",
  "model": "gemini-3-flash-preview",
  "system_instruction": "You are a transcript editor. You receive transcript segments in a special format: <context> sections contain surrounding text for reference — read them to maintain continuity but do NOT modify or include in your output. The <segment> section between ***** markers is the ONLY part you must edit and return. Output ONLY the cleaned segment content, no ***** markers, no <context>, no <segment> tags. YOUR TASK: [specific editing instructions here]",
  "prompt": "Process segment {{segment_number}} of {{total_segments}}:\\n\\n{{transcript}}",
  "description": "Per-segment filler word removal"
}
\`\`\`
CRITICAL: Every llm_parallel system_instruction MUST explain the ***** and <context>/<segment> format as shown above. If missing, the LLM will not understand the segment boundaries and the workflow will fail.

## OUTPUT MODE (optional field for LLM stages)
By default (no output_mode field), the LLM returns the cleaned transcript text directly. You can add an \`"output_mode"\` field to change this behavior:

- **"deletion"**: LLM returns a JSON array identifying text to DELETE by timecode. The system removes those parts programmatically. Use when the LLM's job is to identify unwanted content (meta-commentary, filler, off-topic tangents).
- **"keep_only"**: LLM returns a JSON array identifying text to KEEP. Everything else is removed. Use when the LLM's job is to identify the valuable/relevant content.

Do NOT set output_mode for standard editing tasks (filler removal, grammar fixes, formatting) — just omit the field entirely.

### Deletion mode example:
\`\`\`json
{
  "name": "Remove Meta-Commentary",
  "type": "llm",
  "model": "gemini-3.1-pro-preview",
  "output_mode": "deletion",
  "system_instruction": "You are a transcript editor. Identify all meta-commentary, self-corrections, and off-topic tangents in this transcript.",
  "prompt": "Find all meta-commentary and off-topic segments to delete:\\n\\n{{transcript}}",
  "description": "Identify and remove meta-commentary by timecode"
}
\`\`\`
The LLM returns JSON like: \`[{"timecode": "[00:01:23]", "text": "Sorry, let me start over."}, {"timecode": "[00:05:30]"}, {"timecode": "[00:03:10]", "text": "basically like"}]\`
- "timecode" (REQUIRED) — the exact timecode from the transcript
- If "text" is OMITTED — the ENTIRE timecoded segment is deleted (timecode + all its text)
- If "text" is provided — only those exact words are deleted, timecode and remaining words stay
- "text" must be a VERBATIM substring from the transcript

### Keep-only mode example:
\`\`\`json
{
  "name": "Extract Key Points",
  "type": "llm",
  "model": "gemini-3.1-pro-preview",
  "output_mode": "keep_only",
  "system_instruction": "You are a transcript editor. Identify the most important and relevant segments of this transcript.",
  "prompt": "Select the segments worth keeping:\\n\\n{{transcript}}",
  "description": "Keep only the most relevant segments"
}
\`\`\`

### When to use output_mode:
- Use **"deletion"** when most of the transcript is good but you need to surgically remove specific parts
- Use **"keep_only"** when you need to extract specific relevant sections from a longer transcript
- For standard editing (grammar, fillers, formatting) — do NOT add output_mode, just let the LLM return cleaned text directly
- Deletion/keep_only modes work with both \`"llm"\` and \`"llm_parallel"\` stage types
- When used with \`"llm_parallel"\`: the LLM still receives <context>/<segment> markers, but the JSON timecodes should reference only timecodes within the <segment> section

## TEMPLATE VARIABLES FOR PROMPTS
- \`<transcript>\` or \`{{transcript}}\` — the transcript text (REQUIRED in every LLM prompt)
- \`{{segment_number}}\` — current segment number (only in llm_parallel)
- \`{{total_segments}}\` — total segment count (only in llm_parallel)

## AVAILABLE MODELS (use ONLY these)
- gemini-3.1-pro-preview (Gemini 3.1 Pro — best quality, supports thinking)
- gemini-3-flash-preview (Gemini 3 Flash — fast, good balance, supports thinking)
- gpt-5.4 (GPT 5.4 — high quality, supports thinking)
- claude-opus-4-20250514 (Claude Opus 4.6 — best quality, supports thinking)
- claude-sonnet-4-20250514 (Claude Sonnet 4.6 — good balance, supports thinking)

## PIPELINE DESIGN GUIDELINES
- For transcripts under 10 min: use "llm" (whole transcript) stages, no segmentation needed
- For transcripts 10+ min: use segment → llm_parallel → reassemble pattern
- Common pipeline: segment → clean fillers (llm_parallel) → reassemble → final polish (llm)
- You can chain multiple LLM stages for different tasks (e.g., remove fillers, then fix grammar, then format)
- System instructions should be VERY specific about what to keep vs remove
- Prompts must always include the transcript variable
- Choose cheaper models for simple tasks (filler removal), better models for nuanced editing

## IMPORTANT PROMPT DESIGN RULES
- System instructions should clearly define the editor's role and constraints
- Always tell the LLM to preserve timecodes in [HH:MM:SS] format
- Always tell the LLM to output ONLY the cleaned transcript, no commentary
- Be explicit about what counts as filler (um, uh, you know, like, basically, etc.)
- Be explicit about preserving meaning — never remove content-bearing words
- **MANDATORY for llm_parallel stages**: The system_instruction MUST start with the segment boundary explanation (about *****, <context>, <segment>) before any editing instructions. Copy the pattern from the llm_parallel example above. If missing, the workflow is INVALID.

## OUTPUT FORMAT
You MUST respond with valid JSON in this exact structure. Here is a COMPLETE example:
\`\`\`json
{
  "name": "Filler Removal Pipeline",
  "explanation": "Segments the transcript, removes filler words per segment using Gemini 3 Flash, then reassembles.",
  "stages": [
    {
      "name": "Segment Transcript",
      "type": "programmatic",
      "action": "segment",
      "description": "Split into medium segments for parallel processing",
      "actionParams": { "preset": "medium", "minSeconds": 60, "maxSeconds": 100, "contextSeconds": 30 }
    },
    {
      "name": "Remove Filler Words",
      "type": "llm_parallel",
      "model": "gemini-3-flash-preview",
      "system_instruction": "You are a transcript editor. You receive transcript segments in a special format: <context> sections contain surrounding text for reference — read them to maintain continuity but do NOT modify or include in your output. The <segment> section between ***** markers is the ONLY part you must edit and return. Output ONLY the cleaned segment content, no ***** markers, no <context>, no <segment> tags. YOUR TASK: Remove filler words (um, uh, like, you know, basically, sort of, I mean) while preserving all content-bearing words, meaning, and timecodes in [HH:MM:SS] format.",
      "prompt": "Process segment {{segment_number}} of {{total_segments}}:\\n\\n{{transcript}}",
      "description": "Per-segment filler word removal"
    },
    {
      "name": "Reassemble",
      "type": "programmatic",
      "action": "reassemble",
      "description": "Rejoin cleaned segments into full transcript"
    }
  ]
}
\`\`\`

Note: "type": "llm_parallel" = Per Segment processing (each segment sent to LLM separately). "type": "llm" = Whole Transcript processing (entire transcript in one call).

Do NOT include any text outside the JSON code block. Do NOT use markdown headings or bullets outside the JSON.`

  const userMsg = message || 'Propose a good default transcript processing workflow that removes filler words, cleans up grammar, and preserves timecodes. Use a segment-based approach for handling long transcripts.'

  try {
    let text
    const isGemini = model.startsWith('gemini-')
    const isOpenAI = model.startsWith('gpt-')
    const isClaude = model.startsWith('claude-')

    if (isGemini) {
      const apiKey = process.env.GOOGLE_API_KEY
      if (!apiKey) return res.status(500).json({ error: 'GOOGLE_API_KEY not set' })

      const contents = []
      if (history?.length) {
        for (const msg of history) {
          contents.push({ role: msg.role, parts: [{ text: msg.content }] })
        }
      }
      contents.push({ role: 'user', parts: [{ text: userMsg }] })

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: systemInstruction }] },
          generationConfig: {
            maxOutputTokens: 8192,
            temperature: 1,
            thinkingConfig: { thinkingLevel: 'HIGH' },
          },
        })
      })
      if (!r.ok) {
        const err = await r.text()
        throw new Error(`Gemini API error ${r.status}: ${err}`)
      }
      const data = await r.json()
      const parts = data.candidates?.[0]?.content?.parts || []
      const textPart = [...parts].reverse().find(p => p.text !== undefined && !p.thought)
      text = textPart?.text || ''

    } else if (isOpenAI) {
      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not set' })

      const messages = [{ role: 'system', content: systemInstruction }]
      if (history?.length) {
        for (const msg of history) {
          messages.push({ role: msg.role === 'model' ? 'assistant' : msg.role, content: msg.content })
        }
      }
      messages.push({ role: 'user', content: userMsg })

      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          temperature: 1,
        })
      })
      if (!r.ok) {
        const err = await r.text()
        throw new Error(`OpenAI API error ${r.status}: ${err}`)
      }
      const data = await r.json()
      text = data.choices?.[0]?.message?.content?.trim() || ''

    } else if (isClaude) {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })

      const messages = []
      if (history?.length) {
        for (const msg of history) {
          messages.push({ role: msg.role === 'model' ? 'assistant' : msg.role, content: msg.content })
        }
      }
      messages.push({ role: 'user', content: userMsg })

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          system: systemInstruction,
          messages,
          temperature: 1,
        })
      })
      if (!r.ok) {
        const err = await r.text()
        throw new Error(`Anthropic API error ${r.status}: ${err}`)
      }
      const data = await r.json()
      text = data.content?.find(b => b.type === 'text')?.text || ''

    } else {
      return res.status(400).json({ error: `Unsupported model: ${model}` })
    }

    // Parse JSON from response (may be wrapped in ```json ... ```)
    let parsed
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/)
    const rawJson = jsonMatch ? jsonMatch[1].trim() : text.trim()
    try {
      parsed = JSON.parse(rawJson)
    } catch {
      const objMatch = text.match(/\{[\s\S]*"stages"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
      if (objMatch) {
        parsed = JSON.parse(objMatch[0])
      } else {
        throw new Error('AI did not return valid JSON. Raw response: ' + text.slice(0, 500))
      }
    }

    if (!parsed.stages || !Array.isArray(parsed.stages)) {
      throw new Error('AI response missing stages array')
    }

    // Force-inject segment boundary rules into every llm_parallel system_instruction
    const SEGMENT_RULES = `\n\n## Important\nYou receive transcript segments in a special format: <context> sections contain surrounding text for reference — read them to maintain continuity but do NOT modify or include in your output. The <segment> section between ***** markers is the ONLY part you must process. Process ONLY the <segment> content — no ***** markers, no <context>, no <segment> tags in your response. If you are in deletion or keep_only mode, your JSON array must reference ONLY timecodes from within the <segment> section.`
    for (const stage of parsed.stages) {
      console.log(`[ai-propose] Stage "${stage.name}" type="${stage.type}"`)
      if (stage.type === 'llm_parallel') {
        stage.system_instruction = (stage.system_instruction || '') + SEGMENT_RULES
        console.log(`[ai-propose] Injected segment rules into "${stage.name}"`)
      }
    }

    res.json({
      name: parsed.name || 'AI-Proposed Flow',
      explanation: parsed.explanation || '',
      stages: parsed.stages,
      rawResponse: text,
    })
  } catch (err) {
    console.error('[ai-propose] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Delete strategy
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM strategy_versions WHERE strategy_id = ?').run(req.params.id)
  db.prepare('DELETE FROM strategies WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

export default router
