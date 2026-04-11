import db from '../db.js'

// ── SHARED DEFINITIONS ──
const categoryDefinitions = `# Main Categories:
A-roll: Primary footage that carries the narrative (often a talking head/interview).
Callout Text: On-screen text added to emphasize, label, or summarize information (not a transcript). It can appear over A-roll, B-roll, or Graphic Package/PiP, and may persist across cuts. So it means it can go across the A-roll and to the B-roll and it will be only 1 Callout Text and not multiple. Callout text includes titles, key points, labels, stats, names, etc. Callout Text usually has a similar font size and has a clear meaning. Subtitles are not Callout Text OR overlays. Subtitles = on-screen text that only transcribes or translates the spoken audio (not extra info or labels).
Overlay images: Non-text visual elements layered on top of the base visual to illustrate, reinforce, or direct attention (e.g., icons, logos/bugs, arrows, stickers, product images, floating screenshots, simple shapes). Overlay images can appear on A-roll only!
Graphic package / PiP: A layout template that defines the base visual (background + frames + placement). It usually contains A-roll inside a box, plus branded design elements. Key rule: turning the package off does change the whole screen composition (because the layout itself is the scene).
Key distinction: overlay images sit on top; a package rearranges the whole scene.
B-roll: Supporting footage used to illustrate the narration or cover A-roll (so the viewer doesn't see the talking head). B-roll can have its own overlays.

# IGNORE SUBTITLES
Subtitles = on-screen text at the bottom of the screen that transcribes or translates the spoken audio. If text on screen matches what is being said — it is a subtitle. Do NOT report subtitles as Callout Text, Overlay, or any category. Ignore them completely.`

const enumDefinitions = ``

const stages = [
  // ── Stage 1: A-Roll + Chapters & Beats (JSON) ──
  {
    name: 'Analyze A-Roll + Chapters & Beats',
    type: 'video_llm',
    target: 'examples',
    model: 'gemini-3-flash-preview',
    system_instruction: `${categoryDefinitions}

${enumDefinitions}

You are a video structure analyst. Watch the video and output ONLY valid JSON. No commentary.`,
    prompt: `Watch this video and identify:
1. Whether there is a main talking head (presenter/host) — someone whose lip movement matches the spoken audio
2. Every A-Roll scene — ONLY scenes where the main talking head is visible and speaking on camera
3. All chapters (major phases of the video)
4. All beats within each chapter (moments where something changes)

## How to identify A-Roll:
- A-Roll is ONLY the main talking head on camera with lip-sync matching the audio
- A new A-Roll entry is needed when the talking head's appearance changes: different background, wardrobe, lighting, framing, or location
- Scenes without the talking head (screen recordings, stock footage, graphics, cutaways) are B-Roll — do NOT list them as A-Roll
- If the video has NO talking head (e.g. voice-over only, screen recording tutorial), set "has_talking_head" to false and leave "a_rolls" empty

## Definitions:
- Chapter: A bigger section made of multiple beats — a "phase" of the video (setup, conflict, resolution, conclusion).
- Beat: A single moment where something changes (a decision, a setback, a discovery, a reaction).

IMPORTANT: For ALL timestamps, include BOTH seconds (integer) AND timecodes in [HH:MM:SS] format.

Return JSON:
\`\`\`json
{
  "has_talking_head": true,
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

  // ── Stage 2: Build time windows from chapters (programmatic) ──
  {
    name: 'Build analysis time windows',
    type: 'programmatic',
    target: 'text_only',
    action: 'build_time_windows',
    actionParams: { windowSeconds: 60, chaptersStageIndex: 0 },
    description: 'Split video into ~1 minute analysis windows based on chapter structure from stage 1',
  },

  // ── Stage 3: Per-window visual analysis (video) ──
  {
    name: 'Analyze B-Roll per minute',
    type: 'video_llm',
    target: 'examples',
    model: 'gemini-3-flash-preview',
    per_window: true,
    system_instruction: `${categoryDefinitions}

# Function List
Why this element exists (the job it's doing):
- Inform - Illustrate: Shows exactly what is being talked about. Example: mention "California" → show California on screen.
- Inform - Clarify: Makes an abstract point easier to understand. Example: mention "automation" → show workflow steps or dashboard actions.
- Inform - Explain process: Shows how something works step by step. Example: mention "how onboarding works" → show signup, setup, and first use.
- Proof - Validate claim: Adds evidence that a statement is true. Example: mention "used by thousands" → show real users talking about it, statistics, etc.
- Proof - Showcase result: Demonstrates an outcome or benefit. Example: mention "faster workflow" → show before/after process comparison.
- Product - Showcase product: Highlights the product itself. Example: mention "our app" → show product beauty shots or interface close-ups.
- Product - Showcase feature: Draws attention to a specific capability. Example: mention "smart reminders" → show the reminder being created and triggered.
- Product - Demonstrate use: Shows the product being used in real life. Example: mention "easy for parents" → show a parent booking a lesson on phone.
- Story - Set mood: Creates an emotional tone around the message. Example: mention "peace of mind" → show calm home environment or relieved parent.
- Story - Symbolize idea: Represents an idea visually instead of literally. Example: mention "growth" → show sunrise, progress bar, or student gaining confidence.
- Editing/Pacing - Mask cut: Hides jump cuts or stitched dialogue. Example: transition between two interview with related drone footage.
- Editing/Pacing - Pattern-break: Resets attention when visuals become repetitive. Example: after 20 seconds of talking head, cut to hands typing, sketching, or clicking through a workflow.
- Editing/Pacing - Pause / breathe: Gives the viewer a moment to absorb information. Example: after a dense explanation, show a calm atmospheric shot.

# Type Group
A reusable bucket describing what kind of visual content it is.
- Product / UI showcase: Clean shots of the product itself or its interface. Example: hero shot of a phone, laptop, app screen, dashboard, tool, or physical item.
- Product-in-use: Shows the product being actively used in a real situation. Example: someone using an app on their phone, wearing headphones, or opening packaging.
- UI flow / Screen recording: Shows a step-by-step sequence inside a digital product. Example: login flow, onboarding flow, checkout flow, or booking flow.
- Document / Media proof: Shows real-world source material on screen. Example: newspaper clipping, website article, testimonial, review, certificate, or email.
- TV News: Shows a television news clip, anchor shot, or broadcast-style segment. Example: news presenter on screen, lower-third headline, or breaking news footage.
- Cut from TV show (not news): Uses a recognizable clip from a fictional or entertainment TV program. Example: sitcom reaction shot, dramatic series moment, or reality-show clip used for humor, analogy, or emotion.
- TikTok / YouTube video: Shows social-media or creator-style video content. Example: vertical video, creator speaking to camera, vlog clip, tutorial clip, or reaction-style insert.
- Social Media Post: Shows a platform post as on-screen media. Example: tweet, Instagram post, LinkedIn post, Reddit post, or Facebook post used as proof, commentary, or cultural reference.
- Meme: Uses a meme or internet-native joke visual. Example: popular reaction meme, image macro, or short humorous insert for emphasis or contrast.
- Film / TV Series clip: Uses a recognizable clip from a movie or non-news TV show. Example: scene from a film, drama series, sitcom, or animated movie used for analogy, emotion, humor, or cultural reference.
- Statistical graphic: Visualizes numbers or data as graphics. Example: bar chart, line graph, percentage, counter, or KPI card.
- Text highlight: Displays key words, phrases, quotes, or headlines visually. Example: fullscreen quote, highlighted claim, title card, or keyword emphasis.
- Hands-at-work: Shows close-ups of someone physically doing something. Example: typing, writing, drawing, assembling, editing, or clicking.
- Process / Step-by-step action: Shows a sequence of actions to explain how something gets done. Example: preparing materials, setting up equipment, making a product, or completing a workflow.
- Human interaction: Shows two or more people engaging with each other. Example: conversation, handshake, teaching moment, customer support, or collaboration.
- Reaction / Expression: Shows a human emotional response or facial/body language. Example: smiling, concentrating, nodding, frustration, or relief.
- Famous Person Portrait / Presence: Shows a recognizable public figure mainly to establish identity or presence, without much action. Example: celebrity on stage, founder at podium, politician at event, or well-known person in archival footage.
- Environment / Establishing: Shows the wider place or setting. Example: office exterior, classroom, street, home workspace, or cityscape.
- Mood environment: Uses atmospheric visuals mainly for tone rather than information. Example: empty hallway, rainy window, sunlight in a room, or coffee steam.
- Object / Detail insert: Shows a close-up of a meaningful object or texture. Example: notebook, keyboard, coffee cup, branded packaging, or machinery part.
- Brand element: Reinforces the brand identity visually. Example: logo on product, company signage, brand colors, uniforms, or packaging.
- Before / After contrast: Shows difference between two states. Example: messy desk vs organized setup, or old workflow vs automated dashboard.
- Lifestyle / Scenario: Shows a broader real-life moment that gives context. Example: parent at home, student studying, commuter using app, or team in a meeting.
- Location-specific reference: Shows a named place or geographic reference directly. Example: California map, London street sign, school campus, or airport terminal.
- Symbolic / Metaphorical: Represents an idea visually rather than literally. Example: sunrise for growth, maze for confusion, or clock for pressure.
- Motion / Travel shot: Is defined mainly by camera or subject movement. Example: walking shot, tracking shot, drive-by, or drone flyover.
- Time-passage: Shows duration or change over time. Example: timelapse, clock movement, day-to-night shift, or people entering and leaving.
- Archived / Historical: Uses older footage or imagery as reference. Example: old photos, past campaign footage, historical news clips, or legacy screenshots.
- Graphic / Motion design: Uses designed or animated visuals instead of live footage. Example: animated icons, explainer graphics, arrows, callouts, or map animation.

# Analysis Schema — per-category field requirements:

## Style Block (use wherever "style" is required):
- description: Overall style description
- colors: COLORS are important — list dominant colors
- temperature: warm / cool / neutral
- motion: motion style (slow pan, static, fast cuts, etc.)

## B-Roll:
- audio_anchor: Exact phrase spoken at the start (or best matching phrase) that this b-roll supports
- function: Why this element exists (use Function List above)
- trigger: 1 short sentence explaining when/why it appears
- type_group: What kind of visual content (use Type Group list above)
- source_feel: One of:
  "Stock footage & cinematic" (polished, professional stock-style video with a film-like look)
  "Looks filmed during same set" (appears shot in the same location, lighting, and production setup)
  "UGC/Real-life but not filmed during same set" (authentic user-style footage, but clearly from different shoots/setups)
  "Screen-recording" (live capture of a device, app, or computer screen)
  "Static Screenshot" (single non-moving image captured from a screen)
  "Moving/Animated Screenshot" (screen capture with motion, scrolling, clicks, or minimal graphic animations)
  "AI-generated footage" (video created synthetically with AI tools)
  "YouTube video" (content sourced from a YouTube or platform video)
  "Stock Graphic Animation" (pre-made animated graphics or motion design assets, not matching the brand/colors of the video)
  "Custom Graphic Animation" (bespoke branded or original animated graphics)
  "Static Graphic" (non-animated designed visual such as an infographic or slide)
- description: REQUIRED 1-2 sentences. Must answer: What is happening on screen (subject + action)? What should the viewer notice (what's written/highlighted/emphasized)?
- style: REQUIRED. Use the full Style Block

## Graphic Package / PiP:
- audio_anchor: Exact phrase spoken when this appears
- function: Why this element exists (use Function List above)
- trigger: 1 short sentence explaining when/why
- layout: REQUIRED. Must include in one flowing description: what elements are on screen (A-roll box, panels, dividers, logo bug, shapes, icons), where they sit (left/right/center, approximate size), the colors of key elements (panel colors, border colors, text colors, icon colors), style of the graphic element, and any meaningful on-screen text (headlines, bullets, labels, numbers) written inline

## Callout Text:
- function: Why this element exists (use Function List above)
- trigger: When/why it appears
- description: What text appears, its visual style, and where on screen
- style: Font style, size impression, color if notable

## Overlay Image (A-roll only):
- function: Why this element exists (use Function List above)
- trigger: When/why it appears
- description: REQUIRED 1-2 sentences. What it is + what it points to/reinforces (what's highlighted). Include style details ONLY if it matters (otherwise keep it literal)
- position: REQUIRED. Freeform: where it sits / what it's anchored to (face, hands, object, corner, etc.)

# IGNORE SUBTITLES
Subtitles = on-screen text that transcribes or translates the spoken audio. If text matches what is being said — it is a subtitle. Ignore completely.

You are an expert video editor. Watch the video and analyze ONLY the time window specified. Identify every B-Roll, Graphic Package/PiP, Callout Text, and Overlay Image that appears.

Output ONLY valid JSON. No commentary.`,
    prompt: `Watch this video and analyze ONLY the window [{{window_start_tc}} - {{window_end_tc}}] (seconds {{window_start}} to {{window_end}}).

Context — this window falls in chapter "{{window_chapter}}" with beats: {{window_beats}}.

A-Roll and chapter structure for full context:
{{llm_answer_1}}

Find every B-Roll, Graphic Package/PiP, Callout Text, and Overlay Image that appears in this window. Report timestamps as seconds from the start of this window (0 = window start).

Return JSON:
\`\`\`json
{
  "window_id": {{window_id}},
  "window_start_seconds": {{window_start}},
  "window_end_seconds": {{window_end}},
  "elements": [
    {
      "category": "broll",
      "start_seconds": 14,
      "end_seconds": 24,
      "audio_anchor": "so I opened the dashboard and checked our conversion rate",
      "function": "Proof - Validate claim",
      "trigger": "A short moment before the dashboard was mentioned",
      "type_group": "UI flow / Screen recording",
      "source_feel": "Screen-recording",
      "description": "Close-up of a laptop showing a dashboard as the cursor scrolls to a Conversion Rate KPI area. Attention is on the highlighted metric block matching the narration.",
      "style": {
        "description": "Animated video, dark gloomy colors with green and black dominating, army-like aesthetic with glitter effects",
        "colors": "black, dark gray, green",
        "temperature": "cool",
        "motion": "slow scroll with cursor movement"
      }
    },
    {
      "category": "graphic_package",
      "start_seconds": 35,
      "end_seconds": 37,
      "audio_anchor": "there are very easy steps and step number 1 is",
      "function": "Inform - Clarify",
      "trigger": "When Step number 1 was mentioned",
      "layout": "Split layout with the speaker in a small bordered box on the left (about 35-40% width) and a steps panel on the right (about 60-65% width) over a dark green-yellow background with subtle geometric shapes and army-like style, showing the heading 'Step 1' and bullets 'Pick one metric', 'Track weekly', and 'Review notes'."
    },
    {
      "category": "callout_text",
      "start_seconds": 40,
      "end_seconds": 45,
      "function": "Inform - Illustrate",
      "trigger": "When the key stat is mentioned",
      "description": "Large bold text '73% increase' appears center-screen over the A-roll",
      "style": "White bold sans-serif text with subtle drop shadow"
    },
    {
      "category": "overlay_image",
      "start_seconds": 37,
      "end_seconds": 39,
      "function": "Inform - Illustrate",
      "trigger": "When speaker says Bieber",
      "description": "Justin Bieber animated cutout image (transparent), looks funny as he appears to be screaming",
      "position": "top-left, about 30% of screen, behind the talking head"
    }
  ]
}
\`\`\``,
    params: { temperature: 1, thinking_level: 'LOW' },
  },

  // ── Stage 4: Split analysis by chapter (programmatic) ──
  {
    name: 'Split analysis by chapter',
    type: 'programmatic',
    target: 'text_only',
    action: 'split_by_chapter',
    actionParams: { chaptersStageIndex: 0, elementsStageIndex: 2 },
    description: 'Group all B-Roll/PiP/Overlay elements by chapter with chapter context (purpose, beats)',
  },

  // ── Stage 5: Compute chapter stats (programmatic) ──
  {
    name: 'Compute chapter stats',
    type: 'programmatic',
    target: 'text_only',
    action: 'compute_chapter_stats',
    actionParams: {},
    description: 'Calculate frequency, duration, grouping stats per chapter — feeds into LLM pattern analysis',
  },

  // ── Stage 6: Pattern analysis PER CHAPTER (LLM interprets pre-computed stats) ──
  {
    name: 'Pattern analysis',
    type: 'transcript_question',
    target: 'text_only',
    model: 'gemini-3.1-pro-preview',
    per_chapter: true,
    system_instruction: `You are a video editing analyst. You receive pre-computed statistics and raw element data for ONE chapter. Your job is to INTERPRET the data — find patterns, explain why, and extract editing rules. Do NOT re-count or re-calculate anything; the stats are already computed for you. Output ONLY valid JSON.`,
    prompt: `Analyze editing patterns for chapter {{chapter_number}} of {{total_chapters}}.

## ── CHAPTER ──
### "{{chapter_name}}" ({{chapter_start_tc}} - {{chapter_end_tc}}, {{chapter_duration_seconds}}s)
**Purpose:** {{chapter_purpose}}
**Beats:**
{{chapter_beats}}

## ── PRE-COMPUTED STATS (do not re-count, use these numbers) ──
{{chapter_stats}}

## ── RAW ELEMENTS ──
{{chapter_elements}}

## ── CHAPTER TRANSCRIPT ──
{{chapter_transcript}}

## ── FULL VIDEO CONTEXT (all chapters + A-Roll) ──
{{all_chapters}}

Using the pre-computed stats and raw elements above, find patterns and extract rules. Do NOT restate individual elements — find what's common across them.

1. Find patterns in the data to find commonalities of b-rolls / graphic packages / image overlays.

2. Find when b-roll is usually used?
   2.1. What are the sources? What source_feel types dominate and why this mix?
   2.2. What are the main type_groups used?
   2.3. What is the purpose of each type_group?
   2.4. What are the style rules compared to A-Roll or previous B-roll?
   2.5. What are the overall b-roll rules?

3. Find when the Graphic Package / PiP is usually used?
   3.1. What's the purpose? What is it used for?
   3.2. What's usually the format/composition?
   3.3. What is the style?
   3.4. What are the general rules?

4. Find when Image Overlay is usually used?
   4.1. What's the purpose? What is it used for?
   4.2. Where does it fit? Where is it usually positioned?
   4.3. What's the style?
   4.4. What are the rules?

5. What are the overall rules for this chapter?

Note: frequency/timing stats are already pre-computed — do NOT recount. Focus on WHY and RULES.

Return JSON:
\`\`\`json
{
  "commonalities": "Patterns found across all element types",
  "broll": {
    "sources": "What source_feel types dominate and why this mix",
    "main_types": ["List of main type_groups used"],
    "type_purposes": {"type_group_name": "Purpose of this type in this chapter"},
    "style_vs_aroll": "Style rules compared to A-Roll or previous B-roll",
    "rules": ["Overall b-roll rules for this chapter"]
  },
  "graphic_package": {
    "purpose": "What is it used for in this chapter",
    "format": "Usual format/composition",
    "style": "Style patterns",
    "rules": ["General rules for graphic packages"]
  },
  "overlay_image": {
    "purpose": "What is it used for",
    "positioning": "Where does it fit — usual positions",
    "style": "What's the style",
    "rules": ["Rules for overlays"]
  },
  "overall_rules": ["Overall editing rules for this chapter"]
}
\`\`\``,
    params: { temperature: 1, thinking_level: 'HIGH' },
  },

  // ── Stage 7: Assemble full analysis document (programmatic) ──
  {
    name: 'Assemble full analysis',
    type: 'programmatic',
    target: 'text_only',
    action: 'assemble_full_analysis',
    actionParams: {},
    description: 'Merge all chapters into one document: context + stats + elements + transcript + LLM pattern analysis',
  },
]

// Update existing strategy
const existing = await db.prepare("SELECT id FROM broll_strategies WHERE id = 2").get()
if (!existing) {
  console.error('Strategy id=2 not found. Run create-broll-reference-strategy.js first.')
  process.exit(1)
}

// Update strategy metadata
await db.prepare(`
  UPDATE broll_strategies SET
    name = $1, description = $2, analysis_model = $3
  WHERE id = 2
`).run(
  'Main Video B-Roll Deep Analysis v2',
  '7-step: A-Roll+Chapters, time windows, per-window video analysis, split by chapter, compute stats, pattern analysis per chapter, assemble full doc',
  'gemini-3-flash-preview'
)

// Upsert version 2: update if exists, create if not
const existingVer = await db.prepare("SELECT id FROM broll_strategy_versions WHERE strategy_id = 2 AND name = 'Version 2' ORDER BY created_at DESC LIMIT 1").get()
let ver
if (existingVer) {
  await db.prepare('UPDATE broll_strategy_versions SET stages_json = ?, notes = ? WHERE id = ?')
    .run(JSON.stringify(stages), '7-step reference analysis with per-window video, per-chapter stats + pattern analysis', existingVer.id)
  ver = { lastInsertRowid: existingVer.id }
} else {
  ver = await db.prepare(`
    INSERT INTO broll_strategy_versions (strategy_id, name, notes, stages_json)
    VALUES ($1, $2, $3, $4)
  `).run(2, 'Version 2', '7-step reference analysis with per-window video, per-chapter stats + pattern analysis', JSON.stringify(stages))
}

console.log('Version created:', ver.lastInsertRowid)
console.log('7 stages:')
console.log('  1. Analyze A-Roll + Chapters & Beats (video_llm, Reference Video)')
console.log('  2. Build time windows (programmatic)')
console.log('  3. Analyze B-Roll per window (video_llm, Reference Video, per_window)')
console.log('  4. Split analysis by chapter (programmatic)')
console.log('  5. Compute chapter stats (programmatic)')
console.log('  6. Pattern analysis per chapter (LLM)')
console.log('  7. Assemble full analysis document (programmatic)')
process.exit(0)
