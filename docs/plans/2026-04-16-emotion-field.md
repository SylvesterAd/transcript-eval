# Add Emotion Field to Chapters & Beats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `"emotion"` field alongside `"purpose"` for chapters and beats across all strategy prompts and programmatic code, so the LLM considers the intended viewer emotion when creating b-roll plans.

**Architecture:** Update DB-stored strategy prompts (strategies 2, 3, 4) to include `"emotion"` in output schemas and examples. Update programmatic code in `broll.js` to extract and thread `{{chapter_emotion}}` and beat emotion through the pipeline. All changes are prompt text + one code file.

**Tech Stack:** Node.js, PostgreSQL (strategy prompt storage), LLM prompt engineering

---

## File Structure

- **Modify:** `server/services/broll.js` — programmatic `split_by_chapter` action, `allChaptersSummary` builder, per-chapter placeholder resolution
- **Modify:** DB rows via Node script — strategy version `stages_json` for strategies 2, 3, 4
- **Create:** `server/seed/add-emotion-field.js` — migration script to update all strategy prompts

---

### Task 1: Update programmatic code to thread emotion

**Files:**
- Modify: `server/services/broll.js`

This task adds `chapter_emotion` to the chapterSplits data structure and threads `{{chapter_emotion}}` through per-chapter prompt resolution.

- [ ] **Step 1: Add `chapter_emotion` to `split_by_chapter` in the main pipeline**

In `server/services/broll.js`, find the `split_by_chapter` action in the main `executePipeline` loop (~line 2637). The `chapterSplits` map currently builds:

```javascript
const beats = beatsRaw.map(b => `  - ${b.name} (${toTC(b.start_seconds)}-${toTC(b.end_seconds)}): ${b.description}${b.purpose ? ' | Purpose: ' + b.purpose : ''}`).join('\n')
```

Change to include emotion in beats:

```javascript
const beats = beatsRaw.map(b => `  - ${b.name} (${toTC(b.start_seconds)}-${toTC(b.end_seconds)}): ${b.description}${b.purpose ? ' | Purpose: ' + b.purpose : ''}${b.emotion ? ' | Emotion: ' + b.emotion : ''}`).join('\n')
```

And the return object currently has:

```javascript
chapter_purpose: ch.purpose || ch.description || '',
```

Add below it:

```javascript
chapter_emotion: ch.emotion || '',
```

- [ ] **Step 2: Add emotion to `allChaptersSummary`**

In the same file (~line 2666), the `allChaptersSummary` builder currently outputs:

```javascript
return `### Chapter ${idx + 1}: ${ch.name} (${toTC(ch.start_seconds)}-${toTC(ch.end_seconds)})\nPurpose: ${ch.purpose || ch.description || ''}\nBeats:\n${beats}`
```

Change to:

```javascript
return `### Chapter ${idx + 1}: ${ch.name} (${toTC(ch.start_seconds)}-${toTC(ch.end_seconds)})\nPurpose: ${ch.purpose || ch.description || ''}${ch.emotion ? '\nEmotion: ' + ch.emotion : ''}\nBeats:\n${beats}`
```

- [ ] **Step 3: Add `{{chapter_emotion}}` placeholder resolution**

In the per-chapter prompt resolution (~line 2404), after `.replace(/\{\{chapter_purpose\}\}/g, ch.chapter_purpose)`, add:

```javascript
.replace(/\{\{chapter_emotion\}\}/g, ch.chapter_emotion || '')
```

Do the same at the other per-chapter resolution site (~line 1153, in `executeAltPlans`):

```javascript
.replace(/\{\{chapter_emotion\}\}/g, ch.chapter_emotion || '')
```

- [ ] **Step 4: Add emotion to `split_by_chapter` in `executeAltPlans`**

The `executeAltPlans` function (~line 1042) also builds chapterSplits. Update it the same way:

```javascript
chapter_emotion: ch.emotion || '',
```

And update its beats formatting to include emotion (same pattern as Step 1).

- [ ] **Step 5: Verify syntax**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && node -c server/services/broll.js`
Expected: no output (clean parse)

- [ ] **Step 6: Commit**

```bash
git add server/services/broll.js
git commit -m "feat: thread chapter_emotion and beat emotion through pipeline"
```

---

### Task 2: Update Strategy 2 (Main Analysis) prompts

**Files:**
- Create: `server/seed/add-emotion-field.js`

This script updates the Stage 1 and Stage 6 prompts for strategy 2 to include emotion.

- [ ] **Step 1: Create the migration script**

Create `server/seed/add-emotion-field.js`:

```javascript
import db from '../db.js'

// ── Strategy 2: Main Analysis ──
const ver2 = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = 2 ORDER BY created_at DESC LIMIT 1').get()
const stages2 = JSON.parse(ver2.stages_json)

// Stage 1: Add emotion to output rules and JSON example
stages2[0].prompt = stages2[0].prompt
  .replace(
    `- "purpose": 1-2 sentences explaining WHY this chapter/beat exists in the video — what editorial or narrative function does it serve for the viewer`,
    `- "purpose": 1-2 sentences explaining WHY this chapter/beat exists in the video — what editorial or narrative function does it serve for the viewer
- "emotion": 1-2 sentences describing what the viewer is meant to FEEL during this chapter/beat — the emotional journey (e.g. curiosity, fear, relief, excitement, empathy, urgency)`
  )
  // Add emotion to chapter example
  .replace(
    `"purpose": "Hook the audience with a stark, personal warning. Establishes the stakes so viewers feel the urgency before any solutions are offered.",
      "beats"`,
    `"purpose": "Hook the audience with a stark, personal warning. Establishes the stakes so viewers feel the urgency before any solutions are offered.",
      "emotion": "Anxiety and dread — the viewer should feel personally threatened, like the ground is shifting under their feet.",
      "beats"`
  )
  // Add emotion to beat example
  .replace(
    `"purpose": "Create immediate urgency and personal stakes. Forces the viewer to stop scrolling and pay attention."`,
    `"purpose": "Create immediate urgency and personal stakes. Forces the viewer to stop scrolling and pay attention.",
          "emotion": "Shock and urgency — a gut punch that makes the viewer think 'this applies to ME'."`
  )

// Stage 6 (Pattern analysis): Add emotion to chapter header
stages2[5].prompt = stages2[5].prompt
  .replace(
    `**Purpose:** {{chapter_purpose}}
**Beats:**`,
    `**Purpose:** {{chapter_purpose}}
**Emotion:** {{chapter_emotion}}
**Beats:**`
  )

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages2), ver2.id)
console.log('Strategy 2 updated (stages 1, 6)')

// ── Strategy 3: Plan ──
const ver3 = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = 3 ORDER BY created_at DESC LIMIT 1').get()
const stages3 = JSON.parse(ver3.stages_json)

// Stage 4: Analyze Chapters & Beats — add emotion to output rules and example
stages3[3].prompt = stages3[3].prompt
  .replace(
    `- "purpose": 1-2 sentences explaining WHY this chapter/beat exists in the video — what editorial or narrative function does it serve for the viewer`,
    `- "purpose": 1-2 sentences explaining WHY this chapter/beat exists in the video — what editorial or narrative function does it serve for the viewer
- "emotion": 1-2 sentences describing what the viewer is meant to FEEL during this chapter/beat — the emotional journey (e.g. curiosity, fear, relief, excitement, empathy, urgency)`
  )
  .replace(
    `"purpose": "Hook the audience with a stark, personal warning. Establishes the stakes so viewers feel the urgency before any solutions are offered.",
      "beats"`,
    `"purpose": "Hook the audience with a stark, personal warning. Establishes the stakes so viewers feel the urgency before any solutions are offered.",
      "emotion": "Anxiety and dread — the viewer should feel personally threatened, like the ground is shifting under their feet.",
      "beats"`
  )
  .replace(
    `"purpose": "Create immediate urgency and personal stakes. Forces the viewer to stop scrolling and pay attention."`,
    `"purpose": "Create immediate urgency and personal stakes. Forces the viewer to stop scrolling and pay attention.",
          "emotion": "Shock and urgency — a gut punch that makes the viewer think 'this applies to ME'."`
  )

// Stage 6: Create B-Roll strategy — add emotion to chapter context
stages3[5].prompt = stages3[5].prompt
  .replace(
    `Purpose: {{chapter_purpose}}

A-Roll appearance`,
    `Purpose: {{chapter_purpose}}
Emotion: {{chapter_emotion}}

A-Roll appearance`
  )

// Stage 7: Per-chapter B-Roll plan — add emotion to chapter context
stages3[6].prompt = stages3[6].prompt
  .replace(
    `Purpose: {{chapter_purpose}}

Beats:`,
    `Purpose: {{chapter_purpose}}
Emotion: {{chapter_emotion}}

Beats:`
  )

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages3), ver3.id)
console.log('Strategy 3 updated (stages 4, 6, 7)')

// ── Strategy 4: Alt Plan ──
const ver4 = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = 4 ORDER BY created_at DESC LIMIT 1').get()
const stages4 = JSON.parse(ver4.stages_json)

// Stage 1: Create Alternative Strategy — add emotion to chapter context
stages4[0].prompt = stages4[0].prompt
  .replace(
    `Purpose: {{chapter_purpose}}

Beats:`,
    `Purpose: {{chapter_purpose}}
Emotion: {{chapter_emotion}}

Beats:`
  )

// Stage 2: Per-chapter Alternative Plan — add emotion to chapter context
stages4[1].prompt = stages4[1].prompt
  .replace(
    `Purpose: {{chapter_purpose}}

Beats:`,
    `Purpose: {{chapter_purpose}}
Emotion: {{chapter_emotion}}

Beats:`
  )

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages4), ver4.id)
console.log('Strategy 4 updated (stages 1, 2)')

console.log('\nDone — emotion field added to all strategies')
process.exit(0)
```

- [ ] **Step 2: Run the migration**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && node --env-file=.env server/seed/add-emotion-field.js`

Expected output:
```
Strategy 2 updated (stages 1, 6)
Strategy 3 updated (stages 4, 6, 7)
Strategy 4 updated (stages 1, 2)

Done — emotion field added to all strategies
```

- [ ] **Step 3: Verify the prompts were updated**

Run: `cd "/Users/laurynas/Desktop/one last /transcript-eval" && node --env-file=.env -e "import db from './server/db.js'; const v = await db.prepare('SELECT stages_json FROM broll_strategy_versions WHERE strategy_id = 2 ORDER BY created_at DESC LIMIT 1').get(); const s = JSON.parse(v.stages_json); console.log(s[0].prompt.includes('emotion') ? 'OK: Stage 1 has emotion' : 'FAIL'); console.log(s[5].prompt.includes('chapter_emotion') ? 'OK: Stage 6 has chapter_emotion' : 'FAIL')"`

Expected: both OK

- [ ] **Step 4: Commit**

```bash
git add server/seed/add-emotion-field.js
git commit -m "feat: add emotion field to all strategy prompts (strategies 2, 3, 4)"
```

---

### Task 3: Verify end-to-end

- [ ] **Step 1: Check strategy 2 Stage 1 prompt in admin UI**

Go to `http://localhost:5173/admin/broll?id=2` and verify Stage 1 shows:
- Output rules include `"emotion"` field description
- JSON example includes `"emotion"` in both chapter and beat

- [ ] **Step 2: Check strategy 3 prompts**

Go to `http://localhost:5173/admin/broll?id=3` and verify:
- Stage 4 (Analyze Chapters & Beats) has emotion in output rules and example
- Stage 6 (Create B-Roll strategy) has `Emotion: {{chapter_emotion}}`
- Stage 7 (Per-chapter B-Roll plan) has `Emotion: {{chapter_emotion}}`

- [ ] **Step 3: Check strategy 4 prompts**

Go to `http://localhost:5173/admin/broll?id=4` and verify:
- Stage 1 has `Emotion: {{chapter_emotion}}`
- Stage 2 has `Emotion: {{chapter_emotion}}`
