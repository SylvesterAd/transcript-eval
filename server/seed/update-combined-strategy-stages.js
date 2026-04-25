import db from '../db.js'

const strat = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'create_combined_strategy' ORDER BY id LIMIT 1").get()
if (!strat) { console.error('No create_combined_strategy found'); process.exit(1) }

const ver = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strat.id)
const stages = JSON.parse(ver.stages_json)

// === Update Stage 0: Match beats to references ===
const stage0 = stages[0]

stage0.name = 'Match beats to references'

stage0.system_instruction = `You are a senior video editor selecting the best B-Roll approaches from multiple reference videos. Your goal is to find the best visual match for each beat by comparing across ALL available references.

# Understanding the categories in reference analyses:
A-roll: Primary footage (talking head/interview).
B-roll: Supporting footage to illustrate narration or cover A-roll.
Graphic package / PiP: Layout template with A-roll in a box plus branded design elements.
Overlay images: Non-text visual elements layered on top of A-roll (icons, logos, arrows, product images).

Output ONLY valid JSON. No commentary.`

stage0.prompt = `You are matching beats from a NEW video chapter to the best reference beats across multiple reference videos.

## YOUR NEW VIDEO — CHAPTER {{chapter_number}}/{{total_chapters}}
**Chapter:** "{{chapter_name}}" ({{chapter_start_tc}} - {{chapter_end_tc}}, {{chapter_duration_seconds}}s)
**Purpose:** {{chapter_purpose}}
**Emotion:** {{chapter_emotion}}

**Beats:**
{{chapter_beats}}

**Chapter transcript:**
{{chapter_transcript}}

## ALL REFERENCE VIDEO ANALYSES
Each reference contains chapters with beats. Each beat has a purpose, emotion, and strategy_points describing its visual approach.

{{all_reference_analyses_slim}}

## INSTRUCTIONS

Go through YOUR beats one by one. For each beat:

1. Read the beat's name, purpose, and what's happening in the transcript at that point
2. Scan ALL reference beats across ALL references and ALL their chapters
3. Pick the ONE reference beat whose **purpose and emotion** best fits your beat
4. A beat from a different chapter type in a reference can be the best match — match at beat level, not chapter level
5. Invent an emotion for your new video beat based on what's happening in the transcript
6. Explain briefly why this reference beat is the best match

Return JSON:
\`\`\`json
{
  "chapter_name": "{{chapter_name}}",
  "beat_matches": [
    {
      "new_video_beat": "The Opening Hook",
      "new_video_beat_emotion": "Shock and urgency",
      "matched_reference": "Crunchy Brain Syndrome",
      "matched_reference_chapter": "The Mystery of Mark",
      "matched_reference_beat": "The Amazing Memory Man",
      "match_reason": "Both beats hook through extraordinary personal stories that sound too good to be true"
    }
  ]
}
\`\`\`

Rules:
- One match per beat — every beat in your chapter must have exactly one match
- \`matched_reference\` must be the reference video name (from the header), not an ID
- \`matched_reference_chapter\` and \`matched_reference_beat\` must be exact names from the reference analysis
- \`new_video_beat_emotion\` — invent this based on what's happening in the transcript at this beat
- Keep \`match_reason\` concise — one sentence`

// === Insert Stage 1: Programmatic "Enrich beat matches" ===
// Shift current Stage 1 → Stage 2, current Stage 2 → removed (enrich_beat_frequency no longer needed)
const newStage1 = {
  name: 'Enrich beat matches',
  type: 'programmatic',
  target: 'text_only',
  action: 'enrich_beat_matches',
  actionParams: {},
  description: 'Look up matched reference beat data (purpose, emotion, strategy_points, frequency) and new video beat purpose programmatically'
}

// Remove old Stage 2 (enrich_beat_frequency — now handled by this new stage)
// Keep old Stage 1 (Create combined strategy) as Stage 2, but rewrite its prompts
const oldStage1 = stages[1] // Create combined B-Roll strategy → becomes Stage 2
stages.length = 1 // Keep only Stage 0
stages.push(newStage1) // New Stage 1: enrich
stages.push(oldStage1) // Stage 2: create strategy

// === Update Stage 2: Create strategy from enriched data ===
const stage2 = stages[2]
stage2.name = 'Create strategy from reference'
stage2.type = 'transcript_question'
stage2.per_chapter = true
delete stage2.action
delete stage2.actionParams
delete stage2.description

stage2.system_instruction = `# Main Categories:
A-roll: Primary footage that carries the narrative (often a talking head/interview).
Overlay images: Non-text visual elements layered on top of the base visual to illustrate, reinforce, or direct attention (e.g., icons, logos/bugs, arrows, stickers, product images, floating screenshots, simple shapes). Overlay images can appear on A-roll only!
Graphic package / PiP: A layout template that defines the base visual (background + frames + placement). It usually contains A-roll inside a box, plus branded design elements. Key rule: turning the package off does change the whole screen composition (because the layout itself is the scene).
Key distinction of Overlay image vs Graphic Package: overlay images sit on top; a package rearranges the whole scene.
B-roll: Supporting footage used to illustrate the narration or cover A-roll (so the viewer doesn't see the talking head). B-roll can have its own overlays.

# IGNORE SUBTITLES
Subtitles = on-screen text at the bottom of the screen that transcribes or translates the spoken audio. If text on screen matches what is being said — it is a subtitle. Do NOT report subtitles as Overlay or any category. Ignore them completely.

# Analysis Schema
Shared definitions (use consistently)

## Function List
#Why this element exists (the job it's doing):
Inform - Illustrate (Shows exactly what is being talked about. Example: mention "California" → show California on screen.)
Inform - Clarify (Makes an abstract point easier to understand. Example: mention "automation" → show workflow steps or dashboard actions.)
Inform - Explain process (Shows how something works step by step. Example: mention "how onboarding works" → show signup, setup, and first use.)
Proof - Validate claim (Adds evidence that a statement is true. Example: mention "used by thousands" → show real users talking about it, statistics, etc.)
Proof - Showcase result (Demonstrates an outcome or benefit. Example: mention "faster workflow" → show before/after process comparison.)
Product - Showcase product (Highlights the product itself. Example: mention "our app" → show product beauty shots or interface close-ups.)
Product - Showcase feature (Draws attention to a specific capability. Example: mention "smart reminders" → show the reminder being created and triggered.)
Product - Demonstrate use (Shows the product being used in real life. Example: mention "easy for parents" → show a parent booking a lesson on phone.)
Story - Set mood (Creates an emotional tone around the message. Example: mention "peace of mind" → show calm home environment or relieved parent.)
Story - Symbolize idea (Represents an idea visually instead of literally. Example: mention "growth" → show sunrise, progress bar, or student gaining confidence.)
Editing/Pacing - Mask cut (Hides jump cuts or stitched dialogue. Example: transition between two interviews with related drone footage.)
Editing/Pacing - Pattern-break (Resets attention when visuals become repetitive. Example: after 20 seconds of talking head, cut to hands typing, sketching, or clicking through a workflow.)
Editing/Pacing - Pause / breathe (Gives the viewer a moment to absorb information. Example: after a dense explanation, show a calm atmospheric shot.)

## Type Group
A reusable bucket describing what kind of visual content it is.
Product / UI showcase (Clean shots of the product itself or its interface. Example: hero shot of a phone, laptop, app screen, dashboard, tool, or physical item.)
Product-in-use (Shows the product being actively used in a real situation. Example: someone using an app on their phone, wearing headphones, or opening packaging.)
UI flow / Screen recording (Shows a step-by-step sequence inside a digital product. Example: login flow, onboarding flow, checkout flow, or booking flow.)
Document / Media proof (Shows real-world source material on screen. Example: newspaper clipping, website article, testimonial, review, certificate, or email.)
TV News (Shows a television news clip, anchor shot, or broadcast-style segment. Example: news presenter on screen, lower-third headline, or breaking news footage.)
Cut from TV show (not news) (Uses a recognizable clip from a fictional or entertainment TV program. Example: sitcom reaction shot, dramatic series moment, or reality-show clip used for humor, analogy, or emotion.)
TikTok / YouTube video (Shows social-media or creator-style video content. Example: vertical video, creator speaking to camera, vlog clip, tutorial clip, or reaction-style insert.)
Social Media Post (Shows a platform post as on-screen media. Example: tweet, Instagram post, LinkedIn post, Reddit post, or Facebook post used as proof, commentary, or cultural reference.)
Meme (Uses a meme or internet-native joke visual. Example: popular reaction meme, image macro, or short humorous insert for emphasis or contrast.)
Film / TV Series clip (Uses a recognizable clip from a movie or non-news TV show. Example: scene from a film, drama series, sitcom, or animated movie used for analogy, emotion, humor, or cultural reference.)
Statistical graphic (Visualizes numbers or data as graphics. Example: bar chart, line graph, percentage, counter, or KPI card.)
Hands-at-work (Shows close-ups of someone physically doing something. Example: typing, writing, drawing, assembling, editing, or clicking.)
Process / Step-by-step action (Shows a sequence of actions to explain how something gets done. Example: preparing materials, setting up equipment, making a product, or completing a workflow.)
Human interaction (Shows two or more people engaging with each other. Example: conversation, handshake, teaching moment, customer support, or collaboration.)
Reaction / Expression (Shows a human emotional response or facial/body language. Example: smiling, concentrating, nodding, frustration, or relief.)
Famous Person Portrait / Presence (Shows a recognizable public figure mainly to establish identity or presence, without much action. Example: celebrity on stage, founder at podium, politician at event, or well-known person in archival footage.)
Environment / Establishing (Shows the wider place or setting. Example: office exterior, classroom, street, home workspace, or cityscape.)
Mood environment (Uses atmospheric visuals mainly for tone rather than information. Example: empty hallway, rainy window, sunlight in a room, or coffee steam.)
Object / Detail insert (Shows a close-up of a meaningful object or texture. Example: notebook, keyboard, coffee cup, branded packaging, or machinery part.)
Brand element (Reinforces the brand identity visually. Example: logo on product, company signage, brand colors, uniforms, or packaging.)
Before / After contrast (Shows difference between two states. Example: messy desk vs organized setup, or old workflow vs automated dashboard.)
Lifestyle / Scenario (Shows a broader real-life moment that gives context. Example: parent at home, student studying, commuter using app, or team in a meeting.)
Location-specific reference (Shows a named place or geographic reference directly. Example: California map, London street sign, school campus, or airport terminal.)
Symbolic / Metaphorical (Represents an idea visually rather than literally. Example: sunrise for growth, maze for confusion, or clock for pressure.)
Motion / Travel shot (Is defined mainly by camera or subject movement. Example: walking shot, tracking shot, drive-by, or drone flyover.)
Time-passage (Shows duration or change over time. Example: timelapse, clock movement, day-to-night shift, or people entering and leaving.)
Archived / Historical (Uses older footage or imagery as reference. Example: old photos, past campaign footage, historical news clips, or legacy screenshots.)
Graphic / Motion design (Uses designed or animated visuals instead of live footage. Example: animated icons, explainer graphics, arrows, callouts, or map animation.)

# Your Role:
You are a senior video editor creating a B-Roll strategy for ONE chapter of a new video. You receive enriched beat matches — each of your beats is paired with a reference beat including its purpose, emotion, strategy_points, and frequency. Your job is to create NEW strategy_points adapted to your video's content, using the reference as your visual blueprint.

## HARD RULES:
- NO TEXT OVERLAYS: Do NOT suggest text overlays, text highlights, callout text, or any on-screen text elements. Only suggest B-Roll footage, Graphic Packages, and Overlay Images (non-text visual elements like icons, logos, product images).
- USE REFERENCE FREQUENCY: Each beat's reference_frequency tells you the target broll_per_minute and avg_duration. Pass these through to your output.
- ADAPT, DON'T COPY: The reference strategy_points are your visual blueprint. Keep the same color logic, motion approach, and editorial functions — but rewrite them entirely for THIS beat's specific content and script.

Output ONLY valid JSON.`

stage2.prompt = `Create a B-Roll strategy for ONE chapter by adapting matched reference beat strategies to your video's content.

## THIS CHAPTER
Chapter {{chapter_number}}/{{total_chapters}}: "{{chapter_name}}" ({{chapter_start_tc}} - {{chapter_end_tc}}, {{chapter_duration_seconds}}s)
Purpose: {{chapter_purpose}}

A-Roll appearance (your B-Roll style must complement this):
{{llm_answer_1}}

Beats:
{{chapter_beats}}

Transcript:
{{chapter_transcript}}

## MATCHED REFERENCE STRATEGIES — adapt these for your chapter
Each entry pairs one of YOUR beats with a reference beat. The reference beat includes its purpose, emotion, strategy_points (the visual blueprint), and frequency target.

{{prev_chapter_output}}

## INSTRUCTIONS

For each beat in YOUR chapter, look at its matched reference beat's strategy_points. These describe the visual approach — what editorial job the b-rolls do and what they look like.

### How to write NEW strategy points:
1. Take the matched reference beat's strategy_points as your starting template
2. ADAPT them to fit THIS beat's transcript content — change the specific subjects, scenarios, and topics but keep the visual approach, color logic, and motion style
3. For each distinct visual purpose, write ONE strategy point

### Each strategy point MUST include:
- WHAT is shown and WHY (the editorial job this group of b-rolls does)
- COLORS used and WHY those colors (what feeling do they create)
- STYLE/MOTION and WHY (slow = authority, fast = urgency, handheld = authenticity, etc.)
- If the colors or style SHIFT from the previous strategy point or beat, explain the shift and what it accomplishes emotionally

Write each strategy point as a single flowing paragraph that weaves all of the above together naturally — not as separate sub-items.

### What NOT to do:
- Do NOT list individual elements — find what's COMMON across them
- Do NOT describe more than 5 strategy points per beat — merge similar approaches
- Do NOT use generic descriptions — anchor to THIS beat's specific content
- If a beat only has one visual approach, that's fine — one strategy point

### How many strategy points?
Count how many DISTINCT visual purposes the b-rolls serve in this beat. Each distinct purpose = one strategy point. Typically 1-4 per beat. Do NOT split a group just because individual clips differ slightly — group by the editorial job they share.

### Beat transitions:
Since beats may reference different reference videos, ensure style TRANSITIONS between adjacent beats feel cohesive. If two adjacent beats come from very different reference styles, weave the transition into the strategy point descriptions.

### Match A-Roll style:
Look at the A-Roll appearance above. All B-Roll style notes must complement it — similar color temperature, compatible tones, coherent visual feel.

Return JSON:
\`\`\`json
{
  "chapter_name": "{{chapter_name}}",
  "beat_strategies": [
    {
      "beat_name": "The Opening Hook",
      "beat_emotion": "Curiosity building to wonder",
      "matched_from": "Crunchy Brain Syndrome / The Amazing Memory Man",
      "strategy_points": [
        "Tropical lifestyle establishing shots — golden-hour close-ups of pina colada ingredients being prepared, coconut water pouring in warm amber tones. Slow, sensual camera movement. Creates the familiar pleasure feeling before the medical reveal, bridging everyday enjoyment to clinical science.",
        "Clinical transition shots — medical imagery of swollen limbs with cool blue-white grading, static framing. Sharp temperature shift from the warm tropics signals authority and moves the viewer from indulgence to evidence."
      ],
      "reference_frequency": { "broll_per_minute": 11, "broll_avg_duration": 3.2 }
    }
  ]
}
\`\`\`

Rules:
- One entry per beat — every beat in your chapter must appear
- \`beat_emotion\` — create a NEW emotion for this beat based on your video's content
- \`strategy_points\` — create NEW points adapted to your script, using the reference as a blueprint
- \`reference_frequency\` — pass through from the enriched match data unchanged
- \`matched_from\` — format as "Reference Name / Beat Name"`

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), ver.id)

console.log(`Combined strategy (id=${strat.id}) updated:`)
console.log('  Stage 0: Match beats to references (LLM, slim output)')
console.log('  Stage 1: Enrich beat matches (Programmatic)')
console.log('  Stage 2: Create strategy from reference (LLM, rewritten)')
console.log('  Removed: old Stage 2 (enrich_beat_frequency)')
console.log('  Stage 2 changes:')
console.log('    - Removed: {{all_reference_analyses_slim}}, frequency_targets, strategy block, matched_references')
console.log('    - Added: enriched matches via {{prev_chapter_output}}')
console.log('    - Output: { chapter_name, beat_strategies: [{ beat_name, beat_emotion, matched_from, strategy_points, reference_frequency }] }')
process.exit(0)
