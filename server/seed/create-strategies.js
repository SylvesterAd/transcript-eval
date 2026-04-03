import db from '../db.js'

;(async () => {
console.log('Creating strategies...')

// Strategy 1: Segmented Multi-Pass Cleaning
const s1 = await db.prepare("SELECT id FROM strategies WHERE name = 'Segmented Multi-Pass Cleaning'").get()
let strategy1Id
if (!s1) {
  const r = await db.prepare("INSERT INTO strategies (name, description) VALUES (?, ?)").run(
    'Segmented Multi-Pass Cleaning',
    'Production workflow: segment transcript into 40-80s chunks, clean fillers per-segment, then run full-text passes for false starts and meta commentary.'
  )
  strategy1Id = r.lastInsertRowid
} else {
  strategy1Id = s1.id
}

// Check if version already exists
const sv1 = await db.prepare("SELECT id FROM strategy_versions WHERE strategy_id = ? AND version_number = 1").get(strategy1Id)
if (!sv1) {
  const stages = [
    {
      name: '1. Segment Transcript',
      type: 'programmatic',
      action: 'segment',
      actionParams: { minSeconds: 40, maxSeconds: 80, contextSeconds: 30 },
      description: 'Divide transcript into 40-80s segments ending at sentence boundaries, with 30s of surrounding context for each segment.',
    },
    {
      name: '2. Remove Fillers & Obvious False Starts (per segment)',
      type: 'llm_parallel',
      model: 'claude-sonnet-4-20250514',
      system_instruction: `You are a transcript editor. You will receive a transcript segment with context before and after marked clearly.

Your task: In the MAIN SEGMENT only (not the context), identify and DELETE:
- All filler words: um, uh, erm, like (when used as filler), you know, I mean, basically, so, right, yeah
- Obvious false starts: when the speaker starts a word/phrase and restarts it

Rules:
- Only modify text in the MAIN SEGMENT section
- Do NOT touch the CONTEXT BEFORE or CONTEXT AFTER sections
- Return ONLY the cleaned main segment text (no context, no markers)
- Preserve all timecodes [HH:MM:SS] exactly
- Preserve all pause markers [X.Xs] exactly
- Keep all punctuation and sentence structure intact
- Do not rephrase or rewrite — only delete filler/false starts`,
      prompt: `Clean this transcript segment by removing filler words and obvious false starts from the MAIN SEGMENT only.

{{transcript}}

Return ONLY the cleaned main segment text.`,
      params: { temperature: 0.1 },
      description: 'Run each segment through LLM separately to remove filler words and obvious false starts. Context prevents cutting across boundaries.',
    },
    {
      name: '3. Reassemble Clean Text',
      type: 'programmatic',
      action: 'reassemble',
      description: 'Combine all cleaned segments back into a single transcript.',
    },
    {
      name: '4. False Starts — Full Text Pass 1',
      type: 'llm',
      model: 'claude-sonnet-4-20250514',
      system_instruction: `You are a transcript editor specializing in removing false starts.

A false start is when the speaker:
- Starts a sentence/thought and abandons it to restart
- Repeats a word or phrase (stuttering)
- Begins with one idea and immediately switches to another

Rules:
- Remove all false starts you can find
- Preserve all timecodes [HH:MM:SS] and pause markers [X.Xs]
- Do not rephrase or rewrite — only delete false starts
- Return the full cleaned transcript`,
      prompt: `Review this transcript and remove all remaining false starts. Return the full cleaned text.

{{transcript}}`,
      params: { temperature: 0.1 },
      description: 'First full-text pass to catch false starts that span segment boundaries or were missed in per-segment cleaning.',
    },
    {
      name: '5. False Starts — Full Text Pass 2',
      type: 'llm',
      model: 'claude-sonnet-4-20250514',
      system_instruction: `You are a transcript editor. This transcript has already been cleaned once for false starts.
Do another careful pass to find any remaining false starts that were missed.

A false start is when the speaker starts a sentence/thought and abandons it to restart.

Rules:
- Only remove clear false starts — do not remove intentional repetition for emphasis
- Preserve all timecodes [HH:MM:SS] and pause markers [X.Xs]
- Return the full cleaned transcript`,
      prompt: `Do a second pass on this transcript to catch any remaining false starts. Return the full cleaned text.

{{transcript}}`,
      params: { temperature: 0.1 },
      description: 'Second pass to catch any false starts missed in the first full-text pass.',
    },
    {
      name: '6. Meta Commentary — Pass 1',
      type: 'llm',
      model: 'claude-sonnet-4-20250514',
      system_instruction: `You are a transcript editor specializing in removing meta commentary.

Meta commentary includes:
- References to the recording/video itself ("make sure to subscribe", "as I mentioned in my last video")
- Channel/platform references ("hit the like button", "comment below", "check the description")
- Sponsor mentions and ad reads
- Self-referential statements about the act of speaking ("let me explain", "what I'm trying to say is")
- Asides to the audience that aren't part of the main content

Rules:
- Remove meta commentary while preserving the flow of content
- Preserve all timecodes [HH:MM:SS] and pause markers [X.Xs]
- Do not remove content that is part of the main narrative
- Return the full cleaned transcript`,
      prompt: `Remove all meta commentary from this transcript. Return the full cleaned text.

{{transcript}}`,
      params: { temperature: 0.1 },
      description: 'First pass to identify and remove meta commentary (subscribe reminders, sponsor mentions, self-references).',
    },
    {
      name: '7. Meta Commentary — Pass 2',
      type: 'llm',
      model: 'claude-sonnet-4-20250514',
      system_instruction: `You are a transcript editor. This transcript has already been cleaned once for meta commentary.
Do another careful pass to find any remaining meta commentary.

Rules:
- Only remove clear meta commentary — do not remove content discussion
- Preserve all timecodes [HH:MM:SS] and pause markers [X.Xs]
- Return the full cleaned transcript`,
      prompt: `Do a second pass to catch any remaining meta commentary. Return the full cleaned text.

{{transcript}}`,
      params: { temperature: 0.1 },
      description: 'Final pass to catch any remaining meta commentary.',
    },
  ]

  await db.prepare("INSERT INTO strategy_versions (strategy_id, version_number, stages_json, notes) VALUES (?, ?, ?, ?)").run(
    strategy1Id, 1, JSON.stringify(stages),
    'Production workflow: segment → parallel filler clean → reassemble → 2x false start passes → 2x meta commentary passes'
  )
  console.log('  Created: Segmented Multi-Pass Cleaning v1 (7 stages)')
}

// Strategy 2: Simple Full-Text Cleaning (for UX comparison)
const s2 = await db.prepare("SELECT id FROM strategies WHERE name = 'Simple Full-Text Clean'").get()
let strategy2Id
if (!s2) {
  const r = await db.prepare("INSERT INTO strategies (name, description) VALUES (?, ?)").run(
    'Simple Full-Text Clean',
    'Baseline single-pass approach: send entire transcript through one LLM call to clean everything at once.'
  )
  strategy2Id = r.lastInsertRowid
} else {
  strategy2Id = s2.id
}

const sv2 = await db.prepare("SELECT id FROM strategy_versions WHERE strategy_id = ? AND version_number = 1").get(strategy2Id)
if (!sv2) {
  const stages = [
    {
      name: 'Full-Text Clean',
      type: 'llm',
      model: 'claude-sonnet-4-20250514',
      system_instruction: `You are a professional transcript editor. Clean the given transcript by removing:

1. Filler words (um, uh, like, you know, I mean, basically, so, right, yeah, erm)
2. False starts (when the speaker starts and restarts a thought)
3. Meta commentary (subscribe reminders, sponsor mentions, self-references about the video)

Rules:
- Preserve all timecodes [HH:MM:SS] exactly as they are
- Preserve all pause markers [X.Xs] exactly as they are
- Do not rephrase, rewrite, or add any text
- Only delete — never add new content
- Maintain natural flow and readability
- Return the full cleaned transcript`,
      prompt: `Clean this transcript by removing filler words, false starts, and meta commentary. Return the full cleaned text.

{{transcript}}`,
      params: { temperature: 0.1, max_tokens: 8192 },
      description: 'Single pass: send entire transcript for comprehensive cleaning in one shot.',
    },
  ]

  await db.prepare("INSERT INTO strategy_versions (strategy_id, version_number, stages_json, notes) VALUES (?, ?, ?, ?)").run(
    strategy2Id, 1, JSON.stringify(stages),
    'Baseline: single LLM pass to clean everything at once'
  )
  console.log('  Created: Simple Full-Text Clean v1 (1 stage)')
}

console.log('Strategies created successfully.')
})()
