import db from '../db.js'

const ver = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = 2 ORDER BY created_at DESC LIMIT 1').get()
const stages = JSON.parse(ver.stages_json)

// Replace Stage 6 prompt entirely
stages[5].prompt = `Analyze editing patterns for chapter {{chapter_number}} of {{total_chapters}}.

## ── CHAPTER ──
### "{{chapter_name}}" ({{chapter_start_tc}} - {{chapter_end_tc}}, {{chapter_duration_seconds}}s)
**Purpose:** {{chapter_purpose}}
**Emotion:** {{chapter_emotion}}
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

Using the pre-computed stats and raw elements above, produce TWO analyses:

---

## PART 1: Chapter-Level Patterns

Find patterns and extract rules across ALL elements in this chapter. Do NOT restate individual elements — find what's common across them.

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

---

## PART 2: Per-Beat B-Roll Strategy

For each beat, look at ALL the elements that fall within its timestamps. Group elements by their VISUAL PURPOSE — elements that serve the same editorial function and share a similar visual approach form one strategy point.

A strategy point answers: "What visual approach is used, what does it look like, and WHY does it look that way?"

### How to find strategy points:
1. Look at the elements in this beat
2. Group elements that serve the same function (e.g., all "prove the claim" elements, all "show the problem" elements, all "humanize" elements)
3. For each group, describe the visual approach as ONE strategy point

### Each strategy point MUST include:
- WHAT is shown and WHY (the editorial job this group of b-rolls does)
- COLORS used and WHY those colors (what feeling do they create)
- STYLE/MOTION and WHY (slow = authority, fast = urgency, handheld = authenticity, etc.)
- If the colors or style SHIFT from the previous strategy point or beat, explain the shift and what it accomplishes emotionally

### What NOT to do:
- Do NOT list individual elements — find what's COMMON across them
- Do NOT describe more than 5 strategy points per beat — merge similar approaches
- If a beat only has one visual approach, that's fine — one strategy point

### How many strategy points?
Count how many DISTINCT visual purposes the b-rolls serve in this beat. Each distinct purpose = one strategy point. Typically 1-4 per beat. Do NOT split a group just because individual clips differ slightly — group by the editorial job they share.

---

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
  "overall_rules": ["Overall editing rules for this chapter"],
  "beat_strategies": [
    {
      "beat_name": "Margaret's Devastating Discovery",
      "beat_emotion": "Empathy and personal pain",
      "strategy_points": [
        "Emotional reaction close-ups of women touching their faces, looking in mirrors — warm but slightly desaturated tones to show dissatisfaction. Slow, intimate camera movements. Builds personal connection by making the viewer SEE the pain on real faces.",
        "Clinical detail shots of dark spots, skin textures, dermatologist tools — cool whites and clinical blues under harsh fluorescent lighting. Static or slow zoom. Creates medical urgency and proves the problem is real, not cosmetic vanity.",
        "Lifestyle scenario shots of women avoiding social situations, canceling plans — muted earth tones, natural but dim lighting. Handheld feel. Shows the REAL COST of the problem beyond appearance — isolation and lost confidence."
      ]
    },
    {
      "beat_name": "The Hidden Epidemic",
      "beat_emotion": "Shock at the scale of the problem",
      "strategy_points": [
        "Statistical and document proof shots — charts, survey results, news headlines — clean whites and neutral backgrounds. Static. Sharp contrast from the emotional previous beat — shifts from 'one woman's story' to 'this affects everyone'. The white/neutral palette signals objectivity and data.",
        "Rapid montage of diverse women's faces showing concern — warm skin tones but cool background lighting. Quick cuts (2-3 seconds). Proves scale through volume — many faces = widespread problem."
      ]
    }
  ]
}
\`\`\``

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), ver.id)
console.log('Stage 6 prompt updated with beat_strategies')
process.exit(0)
