// One-shot backfill (Option A) for sub-groups created before slice-2 deployed
// the propagation logic in confirmClassificationGroup. For each existing
// sub-group that's missing path_id, auto_rough_cut, or broll_example_sets,
// copy those values down from the nearest top-level ancestor.
//
// Why this exists: pre-slice-2 splits inserted sub-groups without copying
// refs or propagating path_id, so the live editor at /editor/<sub-group>/...
// shows no references and any path-based automation silently no-ops on the
// sub-group. After slice-2, fresh splits propagate at create time — this
// script catches up the rows that were created before the fix.
//
// Defaults to dry-run (prints what it would change). Pass --commit to
// actually write to the DB.
//
// Run via:
//   node --env-file=.env server/seed/backfill-subgroup-refs-and-path.js          # dry-run
//   node --env-file=.env server/seed/backfill-subgroup-refs-and-path.js --commit # apply

import db from '../db.js'

const COMMIT = process.argv.includes('--commit')

// Walk from a sub-group up through parent_group_id chains until we hit a
// row whose parent_group_id is NULL — that's the top-level project. Returns
// the row, or null if the chain is broken.
async function findTopLevelAncestor(subGroupId) {
  let current = await db.prepare(
    'SELECT id, parent_group_id, path_id, auto_rough_cut FROM video_groups WHERE id = ?'
  ).get(subGroupId)
  while (current && current.parent_group_id) {
    current = await db.prepare(
      'SELECT id, parent_group_id, path_id, auto_rough_cut FROM video_groups WHERE id = ?'
    ).get(current.parent_group_id)
  }
  return current || null
}

async function copyExampleSetsFromAncestorToSubGroup(ancestorId, subGroupId) {
  // Skip if the sub-group already has any example sets (don't double-copy
  // on re-runs).
  const existing = await db.prepare(
    'SELECT id FROM broll_example_sets WHERE group_id = ? LIMIT 1'
  ).get(subGroupId)
  if (existing) return { copied: 0, reason: 'already has example_sets' }

  const sources = await db.prepare(`
    SELECT s.id AS set_id, s.created_by, src.kind, src.source_url, src.label,
           src.status, src.error, src.meta_json, src.is_favorite
    FROM broll_example_sets s
    LEFT JOIN broll_example_sources src ON src.example_set_id = s.id
    WHERE s.group_id = ?
  `).all(ancestorId)

  if (sources.length === 0) return { copied: 0, reason: 'ancestor has no example_sets' }

  // Group sources by ancestor set_id so we can recreate the same set/source
  // hierarchy under the sub-group.
  const setsByAncestorSetId = new Map()
  for (const row of sources) {
    if (!setsByAncestorSetId.has(row.set_id)) {
      setsByAncestorSetId.set(row.set_id, { created_by: row.created_by, sources: [] })
    }
    if (row.kind != null) {
      setsByAncestorSetId.get(row.set_id).sources.push({
        kind: row.kind,
        source_url: row.source_url,
        label: row.label,
        status: row.status,
        error: row.error,
        meta_json: row.meta_json,
        is_favorite: row.is_favorite,
      })
    }
  }

  let copied = 0
  for (const [, set] of setsByAncestorSetId) {
    if (!COMMIT) {
      copied += set.sources.length
      continue
    }
    const setRes = await db.prepare(
      'INSERT INTO broll_example_sets (group_id, created_by) VALUES (?, ?)'
    ).run(subGroupId, set.created_by || null)
    const newSetId = setRes.lastInsertRowid
    for (const src of set.sources) {
      await db.prepare(`
        INSERT INTO broll_example_sources (example_set_id, kind, source_url, label, status, error, meta_json, is_favorite)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(newSetId, src.kind, src.source_url, src.label, src.status, src.error, src.meta_json, src.is_favorite)
      copied++
    }
  }
  return { copied, reason: COMMIT ? 'copied' : 'would copy' }
}

async function run() {
  console.log(`[backfill] ${COMMIT ? 'COMMIT mode (writes will be applied)' : 'DRY-RUN (no writes — pass --commit to apply)'}`)

  const subGroups = await db.prepare(
    'SELECT id, name, parent_group_id, path_id, auto_rough_cut FROM video_groups WHERE parent_group_id IS NOT NULL ORDER BY id'
  ).all()
  console.log(`[backfill] Found ${subGroups.length} sub-group(s) to inspect`)

  let pathFills = 0
  let autoRcFills = 0
  let refSubGroupsTouched = 0
  let refRowsCopied = 0

  for (const sg of subGroups) {
    const ancestor = await findTopLevelAncestor(sg.id)
    if (!ancestor) {
      console.warn(`[backfill] sub-group ${sg.id} has broken ancestor chain — skipping`)
      continue
    }

    // path_id propagation
    if (!sg.path_id && ancestor.path_id) {
      console.log(`[backfill] sub-group ${sg.id} (${sg.name}): set path_id='${ancestor.path_id}' from ancestor ${ancestor.id}`)
      pathFills++
      if (COMMIT) {
        await db.prepare('UPDATE video_groups SET path_id = ? WHERE id = ?').run(ancestor.path_id, sg.id)
      }
    }

    // auto_rough_cut propagation (only if ancestor has it set true; default
    // false on sub-groups is already correct for projects that opted out).
    if (!sg.auto_rough_cut && ancestor.auto_rough_cut) {
      console.log(`[backfill] sub-group ${sg.id} (${sg.name}): set auto_rough_cut=true from ancestor ${ancestor.id}`)
      autoRcFills++
      if (COMMIT) {
        await db.prepare('UPDATE video_groups SET auto_rough_cut = TRUE WHERE id = ?').run(sg.id)
      }
    }

    // broll_example_sets propagation
    const refResult = await copyExampleSetsFromAncestorToSubGroup(ancestor.id, sg.id)
    if (refResult.copied > 0) {
      console.log(`[backfill] sub-group ${sg.id} (${sg.name}): ${refResult.reason} ${refResult.copied} example_source(s) from ancestor ${ancestor.id}`)
      refSubGroupsTouched++
      refRowsCopied += refResult.copied
    }
  }

  console.log(`[backfill] Summary:`)
  console.log(`  path_id     ${pathFills} sub-group(s)`)
  console.log(`  auto_rc     ${autoRcFills} sub-group(s)`)
  console.log(`  refs        ${refRowsCopied} source row(s) across ${refSubGroupsTouched} sub-group(s)`)
  console.log(`[backfill] ${COMMIT ? 'Applied.' : 'Dry-run only — re-run with --commit to apply.'}`)
  process.exit(0)
}

run().catch(err => {
  console.error('[backfill] failed:', err)
  process.exit(1)
})
