import { Router } from 'express'
import db from '../db.js'

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

  db.prepare(
    'UPDATE strategy_versions SET stages_json = ?, notes = ? WHERE id = ?'
  ).run(JSON.stringify(stages || []), notes !== undefined ? notes : version.notes, req.params.versionId)

  const updated = db.prepare('SELECT * FROM strategy_versions WHERE id = ?').get(req.params.versionId)
  res.json(updated)
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
  "actionParams": { "minSeconds": 40, "maxSeconds": 80, "contextSeconds": 30 }
}
\`\`\`
- minSeconds/maxSeconds: target segment duration range (default 40-80)
- contextSeconds: overlap with previous segment for continuity (default 30)

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
\`\`\`json
{
  "name": "Clean Segments",
  "type": "llm_parallel",
  "model": "gemini-3-flash-preview",
  "system_instruction": "You are a transcript editor...",
  "prompt": "Process segment {{segment_number}} of {{total_segments}}:\\n\\n{{transcript}}",
  "description": "Per-segment filler word removal"
}
\`\`\`

## TEMPLATE VARIABLES FOR PROMPTS
- \`<transcript>\` or \`{{transcript}}\` — the transcript text (REQUIRED in every LLM prompt)
- \`{{segment_number}}\` — current segment number (only in llm_parallel)
- \`{{total_segments}}\` — total segment count (only in llm_parallel)

## AVAILABLE MODELS (use ONLY these)
- gemini-3.1-pro-preview (Gemini 3.1 Pro — best quality, supports thinking)
- gemini-3-flash-preview (Gemini 3 Flash — fast, good balance, supports thinking)
- gpt-5.4 (GPT 5.4 — high quality, no thinking support)
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

## OUTPUT FORMAT
You MUST respond with valid JSON in this exact structure, nothing else:
\`\`\`json
{
  "name": "Short Flow Name",
  "explanation": "2-4 sentence explanation of what this pipeline does and why these stages were chosen.",
  "stages": [ ...array of stage objects as defined above... ]
}
\`\`\`

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
          max_tokens: 8192,
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
          max_tokens: 8192,
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
