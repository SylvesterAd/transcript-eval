import db from '../db.js'

// Update plan_prep (strategy id=7) for the original-time domain.
//
// Final shape (4 stages):
//   [0] Generate post-cut transcript     (programmatic, no shift — original timecodes)
//   [1] Analyze A-Roll Appearances        (video_question, raw video)
//   [2] Analyze Chapters & Beats          (transcript_question, trimmed transcript)
//   [3] Split by chapter                  (programmatic, indexes 1 + 2)
//
// Idempotent: writes the canonical 4-stage layout regardless of what's
// currently in id=7. Earlier intermediate layouts (5 stages with
// export_post_cut_video, or 3 stages with merged analysis) both end up here.
//
// Re-run with:  node server/seed/update-plan-prep-original-time.js

const ver = await db.prepare(
  'SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = 7 ORDER BY created_at DESC LIMIT 1'
).get()
if (!ver) { console.error('No plan_prep (strategy_id=7) version found'); process.exit(1) }

const oldStages = JSON.parse(ver.stages_json)
console.log(`plan_prep current: ${oldStages.length} stages — [${oldStages.map(s => s.name).join('; ')}]`)

const transcriptStage = {
  name: 'Generate post-cut transcript',
  type: 'programmatic',
  target: 'text_only',
  action: 'generate_post_cut_transcript',
  actionParams: {},
  description: 'Remove cut words from the transcript while preserving original timecodes',
}

// ── A-Roll Appearances stage ─────────────────────────────────────────
const aRollSystem = `# Main Categories:
A-roll: Primary footage that carries the narrative (often a talking head/interview).
Overlay images: Non-text visual elements layered on top of the base visual to illustrate, reinforce, or direct attention (e.g., icons, logos/bugs, arrows, stickers, product images, floating screenshots, simple shapes). Overlay images can appear on A-roll only!
Graphic package / PiP: A layout template that defines the base visual (background + frames + placement). It usually contains A-roll inside a box, plus branded design elements. Key rule: turning the package off does change the whole screen composition (because the layout itself is the scene).
Key distinction: overlay images sit on top; a package rearranges the whole scene.
B-roll: Supporting footage used to illustrate the narration or cover A-roll (so the viewer doesn't see the talking head). B-roll can have its own overlays.

# IGNORE SUBTITLES
Subtitles = on-screen text at the bottom of the screen that transcribes or translates the spoken audio. If text on screen matches what is being said — it is a subtitle. Do NOT report subtitles. Ignore them completely.

You are a video structure analyst. Watch the video and output ONLY valid JSON. No commentary.`

const aRollPrompt = `Watch this video and identify:
1. Whether there is a main talking head (presenter/host) — someone whose lip movement matches the spoken audio
2. A-Roll appearance changes — moments where the talking head's visual setup CHANGES

## A-Roll appearance rules:
- A-Roll is ONLY the main talking head on camera with lip-sync matching the audio
- Describe the INITIAL appearance first (id: 1). This is the default look
- Then ONLY add more entries when something VISUALLY CHANGES: different room, different outfit, different lighting, different camera setup
- If the talking head looks the same the entire video → only 1 entry
- Cutting away to B-Roll and coming back to the SAME look is NOT a change
- A change means: the viewer can clearly tell "this was filmed in a different setting or at a different time"
- Scenes without the talking head (screen recordings, stock footage, graphics, cutaways) are NOT A-Roll
- If the video has NO talking head (e.g. voice-over only), set "has_talking_head" to false and leave "a_roll_appearances" empty

## Timestamp format:
Use ONLY timecodes in [HH:MM:SS] format for ALL timestamps. Do NOT include separate seconds fields.
Note: this is the original raw video — \`change_at\` timecodes are observational and may fall inside time ranges that were removed in the rough cut. That's fine; A-Roll appearances are descriptive context.

Return JSON:
\`\`\`json
{
  "has_talking_head": true,
  "a_roll_appearances": [
    {
      "id": 1,
      "description": "Main setup — presenter in a bright home office with a plant and bookshelf behind",
      "colors": "brown, sand, black",
      "lighting": "Soft key light, clean image, neutral-warm tones",
      "framing": "Static tripod, medium shot",
      "wardrobe": "Dark t-shirt",
      "change_note": "Initial appearance"
    },
    {
      "id": 2,
      "description": "Presenter now in a dark studio with neon accent lighting",
      "colors": "black, purple, blue",
      "lighting": "Low-key dramatic, colored rim lights",
      "framing": "Medium close-up, slight dutch angle",
      "wardrobe": "White button-up shirt",
      "change_at": "[00:09:41]",
      "change_note": "Location + wardrobe + lighting all changed"
    }
  ]
}
\`\`\``

const aRollStage = {
  name: 'Analyze A-Roll Appearances',
  type: 'video_question',
  target: 'main_video',
  model: 'gemini-3-flash-preview',
  system_instruction: aRollSystem,
  prompt: aRollPrompt,
  params: { temperature: 1, thinking_level: 'LOW' },
}

// ── Chapters & Beats stage ────────────────────────────────────────────
const chaptersSystem = `You are a video narrative analyst. Analyze the transcript and identify the chapter structure and beats.

You have reference video chapter analyses to understand how similar videos are structured:
{{all_chapter_analyses}}

Output ONLY valid JSON. No commentary.`

const chaptersPrompt = `Analyze this transcript and identify all chapters and beats.

A-Roll context from the same video:
{{llm_answer_1}}

## Transcript (cut text already removed; timecodes are original video time)
The transcript shows only the kept content of the rough cut. \`[Ns]\` gap markers
between sentences indicate seconds that were removed in editing — usually filler
removal, false starts, or dead air. They are NOT topic boundaries. A chapter
can span multiple \`[Ns]\` gaps when the topic continues. Use the transcript's
timecodes verbatim — do not invent new ones.

{{transcript}}

## Definitions:
- Chapter: A bigger section made of multiple beats — a "phase" of the video (setup, conflict, resolution, conclusion).
- Beat: A single moment where something changes (a decision, a setback, a discovery, a reaction).
- Chapters should cover the entire transcript without gaps (other than the rough-cut deletion gaps described above)

## Output rules:
- "description": 2-3 sentences explaining what happens in this chapter/beat — be specific about the content, arguments, or story points covered
- "purpose": 1-2 sentences explaining WHY this chapter/beat exists in the video — what editorial or narrative function does it serve for the viewer

Use ONLY [HH:MM:SS] timecodes.

Return JSON:
\`\`\`json
{
  "chapters": [
    {
      "id": 1,
      "start": "[00:00:00]",
      "end": "[00:01:29]",
      "name": "The Perpetual Underclass",
      "description": "Introduces the threat of AI replacing millions of white-collar jobs within three years. The speaker draws parallels to previous industrial revolutions and argues this time is fundamentally different because AI targets cognitive work.",
      "purpose": "Hook the audience with a stark, personal warning. Establishes the stakes so viewers feel the urgency before any solutions are offered.",
      "beats": [
        {
          "start": "[00:00:00]",
          "end": "[00:00:22]",
          "name": "The 36-Month Warning",
          "description": "Speaker opens with a direct claim that viewers have roughly 36 months before AI makes their current skills obsolete. Cites recent layoffs at major tech companies as early evidence.",
          "purpose": "Create immediate urgency and personal stakes. Forces the viewer to stop scrolling and pay attention."
        }
      ]
    }
  ]
}
\`\`\``

const chaptersStage = {
  name: 'Analyze Chapters & Beats',
  type: 'transcript_question',
  target: 'main_video',
  model: 'gemini-3.1-pro-preview',
  system_instruction: chaptersSystem,
  prompt: chaptersPrompt,
  params: { temperature: 1, thinking_level: 'MEDIUM' },
}

// ── Split by chapter stage ────────────────────────────────────────────
const splitStage = {
  name: 'Split by chapter',
  type: 'programmatic',
  target: 'text_only',
  action: 'split_by_chapter',
  actionParams: { chaptersStageIndex: 2, aRollStageIndex: 1 },
  description: 'Prepare per-chapter data (transcript slices, beats, A-Roll context) for downstream stages',
}

const newStages = [transcriptStage, aRollStage, chaptersStage, splitStage]

console.log(`plan_prep new layout: ${newStages.length} stages`)
for (const [i, s] of newStages.entries()) {
  console.log(`  [${i}] ${s.name} (${s.action || s.type})`)
}

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ?, notes = ? WHERE id = ?')
  .run(
    JSON.stringify(newStages),
    'Dropped export_post_cut_video stage; A-Roll analyzes raw video, Chapters & Beats reads trimmed transcript with original timecodes + [Ns] gap markers.',
    ver.id,
  )

console.log('plan_prep version', ver.id, 'updated.')
process.exit(0)
