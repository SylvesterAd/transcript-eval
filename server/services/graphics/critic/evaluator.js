// server/services/graphics/critic/evaluator.js
//
// VLM critic. Sends N PNG frames + the spec to Gemini 3 Flash, asks for
// a structured score JSON, parses, returns. Throws on parse error so the
// caller can decide whether to retry with the same frames or skip.

import { readFile } from 'node:fs/promises'
import { callGemini } from '../../../lib/llm/gemini.js'

const SYSTEM_PROMPT = `You are a senior motion-graphics art director reviewing a rendered short clip frame-by-frame. You will receive a spec and N evenly-spaced keyframes from a single render.

Score the render across four criteria, each 0.0-1.0:
- fidelity: does the frame match the spec (template, text content, tone)?
- legibility: is text readable, contrast sufficient, no clipping?
- style: does it look like professional motion graphics, not LLM slop?
- timing: do the frames suggest a coherent animation arc (entry → hold → exit)?

Output ONLY this JSON shape, no markdown fences, no commentary:
{
  "score": 0.0-1.0,
  "criteria": { "fidelity": 0.0, "legibility": 0.0, "style": 0.0, "timing": 0.0 },
  "feedback": "one paragraph of specific actionable critique",
  "retry_recommended": true|false
}`

export async function evaluateFrames({ framePaths, spec }) {
  const imageParts = await Promise.all(
    framePaths.map(async (p) => {
      const buf = await readFile(p)
      return { inlineData: { mimeType: 'image/png', data: buf.toString('base64') } }
    })
  )
  const r = await callGemini({
    model: 'gemini-3-flash-preview',
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { text: `Spec:\n${JSON.stringify(spec, null, 2)}\n\nFrames (in time order):` },
          ...imageParts,
        ],
      },
    ],
    max_tokens: 512,
  })
  let parsed
  try {
    const trimmed = r.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '')
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error(`critic returned invalid JSON: ${r.text.slice(0, 200)}`)
  }
  return {
    score: parsed.score,
    criteria: parsed.criteria,
    feedback: parsed.feedback,
    retry_recommended: parsed.retry_recommended,
    tokens: r.tokens,
  }
}
