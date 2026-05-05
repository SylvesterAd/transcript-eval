// server/seed/create-broll-plan-strategy-audio.js
//
// Clones broll_strategies id=7 (the main plan strategy) into a new strategy
// labelled "(Audio-Only)" with bundle_key='audio_only'. Removes the
// "Analyze A-Roll" stage and injects the
// {{special_audio_note}} placeholder at the top of every remaining stage's
// prompt + system_instruction so existing prompts still benefit even
// without manual editing.

import db from '../db.js'

const SOURCE_STRATEGY_ID = 7
const AUDIO_NOTE_TAG = '{{special_audio_note}}'
const STAGE_TO_DROP = /analyze\s+a-?roll/i  // matches "Analyze A-Roll Appearances"

;(async () => {
  console.log(`Cloning strategy id=${SOURCE_STRATEGY_ID} as Audio-Only variant...`)

  const src = await db.prepare('SELECT * FROM broll_strategies WHERE id = ?').get(SOURCE_STRATEGY_ID)
  if (!src) {
    console.error(`Source strategy ${SOURCE_STRATEGY_ID} not found.`)
    process.exit(1)
  }

  const newName = `${src.name} (Audio-Only)`
  const existing = await db.prepare('SELECT id FROM broll_strategies WHERE name = ?').get(newName)
  if (existing) {
    console.log(`Audio-Only strategy already exists at id=${existing.id}. Re-creating version only.`)
  }

  let newStrategyId
  if (existing) {
    newStrategyId = existing.id
  } else {
    const insert = await db.prepare(`
      INSERT INTO broll_strategies (
        name, description, strategy_kind, bundle_key, bundle_name,
        hook_strategy_id, main_strategy_id,
        analysis_model, analysis_system_prompt, analysis_prompt, analysis_params_json,
        plan_model, plan_system_prompt, plan_prompt, plan_params_json
      ) VALUES (?, ?, ?, 'audio_only', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newName,
      `${src.description || ''}\n\nAudio-only variant: skips A-Roll analysis; injects {{special_audio_note}}.`.trim(),
      src.strategy_kind,
      src.bundle_name,
      src.hook_strategy_id,
      src.main_strategy_id,
      src.analysis_model, src.analysis_system_prompt, src.analysis_prompt, src.analysis_params_json,
      src.plan_model, src.plan_system_prompt, src.plan_prompt, src.plan_params_json,
    )
    newStrategyId = insert.lastInsertRowid
  }

  // Pull latest source version
  const srcVersion = await db.prepare(`
    SELECT * FROM broll_strategy_versions
    WHERE strategy_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(SOURCE_STRATEGY_ID)
  if (!srcVersion) {
    console.error('Source strategy has no versions.')
    process.exit(1)
  }

  const stages = JSON.parse(srcVersion.stages_json || '[]')
  const droppedStages = stages.filter(s => STAGE_TO_DROP.test(s.name || ''))
  const keptStages = stages.filter(s => !STAGE_TO_DROP.test(s.name || ''))

  if (droppedStages.length === 0) {
    console.warn('WARNING: no stage matched /analyze.*a-?roll/i. Verify by running the pre-flight discovery query.')
  } else {
    console.log(`Dropped ${droppedStages.length} stage(s): ${droppedStages.map(s => s.name).join(', ')}`)
  }

  // Inject {{special_audio_note}} at top of every kept stage's prompt + system_instruction.
  // We add it once if not already present.
  const augmented = keptStages.map(stage => {
    const prefix = `${AUDIO_NOTE_TAG}\n\n`
    const out = { ...stage }
    if (typeof out.prompt === 'string' && !out.prompt.includes(AUDIO_NOTE_TAG)) {
      out.prompt = prefix + out.prompt
    }
    if (typeof out.system_instruction === 'string' && !out.system_instruction.includes(AUDIO_NOTE_TAG)) {
      out.system_instruction = prefix + out.system_instruction
    }
    return out
  })

  await db.prepare(`
    INSERT INTO broll_strategy_versions (
      strategy_id, name, notes,
      hook_prompt, main_prompt, plan_prompt,
      hook_params_json, main_params_json, plan_params_json,
      stages_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newStrategyId,
    `${srcVersion.name} (Audio-Only)`,
    `Auto-generated from strategy_id=${SOURCE_STRATEGY_ID} version. ${droppedStages.length} a-roll stage(s) dropped; {{special_audio_note}} injected.`,
    srcVersion.hook_prompt, srcVersion.main_prompt, srcVersion.plan_prompt,
    srcVersion.hook_params_json, srcVersion.main_params_json, srcVersion.plan_params_json,
    JSON.stringify(augmented),
  )

  console.log(`✔ Created strategy id=${newStrategyId} with ${augmented.length} stages (was ${stages.length}).`)
  console.log(`  bundle_key='audio_only' — runtime will pick this for media_type='audio' uploads.`)
})()
