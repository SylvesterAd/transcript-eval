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
    "SELECT word_timestamps_json, acoustic_features_json FROM transcripts WHERE video_id = ? AND type = 'raw'"
  ).get(video.id)
  let words = []
  try { words = JSON.parse(t.word_timestamps_json || '[]') } catch {}
  let acoustic = null
  try { acoustic = t.acoustic_features_json ? JSON.parse(t.acoustic_features_json) : null } catch {}

  console.log(`[auto_v2] running on group ${groupId} (${group.assembled_transcript.length} chars, ${words.length} words, acoustic=${acoustic ? acoustic.frames.length + ' frames' : 'none'})`)
  const model = process.env.AUTO_V2_MODEL || 'claude-opus-4-7'
  const r = await runAgent({
    assembledTranscript: group.assembled_transcript,
    wordTimestamps: words,
    acousticFeatures: acoustic,
    model,
  })
  // Anthropic 2026 pricing per MTok
  const PRICING = {
    'claude-opus-4-7':  { in: 15, out: 75, cacheCreate: 18.75, cacheRead: 1.50 },
    'claude-sonnet-4-6':{ in: 3,  out: 15, cacheCreate: 3.75,  cacheRead: 0.30 },
    'claude-haiku-4-5-20251001': { in: 1, out: 5, cacheCreate: 1.25, cacheRead: 0.10 },
  }
  const p = PRICING[model] || PRICING['claude-opus-4-7']
  const tk = r.totalTokens
  const cost = (tk.in * p.in + tk.out * p.out + (tk.cache_create||0) * p.cacheCreate + (tk.cache_read||0) * p.cacheRead) / 1_000_000
  console.log(`[auto_v2] model=${model}  stop=${r.stopReason}  toolCalls=${r.toolCalls}`)
  console.log(`[auto_v2] tokens uncached_in=${tk.in}  cache_create=${tk.cache_create||0}  cache_read=${tk.cache_read||0}  out=${tk.out}`)
  console.log(`[auto_v2] cost = $${cost.toFixed(4)}  (uncached $${(tk.in*p.in/1e6).toFixed(2)} + create $${((tk.cache_create||0)*p.cacheCreate/1e6).toFixed(2)} + read $${((tk.cache_read||0)*p.cacheRead/1e6).toFixed(2)} + out $${(tk.out*p.out/1e6).toFixed(2)})`)
  console.log(`[auto_v2] cuts: ${r.cuts.length}, uncertain: ${r.uncertain.length}`)
  console.log()
  console.log(`[auto_v2] tool-call sequence (${r.toolCallLog.length} calls):`)
  for (let i = 0; i < r.toolCallLog.length; i++) {
    console.log(`  ${String(i+1).padStart(3)}.  ${r.toolCallLog[i]}`)
  }
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
