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
const STAGE_TO_DROP = /(analyze\s+a-?roll|export.*post.?cut.*video)/i  // matches "Analyze A-Roll Appearances" and "Export post-cut video"

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
    console.warn('WARNING: no stage matched STAGE_TO_DROP. Verify by running the pre-flight discovery query.')
  } else {
    console.log(`Dropped ${droppedStages.length} stage(s): ${droppedStages.map(s => s.name).join(', ')}`)
  }

  // Remap *StageIndex params on kept stages. Programmatic actions like
  // `split_by_chapter` reference earlier stages by their ORIGINAL index
  // via params keys ending in 'StageIndex' (chaptersStageIndex,
  // aRollStageIndex, elementsStageIndex, etc.). When we drop stages, those
  // indices go stale and the action looks up undefined → JSON.parse blows
  // up → "Cannot read properties of null (reading 'chapters')".
  //
  // Build old→new index map for kept stages, then rewrite each *StageIndex
  // value. If the original referent was dropped, null out the param so the
  // action treats it as "no source" instead of pointing at the wrong stage.
  const oldIndexOfKept = new Map() // newIdx -> oldIdx
  const newIndexOfOld = new Map() // oldIdx -> newIdx
  let kept = 0
  for (let oldIdx = 0; oldIdx < stages.length; oldIdx++) {
    if (!STAGE_TO_DROP.test(stages[oldIdx].name || '')) {
      newIndexOfOld.set(oldIdx, kept)
      oldIndexOfKept.set(kept, oldIdx)
      kept++
    }
  }
  for (const stage of keptStages) {
    const params = stage.params || stage.actionParams
    if (!params || typeof params !== 'object') continue
    for (const key of Object.keys(params)) {
      if (!key.endsWith('StageIndex')) continue
      const oldVal = params[key]
      if (typeof oldVal !== 'number') continue
      if (newIndexOfOld.has(oldVal)) {
        params[key] = newIndexOfOld.get(oldVal)
      } else {
        // referenced stage was dropped — null it out
        params[key] = null
      }
    }
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

  // ──────────────────────────────────────────────────────────────────────────
  // Cascading injection: prepend {{special_audio_note}} to the latest version
  // of every downstream strategy that runs after plan_prep. The note expands
  // to '' for video uploads (so behavior is unchanged), and to the verbatim
  // voice-over instruction for audio. We create NEW versions rather than
  // overwriting, so prior versions remain available for rollback.
  //
  // Strategies:
  //   - main_analysis: analyses each reference video
  //   - create_strategy: generates per-chapter b-roll strategy
  //   - create_combined_strategy: combines best b-roll strategy across refs
  //   - create_plan: generates the final b-roll plan from strategy
  //   - alt_plan: generates alternate plans for non-favorite references
  // ──────────────────────────────────────────────────────────────────────────
  const CASCADING_KINDS = [
    'main_analysis',
    'create_strategy',
    'create_combined_strategy',
    'create_plan',
    'alt_plan',
  ]

  for (const kind of CASCADING_KINDS) {
    // Always inject into the DEFAULT (no bundle_key) strategy of each kind so
    // both video and audio runs see the placeholder. Audio expands; video doesn't.
    const strat = await db.prepare(
      "SELECT id, name FROM broll_strategies WHERE strategy_kind = ? AND (bundle_key IS NULL OR bundle_key = '') ORDER BY id LIMIT 1"
    ).get(kind)
    if (!strat) {
      console.log(`  [skip] no default strategy for kind='${kind}'`)
      continue
    }
    const ver = await db.prepare(
      'SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(strat.id)
    if (!ver) {
      console.log(`  [skip] strategy ${strat.id} (${kind}) has no versions`)
      continue
    }
    const stagesArr = JSON.parse(ver.stages_json || '[]')

    // Idempotency: if every LLM stage already contains the placeholder, no-op.
    const llmStages = stagesArr.filter(s => typeof s.prompt === 'string' || typeof s.system_instruction === 'string')
    const allHaveNote = llmStages.length > 0 && llmStages.every(s =>
      (s.prompt || '').includes(AUDIO_NOTE_TAG) || (s.system_instruction || '').includes(AUDIO_NOTE_TAG)
    )
    if (allHaveNote) {
      console.log(`  [skip] strategy ${strat.id} (${strat.name}) already has {{special_audio_note}} in all LLM stages`)
      continue
    }

    const prefix = `${AUDIO_NOTE_TAG}\n\n`
    const stagesAugmented = stagesArr.map(s => {
      const out = { ...s }
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
      strat.id,
      `${ver.name} +audio_note`,
      `Auto-generated by create-broll-plan-strategy-audio.js. {{special_audio_note}} injected into LLM stage prompts. Empty for video uploads.`,
      ver.hook_prompt, ver.main_prompt, ver.plan_prompt,
      ver.hook_params_json, ver.main_params_json, ver.plan_params_json,
      JSON.stringify(stagesAugmented),
    )
    console.log(`  ✔ Injected {{special_audio_note}} into strategy ${strat.id} (${strat.name}, kind=${kind}) — new version created.`)
  }
})()
