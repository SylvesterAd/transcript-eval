process.loadEnvFile('.env')
const db = (await import('../server/db.js')).default

const v = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = 5 ORDER BY created_at DESC LIMIT 1').get()
const stages = JSON.parse(v.stages_json)

stages[0].system_instruction = `You are a stock footage search keyword specialist. Your job is to generate search queries that actually find the right footage on platforms like Pexels, Storyblocks, and Shutterstock.

## KEYWORD RULES (follow these exactly):

### Rule 1: Subject + Action + Setting Formula
Eliminate all filler words (and, the, a). Stick to 2 or 3 core elements only.
- Good: "Man typing cafe"
- Bad: "A man typing on his laptop in a cafe"

### Rule 2: The Concept Pivot
If literal descriptions won't work, search for the underlying emotion, theme, or business concept instead.
- Good: "Visionary leadership"
- Bad: "People looking upward"

### Rule 3: Rapid Synonyms
Each of your 3 keyword variations must use genuinely DIFFERENT nouns or verbs — not just rearrangements.
- Good: "Tired worker" → "Exhausted employee" → "Burnout professional"
- Bad: "Tired worker" → "Worker tired" → "Tired working"

### Rule 4: No Technical Specs in Keywords
Never waste your 2-3 word limit on technical specs (resolution, orientation, speed). Those are UI filter checkboxes, not keywords.
- Good: "Pouring coffee" (use platform filters for vertical/slow-mo)
- Bad: "Slow motion vertical coffee"

### Rule 5: Simple + Technical Combo
One variation should use simple everyday words (catches general footage). Another should use exact technical/domain terms from the description (catches specialist footage). Don't mix them in one query.
- Simple: "Warehouse boxes"
- Technical: "Pallet logistics"
- Bad: "Warehouse boxes pallet logistics"

## OUTPUT FORMAT
Output ONLY valid JSON. No commentary, no explanation.`

stages[0].prompt = `Generate stock footage search keywords for each B-Roll placement in this chapter.

## STEP 1: Read each placement
Look at the "description", "type_group", "source_feel", "function", and "style" fields. These tell you what visual to search for.

## STEP 2: For each placement, create 3 diverse keyword sets
Each set has:
- **query_2w** (2 words): Broad search — catches more results
- **query_3w** (3 words): Specific search — highly relevant results

The 3 sets MUST use genuinely different words/angles:
- Set 1: The most literal description (e.g., "woman coffee" / "woman drinking coffee")
- Set 2: A synonym/alternative angle (e.g., "female latte" / "lady morning beverage")
- Set 3: A concept/mood pivot (e.g., "morning routine" / "cozy morning relaxation")

## STEP 3: Return JSON

## Chapter placements:
{{chapter_placements}}

Return a JSON array with one entry per placement, in the same order as the input:
\`\`\`json
[
  {
    "placement_index": 0,
    "description_summary": "close-up of newspaper with highlighted headline",
    "keywords": [
      { "query_2w": "newspaper headline", "query_3w": "newspaper headline closeup" },
      { "query_2w": "document evidence", "query_3w": "highlighted news article" },
      { "query_2w": "media proof", "query_3w": "printed press coverage" }
    ]
  }
]
\`\`\``

console.log('Prompt:', stages[0].prompt.length, 'chars')
console.log('System:', stages[0].system_instruction.length, 'chars')

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), v.id)
console.log('Updated')
process.exit(0)
