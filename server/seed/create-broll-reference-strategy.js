import db from '../db.js'

const strat = await db.prepare(`
  INSERT INTO broll_strategies (name, description, strategy_kind, analysis_model, analysis_system_prompt, plan_model, plan_system_prompt)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
`).run(
  'Reference Video B-Roll Analysis',
  '6-step analysis of example/reference videos: A-Roll + Chapters, segment into minutes, per-minute B-Roll/PiP/Overlay analysis, pattern summary, frequency analysis',
  'hook_analysis',
  'gemini-3.1-pro-preview', '', 'gemini-3.1-pro-preview', ''
)
const stratId = strat.lastInsertRowid
console.log('Strategy created:', stratId)

// ── SYSTEM INSTRUCTIONS (shared analysis schema) ──
const analysisSchema = `# Main Categories:
A-roll: Primary footage that carries the narrative (often a talking head/interview).
Callout Text: On-screen text added to emphasize, label, or summarize information (not a transcript). It can appear over A-roll, B-roll, or Graphic Package/PiP, and may persist across cuts. So it means it can go across the A-roll and to the B-roll and it will be only 1 Callout Text and not multiple. Callout text includes titles, key points, labels, stats, names, etc. Callout Text usually has a similar font size and has a clear meaning. Subtitles are not Callout Text OR overlays. Subtitles = on-screen text that only transcribes or translates the spoken audio (not extra info or labels). Subtitles do not need to be grouped with Callout Text.
Overlay images: Non-text visual elements layered on top of the base visual to illustrate, reinforce, or direct attention (e.g., icons, logos/bugs, arrows, stickers, product images, floating screenshots, simple shapes). Overlay images can appear in of A-roll only!
Graphic package / PiP: A layout template that defines the base visual (background + frames + placement). It usually contains A-roll inside a box, plus branded design elements. Key rule: turning the package off does change the whole screen composition (because the layout itself is the scene).
Key distinction of Overlay image vs Graphic Package: overlay images sit on top; a package rearranges the whole scene.
B-roll: Supporting footage used to illustrate the narration or cover A-roll (so the viewer doesn't see the talking head). B-roll can have its own overlays.

# Analysis SCHEMA
Function List (why this element exists):
Inform - Illustrate | Inform - Clarify | Inform - Explain process | Proof - Validate claim | Proof - Showcase result | Product - Showcase product | Product - Showcase feature | Product - Demonstrate use | Story - Set mood | Story - Symbolize idea | Editing/Pacing - Mask cut | Editing/Pacing - Pattern-break | Editing/Pacing - Pause / breathe

Type group (reusable bucket of what kind of visual content it is):
Product / UI showcase | Product-in-use | UI flow / Screen recording | Document / Media proof | TV News | Cut from TV show (not news) | TikTok / YouTube video | Social Media Post | Meme | Film / TV Series clip | Statistical graphic | Text highlight | Hands-at-work | Process / Step-by-step action | Human interaction | Reaction / Expression | Famous Person Portrait / Presence | Environment / Establishing | Mood environment | Object / Detail insert | Brand element | Before / After contrast | Lifestyle / Scenario | Location-specific reference | Symbolic / Metaphorical | Motion / Travel shot | Time-passage | Archived / Historical | Graphic / Motion design

Source feel options:
Stock footage & cinematic | Looks filmed during same set | UGC/Real-life but not filmed during same set | Screen-recording | Static Screenshot | Moving/Animated Screenshot | AI-generated footage | YouTube video | Stock Graphic Animation | Custom Graphic Animation | Static Graphic

# OUTPUT SCHEMA FOR EACH ELEMENT:

## B-roll
- Exact phrase (audio anchor): key words spoken at the start that this b-roll supports
- Function: (from Function List)
- Trigger: (1 short sentence — when)
- Type group: (from Type group list)
- Source feel: (from Source feel options)
- Description + context (1-2 sentences): What is happening on screen (subject + action), what the viewer should notice
- Style: Overall style description, COLORS, temperature, motion style

## Graphic Package / PiP
- Exact phrase (audio anchor)
- Function
- Trigger
- Exact elements + exact text + overall layout: What elements are on screen (A-roll box, panels, dividers, logo bug, shapes, icons, etc.), where they sit, colors, style, any meaningful on-screen text

## Overlay Images (A-roll only)
- Function
- Trigger
- Description + context (1-2 sentences): What it is + what it points to/reinforces
- Position: where it sits / what it is anchored to

# DO NOT ADD ANY OTHER COMMENTS!`

const stages = [
  // ── Stage 1: A-Roll + Chapters & Beats ──
  {
    name: 'Analyze A-Roll + Chapters & Beats',
    type: 'video_llm',
    target: 'examples',
    model: 'gemini-3.1-pro-preview',
    system_instruction: `${analysisSchema.split('# Analysis SCHEMA')[0].trim()}`,
    prompt: `Analyze this video and find all the Video Chapters, Key Beats, and Timecodes for each. Also, describe the scene in an A-Roll with the timecodes (start-end). If A-Roll location is changed - notice this separately with a different timecode.

## Definitions
Chapter: A chapter is a bigger section made of multiple beats — a "phase" of the video that covers one part of the journey (setup, attempts, setback phase, comeback phase, conclusion).
Beat: A beat is a single moment where something changes and the story moves forward (a decision, a setback, a discovery, a mini-win, the final result, a strong reaction).

## Output format:

### A-rolls:
[HH:MM:SS - HH:MM:SS] A-Roll #N — Description of the scene: location, colors, lighting, framing, wardrobe, camera movement, mood.

### Chapters & Beats:
#### Chapter N: Title **HH:MM:SS - HH:MM:SS**
* **Description:** What this chapter covers.
* **Purpose:** Why this chapter exists.
* **Beat N: Title (HH:MM:SS - HH:MM:SS)**
  * **Description:** What happens.
  * **Purpose:** Why this beat matters.`,
    params: { temperature: 0.2, thinking_level: 'MEDIUM' },
  },

  // ── Stage 2: Segment into 1-minute chunks ──
  {
    name: 'Segment into 1-minute chunks',
    type: 'programmatic',
    target: 'text_only',
    action: 'segment',
    actionParams: { minSeconds: 55, maxSeconds: 65, contextSeconds: 0 },
    description: 'Split transcript into ~1 minute segments for per-minute analysis',
  },

  // ── Stage 3: Per-minute B-Roll / PiP / Overlay analysis ──
  {
    name: 'Analyze B-Roll per minute',
    type: 'video_llm',
    target: 'examples',
    model: 'gemini-3-flash-preview',
    system_instruction: analysisSchema,
    prompt: `Analyze this video. Find all the timecodes (start-end) when the Graphic package / PiP, B-roll, or Overlay image appear in the video.

Use ONLY this time window for your analysis: from segment {{segment_number}} of {{total_segments}}.

For context, here is the A-Roll and Chapter structure:
{{llm_answer_1}}

Output each element with its full schema. Example format:

[00:14 - 00:24] B-Roll #1
Exact phrase (audio anchor): "...so I opened the dashboard and checked our conversion rate..."
Function: Proof - Validate claim
Trigger: a short moment before the dashboard was mentioned.
Type group: UI flow / Screen recording
Source feel: Looks filmed during a set
Description + context: Close-up of a laptop showing a dashboard as the cursor scrolls to a "Conversion Rate" KPI area. Attention is clearly on the highlighted metric block that matches the narration.
Style: Animated video, dark, gloomy colors, with green and black dominating, army-like. Using some glitter effects.

[00:35 - 00:37] Graphic Package / PiP #1
Exact phrase (audio anchor): "...there are very easy steps and step number 1 is..."
Function: Inform - Clarify
Trigger: When "Step number 1" was mentioned.
Exact elements + exact text + overall layout: The screen switches to a split layout with the speaker in a small bordered box on the left (about 35-40% width) and a steps panel on the right (about 60-65% width) over a dark green-yellow background with subtle geometric shapes and army-like style, showing the heading "Step 1" and bullets "Pick one metric," "Track weekly," and "Review notes."

[00:37 - 00:39] Overlay Images #1
Function: Inform - Illustrate
Trigger: When speaker says "Bieber"
Description + context: Justin Bieber animated cut out image (transparent), that looks funny as Justin looks like screaming.
Position: top-left, takes about 30% of a screen, behind the talking head (presenter).`,
    params: { temperature: 0.2, thinking_level: 'LOW' },
  },

  // ── Stage 4: Reassemble ──
  {
    name: 'Reassemble analysis',
    type: 'programmatic',
    target: 'text_only',
    action: 'reassemble',
    actionParams: {},
    description: 'Combine all per-minute analyses into one document',
  },

  // ── Stage 5: Summarize patterns ──
  {
    name: 'Summarize patterns',
    type: 'transcript_question',
    target: 'text_only',
    model: 'gemini-3.1-pro-preview',
    system_instruction: '',
    prompt: `Analyze the data of this reference video.

1. Find patterns in the data to find commonalities of b-rolls / pip graphics / image overlays.
2. Find when b-roll is usually used:
   2.1. What are the sources?
   2.2. What are the types? What is the purpose of each type?
   2.3. How often? And when specifically?
   2.4. What are the style rules compared to A-Roll or previous B-roll?
   2.5. What are the overall rules?
3. Find when the Graphic Package / PiP is usually used:
   3.1. What is the purpose? What is it used for?
   3.2. How often? And when?
   3.3. What is usually the format/composition? What is the style?
   3.4. What are the general rules?
4. Find when Image Overlay is usually used:
   4.1. What is the purpose? What is it used for?
   4.2. How often?
   4.3. Where does it fit? Where is it usually positioned?
   4.4. What is the style?
   4.5. What are the rules?
5. What are the overall rules?

## Chapters & Beats + A-Roll:
{{llm_answer_1}}

## Detailed B-Roll / Graphic Package/PiP / Image Overlay analysis (minute by minute):
{{transcript}}`,
    params: { temperature: 0.3, thinking_level: 'HIGH' },
  },

  // ── Stage 6: Frequency analysis ──
  {
    name: 'Analyze frequency',
    type: 'transcript_question',
    target: 'text_only',
    model: 'gemini-3.1-pro-preview',
    system_instruction: '',
    prompt: `Analyze the data of this reference video.

What is the frequency of showing b-roll / Image overlay / Graphic Package (PiP)? Is b-roll / image overlay and graphic package frequency similar or not? If not, then how is it different? When do you show a specific group?

How does frequency of b-rolls / image overlay / graphic packages separately change through the chapters and beats? If it changes, how specifically (measure) does it change? Calculate how many per minute in each chapter and beat. Why does it change? What are the rules?

## Chapters & Beats + A-Roll:
{{llm_answer_1}}

## Detailed B-Roll / Graphic Package/PiP / Image Overlay analysis (minute by minute):
{{stage_4_output}}

## Pattern Summary:
{{llm_answer_5}}`,
    params: { temperature: 0.3, thinking_level: 'HIGH' },
  },
]

const ver = await db.prepare(`
  INSERT INTO broll_strategy_versions (strategy_id, name, notes, stages_json)
  VALUES ($1, $2, $3, $4)
`).run(stratId, 'Version 1', '6-step reference analysis: A-Roll+Chapters, segment, per-minute analysis, reassemble, pattern summary, frequency analysis', JSON.stringify(stages))

console.log('Version created:', ver.lastInsertRowid)
console.log('Done — 6 stages:')
console.log('  1. Analyze A-Roll + Chapters & Beats (video_llm, examples)')
console.log('  2. Segment into 1-minute chunks (programmatic)')
console.log('  3. Analyze B-Roll per minute (video_llm, examples)')
console.log('  4. Reassemble analysis (programmatic)')
console.log('  5. Summarize patterns (transcript_question, text_only)')
console.log('  6. Analyze frequency (transcript_question, text_only)')
process.exit(0)
