import db from '../db.js'

// ── SHARED DEFINITIONS (same as reference analysis) ──
const categoryDefinitions = `# Main Categories:
A-roll: Primary footage that carries the narrative (often a talking head/interview).
Callout Text: On-screen text added to emphasize, label, or summarize information (not a transcript). It can appear over A-roll, B-roll, or Graphic Package/PiP, and may persist across cuts. So it means it can go across the A-roll and to the B-roll and it will be only 1 Callout Text and not multiple. Callout text includes titles, key points, labels, stats, names, etc. Callout Text usually has a similar font size and has a clear meaning. Subtitles are not Callout Text OR overlays. Subtitles = on-screen text that only transcribes or translates the spoken audio (not extra info or labels).
Overlay images: Non-text visual elements layered on top of the base visual to illustrate, reinforce, or direct attention (e.g., icons, logos/bugs, arrows, stickers, product images, floating screenshots, simple shapes). Overlay images can appear on A-roll only!
Graphic package / PiP: A layout template that defines the base visual (background + frames + placement). It usually contains A-roll inside a box, plus branded design elements. Key rule: turning the package off does change the whole screen composition (because the layout itself is the scene).
Key distinction: overlay images sit on top; a package rearranges the whole scene.
B-roll: Supporting footage used to illustrate the narration or cover A-roll (so the viewer doesn't see the talking head). B-roll can have its own overlays.

# IGNORE SUBTITLES
Subtitles = on-screen text at the bottom of the screen that transcribes or translates the spoken audio. If text on screen matches what is being said — it is a subtitle. Do NOT report subtitles. Ignore them completely.`

const enumDefinitions = `# Enum Values (use ONLY these exact strings in JSON output):

## function (why this element exists):
"Inform - Illustrate" | "Inform - Clarify" | "Inform - Explain process" | "Proof - Validate claim" | "Proof - Showcase result" | "Product - Showcase product" | "Product - Showcase feature" | "Product - Demonstrate use" | "Story - Set mood" | "Story - Symbolize idea" | "Editing/Pacing - Mask cut" | "Editing/Pacing - Pattern-break" | "Editing/Pacing - Pause / breathe"

## type_group (what kind of visual content):
"Product / UI showcase" | "Product-in-use" | "UI flow / Screen recording" | "Document / Media proof" | "TV News" | "Cut from TV show" | "TikTok / YouTube video" | "Social Media Post" | "Meme" | "Film / TV Series clip" | "Statistical graphic" | "Text highlight" | "Hands-at-work" | "Process / Step-by-step action" | "Human interaction" | "Reaction / Expression" | "Famous Person Portrait" | "Environment / Establishing" | "Mood environment" | "Object / Detail insert" | "Brand element" | "Before / After contrast" | "Lifestyle / Scenario" | "Location-specific reference" | "Symbolic / Metaphorical" | "Motion / Travel shot" | "Time-passage" | "Archived / Historical" | "Graphic / Motion design"

## content_type (for chapters):
"talking_head" | "demo" | "story" | "explanation" | "interview" | "montage" | "intro" | "outro" | "transition"

## emotion:
"informative" | "exciting" | "tense" | "humorous" | "reflective" | "inspirational" | "dramatic" | "calm"`

const stages = [
  // ── Stage 1: Generate post-cut transcript (programmatic) ──
  {
    name: 'Generate post-cut transcript',
    type: 'programmatic',
    target: 'text_only',
    action: 'generate_post_cut_transcript',
    actionParams: {},
    description: 'Remove cut words and recalculate timecodes to match the post-rough-cut video',
  },

  // ── Stage 2: Export post-cut video (programmatic) ──
  {
    name: 'Export post-cut video',
    type: 'programmatic',
    target: 'text_only',
    action: 'export_post_cut_video',
    actionParams: {},
    description: 'FFmpeg trim+concat to produce the post-cut video file for visual analysis',
  },

  // ── Stage 3: Analyze A-Roll + Chapters & Beats of post-cut video ──
  {
    name: 'Analyze A-Roll + Chapters & Beats',
    type: 'video_llm',
    target: 'main_video',
    model: 'gemini-3-flash-preview',
    system_instruction: `${categoryDefinitions}

${enumDefinitions}

You are a video structure analyst. Watch the video and output ONLY valid JSON. No commentary.`,
    prompt: `Watch this post-cut video and identify:
1. Every A-Roll scene (when location, framing, or setup changes — each gets its own entry)
2. All chapters (major phases of the video)
3. All beats within each chapter (moments where something changes)

## Definitions:
- Chapter: A bigger section made of multiple beats — a "phase" of the video (setup, conflict, resolution, conclusion).
- Beat: A single moment where something changes (a decision, a setback, a discovery, a reaction).
- A-Roll: When the camera setup, location, or framing changes significantly, it is a new A-Roll.

## Post-cut transcript for context:
{{transcript}}

IMPORTANT: For ALL timestamps, include BOTH seconds (integer) AND timecodes in [HH:MM:SS] format.

Return JSON:
\`\`\`json
{
  "a_rolls": [
    {
      "id": 1,
      "start_seconds": 0,
      "end_seconds": 371,
      "start_tc": "[00:00:00]",
      "end_tc": "[00:06:11]",
      "description": "Talking head in a bright home office; neutral wall with a plant and bookshelf behind",
      "colors": "brown, sand, black",
      "lighting": "Soft key light, clean image, neutral-warm tones",
      "framing": "Static tripod, medium shot, natural hand gestures",
      "wardrobe": "Dark t-shirt"
    }
  ],
  "chapters": [
    {
      "id": 1,
      "start_seconds": 0,
      "end_seconds": 89,
      "start_tc": "[00:00:00]",
      "end_tc": "[00:01:29]",
      "name": "The Perpetual Underclass",
      "content_type": "talking_head",
      "description": "Introduces the threat of AI replacing jobs",
      "purpose": "Hook the audience with a stark warning",
      "beats": [
        {
          "start_seconds": 0,
          "end_seconds": 22,
          "start_tc": "[00:00:00]",
          "end_tc": "[00:00:22]",
          "name": "The 36-Month Warning",
          "description": "Speaker states viewers have a short window to adapt",
          "emotion": "dramatic",
          "purpose": "Create immediate urgency"
        }
      ]
    }
  ],
  "total_duration_seconds": 600
}
\`\`\``,
    params: { temperature: 1, thinking_level: 'MEDIUM' },
  },

  // ── Stage 4: Create B-Roll strategy using reference patterns ──
  {
    name: 'Create B-Roll strategy',
    type: 'transcript_question',
    target: 'text_only',
    model: 'gemini-3.1-pro-preview',
    system_instruction: `${categoryDefinitions}

${enumDefinitions}

You are a senior video editor creating a B-Roll strategy for a new video. You have:
1. Analysis of a reference video (patterns, rules, frequencies, style)
2. The new video's structure (A-Roll, chapters, beats)
3. The new video's transcript

Your job: create a chapter-by-chapter B-Roll strategy that follows the reference patterns but adapts to this video's unique content.

Output ONLY valid JSON.`,
    prompt: `Create a B-Roll / Graphic Package / Image Overlay strategy for this new video.

## Reference video analysis (patterns and rules to follow):
{{reference_analysis}}

## New video A-Roll + Chapters & Beats:
{{llm_answer_3}}

## New video transcript:
{{transcript}}

For each chapter, define:
1. Target frequency for B-Roll, Graphic Package/PiP, and Overlay Images
2. Suggested types, sources, and functions
3. Style guidelines (must be consistent with reference patterns)
4. Rules for when/where to place elements

Return JSON:
\`\`\`json
{
  "overall_style": "Description of the visual style to maintain across the video",
  "overall_rules": ["Rule 1", "Rule 2"],
  "chapters": [
    {
      "chapter_name": "...",
      "chapter_number": 1,
      "start_tc": "[00:00:00]",
      "end_tc": "[00:01:29]",
      "broll": {
        "target_per_minute": 3.5,
        "suggested_types": ["UI flow / Screen recording", "Document / Media proof"],
        "suggested_sources": ["Screen-recording", "Stock footage & cinematic"],
        "suggested_functions": ["Inform - Illustrate", "Proof - Validate claim"],
        "style_notes": "Dark tones, cool temperature, slow motion",
        "rules": ["Place within 2s of verbal reference", "Max 6s per clip"]
      },
      "graphic_package": {
        "target_per_minute": 1.0,
        "suggested_purposes": ["List/step presentation"],
        "style_notes": "Speaker in 35% left box, content right",
        "rules": ["Use for lists, comparisons, multi-point arguments"]
      },
      "overlay_image": {
        "target_per_minute": 0.5,
        "suggested_purposes": ["Illustrate referenced person/thing"],
        "style_notes": "Transparent cutouts, slightly animated",
        "rules": ["Only on A-Roll", "Triggered by name mentions"]
      }
    }
  ]
}
\`\`\``,
    params: { temperature: 1, thinking_level: 'HIGH' },
  },

  // ── Stage 5: Split by chapter (programmatic) ──
  {
    name: 'Split by chapter',
    type: 'programmatic',
    target: 'text_only',
    action: 'split_by_chapter',
    actionParams: { chaptersStageIndex: 2 },
    description: 'Prepare per-chapter data (transcript slices, beats, context) for per-chapter plan generation',
  },

  // ── Stage 6: Per-chapter detailed B-Roll plan ──
  {
    name: 'Per-chapter B-Roll plan',
    type: 'transcript_question',
    target: 'text_only',
    model: 'gemini-3.1-pro-preview',
    per_chapter: true,
    system_instruction: `${categoryDefinitions}

${enumDefinitions}

You are a senior video editor creating exact B-Roll placements for ONE chapter. You have:
1. Reference video patterns (what worked before)
2. The B-Roll strategy (target frequencies, rules)
3. The chapter's transcript with exact timecodes

Create EXACT placements with precise [HH:MM:SS] timecodes that match the transcript. Each placement must have an audio anchor (the words being spoken), a trigger, and a detailed description.

Audience: {{audience}}
When a placement shows people, briefly contextualize them to fit the audience — one or two adjectives, never a paragraph (e.g. "older white American couple" instead of just "a couple"). Skip the audience hint when the placement does not show people.

Output ONLY valid JSON.`,
    prompt: `Create detailed B-Roll / Graphic Package / Overlay placements for chapter {{chapter_number}} of {{total_chapters}}.

## ── CHAPTER ──
### "{{chapter_name}}" ({{chapter_start_tc}} - {{chapter_end_tc}}, {{chapter_duration_seconds}}s)
**Purpose:** {{chapter_purpose}}
**Beats:**
{{chapter_beats}}

## ── CHAPTER TRANSCRIPT (use these timecodes for placements) ──
{{chapter_transcript}}

## ── B-ROLL STRATEGY (follow these targets and rules) ──
{{llm_answer_4}}

## ── REFERENCE VIDEO PATTERNS ──
{{reference_analysis}}

## ── FULL VIDEO CONTEXT ──
{{all_chapters}}

Create exact placements for this chapter. Each placement MUST:
- Have start/end timecodes matching the transcript timestamps
- Have an audio anchor (exact phrase being spoken)
- Follow the strategy's target frequency and rules
- Be unique and contextually appropriate (not generic)

Return JSON:
\`\`\`json
{
  "chapter_name": "{{chapter_name}}",
  "chapter_number": {{chapter_number}},
  "placements": [
    {
      "start_seconds": 1,
      "end_seconds": 3,
      "start_tc": "[00:00:01]",
      "end_tc": "[00:00:03]",
      "category": "broll",
      "audio_anchor": "stopped me cold",
      "function": "Proof - Validate claim",
      "trigger": "When she mentions reading something shocking",
      "type_group": "Document / Media proof",
      "description": "Close-up of a newspaper featuring the headline with yellow-highlighted text for emphasis",
      "search_keywords": ["newspaper headline", "shocking document", "highlighted text"],
      "style": {
        "colors": "black, white, yellow highlight",
        "temperature": "cool",
        "motion": "slow pan"
      },
      "priority": "high"
    },
    {
      "start_seconds": 17,
      "end_seconds": 19,
      "start_tc": "[00:00:17]",
      "end_tc": "[00:00:19]",
      "category": "graphic_package",
      "audio_anchor": "the entire economy so violently",
      "function": "Story - Set mood",
      "trigger": "When mentioning the entire economy",
      "layout": {
        "description": "Speaker in front of massive curved data wall",
        "background": "Glowing red and green stock tickers, bar graphs",
        "elements": ["Speaker in virtual set", "Financial data wall", "Fluctuating numbers"],
        "style": "Dark with red/green data glow"
      },
      "priority": "medium"
    },
    {
      "start_seconds": 11,
      "end_seconds": 13,
      "start_tc": "[00:00:11]",
      "end_tc": "[00:00:13]",
      "category": "overlay_image",
      "audio_anchor": "in the next three years",
      "function": "Inform - Clarify",
      "trigger": "When speaker says three years",
      "description": "3D-rendered text element saying 36 MONTHS floating in the air",
      "position": "Center-right, anchored above speaker's hand",
      "priority": "high"
    }
  ]
}
\`\`\``,
    params: { temperature: 1, thinking_level: 'HIGH' },
  },

  // ── Stage 7: Assemble full B-Roll plan (programmatic) ──
  {
    name: 'Assemble full plan',
    type: 'programmatic',
    target: 'text_only',
    action: 'assemble_broll_plan',
    actionParams: {},
    description: 'Merge all per-chapter B-Roll plans into one complete document',
  },
]

// Find reference analysis strategy to link
const refStrategy = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'main_analysis' ORDER BY id LIMIT 1").get()
const refId = refStrategy?.id || null

// Upsert: find existing or create
let existing = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'plan' AND name = 'B-Roll Plan (Post Rough Cut)' LIMIT 1").get()
let stratId
if (existing) {
  stratId = existing.id
  await db.prepare("UPDATE broll_strategies SET description = $1, main_strategy_id = $2, analysis_model = $3 WHERE id = $4").run(
    '7-step: post-cut transcript, post-cut video export, A-Roll+Chapters, B-Roll strategy, split by chapter, per-chapter plan, assemble',
    refId, 'gemini-3.1-pro-preview', stratId
  )
  console.log('Plan strategy updated:', stratId)
} else {
  const strat = await db.prepare(`
    INSERT INTO broll_strategies (name, description, strategy_kind, main_strategy_id, analysis_model)
    VALUES ($1, $2, $3, $4, $5)
  `).run(
    'B-Roll Plan (Post Rough Cut)',
    '7-step: post-cut transcript, post-cut video export, A-Roll+Chapters, B-Roll strategy, split by chapter, per-chapter plan, assemble',
    'plan', refId, 'gemini-3.1-pro-preview'
  )
  stratId = strat.lastInsertRowid
  console.log('Plan strategy created:', stratId)
}
console.log(refId ? `Linked to reference analysis strategy ${refId}` : 'No reference strategy found')

// Upsert version
const existingVer = await db.prepare("SELECT id FROM broll_strategy_versions WHERE strategy_id = ? AND name = 'Version 1' LIMIT 1").get(stratId)
let ver
if (existingVer) {
  await db.prepare('UPDATE broll_strategy_versions SET stages_json = ?, notes = ? WHERE id = ?')
    .run(JSON.stringify(stages), '7-stage B-Roll planning pipeline for post-rough-cut videos', existingVer.id)
  ver = { lastInsertRowid: existingVer.id }
} else {
  ver = await db.prepare(`
    INSERT INTO broll_strategy_versions (strategy_id, name, notes, stages_json)
    VALUES ($1, $2, $3, $4)
  `).run(stratId, 'Version 1', '7-stage B-Roll planning pipeline for post-rough-cut videos', JSON.stringify(stages))
}

console.log('Version:', ver.lastInsertRowid)
console.log('7 stages:')
console.log('  1. Generate post-cut transcript (programmatic)')
console.log('  2. Export post-cut video (programmatic, FFmpeg)')
console.log('  3. Analyze A-Roll + Chapters & Beats (video_llm, Main Video)')
console.log('  4. Create B-Roll strategy (transcript_question, uses reference analysis)')
console.log('  5. Split by chapter (programmatic)')
console.log('  6. Per-chapter B-Roll plan (transcript_question, per_chapter)')
console.log('  7. Assemble full plan (programmatic)')
process.exit(0)
