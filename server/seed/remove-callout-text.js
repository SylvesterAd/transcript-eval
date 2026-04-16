import db from '../db.js'

function removeCallout(stagesJson) {
  const stages = JSON.parse(stagesJson)
  let changes = 0

  for (const stage of stages) {
    // Remove from system instruction
    if (stage.system_instruction?.includes('Callout')) {
      let si = stage.system_instruction

      // Remove "Callout Text:" paragraph from Main Categories
      si = si.replace(/Callout Text: On-screen text[^\n]*\n?/g, '')

      // Remove "Subtitles are not Callout Text OR overlays." sentence if leftover
      si = si.replace(/Subtitles are not Callout Text OR overlays\.\s*/g, '')

      // Remove "## Callout Text:" schema section (everything from ## Callout Text: to next ## or # section)
      si = si.replace(/## Callout Text:\n(?:- [^\n]*\n?)*/g, '')

      // Remove "Do NOT report subtitles as Callout Text" references
      si = si.replace(/Do NOT report subtitles as Callout Text, Overlay, or any category\./g,
        'Do NOT report subtitles as Overlay or any category.')

      // Remove "Callout Text" from footer instructions like "Identify every B-Roll, Graphic Package/PiP, Callout Text, and Overlay Image"
      si = si.replace(/B-Roll, Graphic Package\/PiP, Callout Text, and Overlay Image/g,
        'B-Roll, Graphic Package/PiP, and Overlay Image')

      stage.system_instruction = si
      changes++
    }

    // Remove from prompt
    if (stage.prompt?.includes('Callout')) {
      let p = stage.prompt

      // Remove "Callout Text" from prompt text
      p = p.replace(/B-Roll, Graphic Package\/PiP, Callout Text, and Overlay Image/g,
        'B-Roll, Graphic Package/PiP, and Overlay Image')

      // Remove callout_text JSON example block
      p = p.replace(/,\s*\{\s*"category":\s*"callout_text"[^}]*\}/g, '')

      stage.prompt = p
      changes++
    }
  }

  return { stages, changes }
}

for (const sid of [2, 3, 4]) {
  const strat = await db.prepare('SELECT name FROM broll_strategies WHERE id = ?').get(sid)
  const ver = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(sid)
  if (!ver) { console.log(`Strategy ${sid}: no version found`); continue }

  const { stages, changes } = removeCallout(ver.stages_json)

  // Verify no callout remains
  const remaining = JSON.stringify(stages).toLowerCase().match(/callout/g)
  if (remaining) {
    console.log(`Strategy ${sid} (${strat.name}): WARNING — ${remaining.length} callout references remain after cleanup`)
  }

  if (changes > 0) {
    await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), ver.id)
    console.log(`Strategy ${sid} (${strat.name}): ${changes} stage(s) updated`)
  } else {
    console.log(`Strategy ${sid} (${strat.name}): no callout text found`)
  }
}

console.log('\nDone')
process.exit(0)
