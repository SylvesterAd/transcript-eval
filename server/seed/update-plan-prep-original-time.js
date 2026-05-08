import db from '../db.js'

// Update plan_prep (strategy id=7) for the original-time domain.
//
// Changes:
//   1. Drop the "Export post-cut video" stage (export_post_cut_video) — Gemini
//      now consumes the raw original video. The prompt steers chapter/beat
//      anchoring to the trimmed transcript instead of the video timeline.
//   2. Merge "Analyze A-Roll Appearances" + "Analyze Chapters & Beats" into a
//      single combined "Analyze A-Roll + Chapters & Beats" stage. One Gemini
//      call sees the raw video AND the trimmed transcript and emits a JSON
//      blob with `a_roll_appearances` AND `chapters` keys.
//   3. Update split_by_chapter actionParams: chaptersStageIndex 3→1,
//      aRollStageIndex 2→1 (both point at the new merged stage at index 1).
//
// Re-run with:  node server/seed/update-plan-prep-original-time.js

const ver = await db.prepare(
  'SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = 7 ORDER BY created_at DESC LIMIT 1'
).get()
if (!ver) { console.error('No plan_prep (strategy_id=7) version found'); process.exit(1) }

const oldStages = JSON.parse(ver.stages_json)
console.log(`plan_prep current: ${oldStages.length} stages`)

// Sanity check expected layout
const expectedNames = [
  'Generate post-cut transcript',
  'Export post-cut video',
  'Analyze A-Roll Appearances',
  'Analyze Chapters & Beats',
  'Split by chapter',
]
const actualNames = oldStages.map(s => s.name)
const layoutOk = expectedNames.every((n, i) => actualNames[i] === n)
if (!layoutOk) {
  console.warn('WARNING: stage names do not match expected layout. Continuing — but verify.')
  console.warn('  expected:', expectedNames)
  console.warn('  actual:  ', actualNames)
}

const transcriptStage = oldStages[0]              // unchanged
const aRollStage      = oldStages[2]              // merge source
const chaptersStage   = oldStages[3]              // merge source
const splitStage      = oldStages[4]              // index will shift

// ── Combined system_instruction ───────────────────────────────────────
// Take A-Roll's category/enum definitions + chapters' narrative analyst framing.
const combinedSystem = `${aRollStage.system_instruction.trimEnd()}

# YOUR TASK
You are also a video narrative analyst. From the SAME video, derive chapters and beats — the narrative structure of the conversation.

You have reference video chapter analyses to understand how similar videos are structured:
{{all_chapter_analyses}}

For chapter/beat boundaries, anchor to the TRANSCRIPT below, not to what you see in the video. The transcript shows only the kept portions of the rough cut, with original video timecodes preserved. Where the transcript skips ahead (e.g. \`[115s]\` gap markers), that's a rough-cut deletion — treat it as a section boundary, never as continuous content.

Output ONLY valid JSON with both \`a_roll_appearances\` AND \`chapters\` keys. No commentary.`

// ── Combined prompt ───────────────────────────────────────────────────
const combinedPrompt = `Watch this video and analyze it on TWO axes:

## (1) A-Roll appearances — VISUAL only, derived from the video
- Identify the main talking head (presenter/host) — someone whose lip movement matches the spoken audio
- Describe their INITIAL appearance first (id: 1) — the default look
- Add MORE entries only when something VISUALLY CHANGES: different room, different outfit, different lighting, different camera setup
- If the talking head looks the same the entire video → only 1 entry
- Cutting away to B-Roll and coming back to the SAME look is NOT a change
- A change means: the viewer can clearly tell "this was filmed in a different setting or at a different time"
- Scenes without the talking head (screen recordings, stock footage, graphics, cutaways) are NOT A-Roll
- If the video has NO talking head (e.g. voice-over only), set "has_talking_head" to false and leave "a_roll_appearances" empty
- A-Roll \`change_at\` timecodes are observational from the video and may include time inside rough-cut deletions; that's fine.

## (2) Chapters & Beats — NARRATIVE structure, derived from the TRANSCRIPT
- The transcript below shows ONLY the kept content of the rough cut. Timecodes are original-video time.
- Chapters cover the entire transcript without gaps. Use the transcript's first kept timecode as your start, the transcript's last kept timecode as your end.
- A \`[Ns]\` gap marker in the transcript is a rough-cut deletion — a chapter or beat MUST end at or before that gap, and the next chapter/beat MUST start at or after the gap. Never span a gap with one chapter.
- Use the timecodes printed in the transcript verbatim — do NOT invent timecodes from what you saw in the video.

## Definitions
- Chapter: a bigger section made of multiple beats — a "phase" of the video (setup, conflict, resolution, conclusion).
- Beat: a single moment where something changes (a decision, a setback, a discovery, a reaction).

## Output rules for chapters/beats
- "description": 2-3 sentences explaining what happens in this chapter/beat — be specific about the content, arguments, or story points covered
- "purpose": 1-2 sentences explaining WHY this chapter/beat exists in the video — what editorial or narrative function does it serve for the viewer

## Timecodes
Use ONLY [HH:MM:SS] format. Do NOT include separate seconds fields.

## Transcript (cut text already removed; timecodes are original video time)
{{transcript}}

Return ONE JSON object containing BOTH a_roll_appearances and chapters:

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
  ],
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

const mergedStage = {
  name: 'Analyze A-Roll + Chapters & Beats',
  type: 'video_question',
  target: 'main_video',
  model: chaptersStage.model || 'gemini-3.1-pro-preview',  // pro for richer narrative analysis
  system_instruction: combinedSystem,
  prompt: combinedPrompt,
  params: { temperature: 1, thinking_level: 'MEDIUM' },
}

// New 3-stage layout
const newStages = [
  transcriptStage,                             // index 0 — Generate post-cut transcript
  mergedStage,                                 // index 1 — combined analysis (was 2 + 3)
  {                                            // index 2 — Split by chapter (was index 4)
    ...splitStage,
    actionParams: {
      ...(splitStage.actionParams || {}),
      chaptersStageIndex: 1,
      aRollStageIndex: 1,
    },
  },
]

console.log(`plan_prep new layout: ${newStages.length} stages`)
for (const [i, s] of newStages.entries()) {
  console.log(`  [${i}] ${s.name} (${s.action || s.type})`)
}

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ?, notes = ? WHERE id = ?')
  .run(
    JSON.stringify(newStages),
    'Merged A-Roll + Chapters/Beats into one stage; dropped post-cut video export. Gemini now consumes raw video + trimmed transcript with original timecodes.',
    ver.id,
  )

console.log('plan_prep version', ver.id, 'updated.')
process.exit(0)
