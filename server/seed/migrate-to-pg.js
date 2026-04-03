/**
 * Migrate data from local SQLite (eval.db) to PostgreSQL (Supabase).
 *
 * Usage: DATABASE_URL=postgresql://... node server/seed/migrate-to-pg.js
 */
import initSqlJs from 'sql.js'
import pg from 'pg'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, '..', '..', 'data', 'eval.db')
const SCHEMA_PATH = join(__dirname, '..', 'schema-pg.sql')

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required')
  process.exit(1)
}

if (!existsSync(DB_PATH)) {
  console.error(`SQLite database not found at ${DB_PATH}`)
  process.exit(1)
}

// Connect to PostgreSQL
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

// Load SQLite
const SQL = await initSqlJs()
const buffer = readFileSync(DB_PATH)
const sqliteDb = new SQL.Database(buffer)

// Run PostgreSQL schema
console.log('Creating PostgreSQL schema...')
const schema = readFileSync(SCHEMA_PATH, 'utf-8')
await pool.query(schema)

// Tables in dependency order (referenced tables first)
const tables = [
  'video_groups',
  'videos',
  'transcripts',
  'strategies',
  'strategy_versions',
  'experiments',
  'experiment_runs',
  'run_stage_outputs',
  'metrics',
  'deletion_annotations',
  'analysis_records',
  'prompt_versions',
  'diff_cache',
  'spending_log',
]

for (const table of tables) {
  console.log(`Migrating ${table}...`)

  // Get all rows from SQLite
  let rows
  try {
    const stmt = sqliteDb.prepare(`SELECT * FROM ${table}`)
    const cols = stmt.getColumnNames()
    rows = []
    while (stmt.step()) {
      const vals = stmt.get()
      rows.push(Object.fromEntries(cols.map((c, i) => [c, vals[i]])))
    }
    stmt.free()
  } catch (e) {
    console.log(`  Skipping ${table}: ${e.message}`)
    continue
  }

  if (rows.length === 0) {
    console.log(`  ${table}: 0 rows (empty)`)
    continue
  }

  // Get column names from first row
  const columns = Object.keys(rows[0])

  // Build INSERT with ON CONFLICT DO NOTHING (for re-runs)
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
  const insertSql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`

  let inserted = 0
  for (const row of rows) {
    const values = columns.map(c => row[c])
    try {
      const result = await pool.query(insertSql, values)
      if (result.rowCount > 0) inserted++
    } catch (e) {
      // Log but continue on individual row errors
      if (!e.message.includes('duplicate') && !e.message.includes('conflict')) {
        console.error(`  Error inserting into ${table}: ${e.message}`)
      }
    }
  }

  console.log(`  ${table}: ${inserted}/${rows.length} rows inserted`)

  // Reset sequence to max id
  try {
    await pool.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`)
  } catch {
    // Table might not have a serial id column
  }
}

console.log('\nMigration complete!')

// Verify counts
console.log('\nVerification:')
for (const table of tables) {
  try {
    const pgResult = await pool.query(`SELECT COUNT(*) AS count FROM ${table}`)
    const sqliteResult = sqliteDb.exec(`SELECT COUNT(*) FROM ${table}`)
    const pgCount = pgResult.rows[0].count
    const sqliteCount = sqliteResult[0]?.values[0]?.[0] ?? 0
    const match = parseInt(pgCount) >= parseInt(sqliteCount) ? 'OK' : 'MISMATCH'
    console.log(`  ${table}: SQLite=${sqliteCount} → PG=${pgCount} [${match}]`)
  } catch (e) {
    console.log(`  ${table}: Error - ${e.message}`)
  }
}

sqliteDb.close()
await pool.end()
