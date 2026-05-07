// scripts/run-auto-v2-on-group.js
//
// Usage:
//   node --env-file=.env scripts/run-auto-v2-on-group.js <group_id>
//
// Runs the auto_v2 agent against a group's assembled_transcript + raw word
// timestamps and prints the proposed cuts. Does NOT touch annotations_json.

import db from '../server/db.js'
import { runAgent } from '../server/services/rough-cut-agent/index.js'

async function main() {
  const groupId = parseInt(process.argv[2], 10)
  if (Number.isNaN(groupId)) {
    console.error('usage: node scripts/run-auto-v2-on-group.js <group_id>')
    process.exit(1)
  }

  const group = await db.prepare('SELECT assembled_transcript FROM video_groups WHERE id = ?').get(groupId)
  if (!group?.assembled_transcript) {
    console.error(`group ${groupId} has no assembled_transcript`)
    process.exit(1)
  }
  const video = await db.prepare(`
    SELECT v.id FROM videos v
    JOIN transcripts t ON t.video_id = v.id AND t.type = 'raw'
    WHERE (v.group_id = ? OR v.group_id IN (SELECT id FROM video_groups WHERE parent_group_id = ?))
      AND v.video_type = 'raw'
    ORDER BY v.id LIMIT 1
  `).get(groupId, groupId)
  if (!video) {
    console.error(`group ${groupId} has no video with raw transcript`)
    process.exit(1)
  }
  const t = await db.prepare(
    "SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw'"
  ).get(video.id)
  let words = []
  try { words = JSON.parse(t.word_timestamps_json || '[]') } catch {}

  console.log(`[auto_v2] running on group ${groupId} (${group.assembled_transcript.length} chars, ${words.length} words)`)
  const r = await runAgent({
    assembledTranscript: group.assembled_transcript,
    wordTimestamps: words,
    model: 'claude-opus-4-7',
  })
  console.log(`[auto_v2] stop=${r.stopReason}  tokens=in:${r.totalTokens.in} out:${r.totalTokens.out}  toolCalls=${r.toolCalls}`)
  console.log(`[auto_v2] cuts: ${r.cuts.length}, uncertain: ${r.uncertain.length}`)
  console.log()
  for (const c of r.cuts) {
    console.log(`  [${c.start.toFixed(2)}–${c.end.toFixed(2)}]  ${c.category.padEnd(18)}  conf=${c.confidence.toFixed(2)}  ${c.reason}`)
    for (const e of c.evidence) console.log(`     · ${e}`)
  }
  process.exit(0)
}

main().catch(err => {
  console.error('[auto_v2] failed:', err)
  process.exit(1)
})
