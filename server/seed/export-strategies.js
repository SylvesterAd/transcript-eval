import db from '../db.js'
import { writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const strategies = db.prepare('SELECT * FROM strategies ORDER BY id').all()
const versions = db.prepare('SELECT * FROM strategy_versions ORDER BY strategy_id, version_number').all()

const exported = strategies.map(s => ({
  id: s.id,
  name: s.name,
  description: s.description,
  created_at: s.created_at,
  versions: versions
    .filter(v => v.strategy_id === s.id)
    .map(v => ({
      version_number: v.version_number,
      stages: JSON.parse(v.stages_json || '[]'),
      notes: v.notes || '',
      created_at: v.created_at,
    })),
}))

const outPath = join(__dirname, 'strategies.json')
writeFileSync(outPath, JSON.stringify(exported, null, 2))
console.log(`Exported ${exported.length} strategies (${versions.length} versions) to ${outPath}`)
