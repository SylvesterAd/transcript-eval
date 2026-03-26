import initSqlJs from 'sql.js'
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'data')
const DB_PATH = join(DATA_DIR, 'eval.db')
const LOCK_PATH = join(DATA_DIR, 'eval.db.lock')
const BACKUP_DIR = join(DATA_DIR, 'backups')

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(BACKUP_DIR, { recursive: true })

// ── Lock: prevent concurrent processes from corrupting the database ─────
function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    try {
      const lockPid = parseInt(readFileSync(LOCK_PATH, 'utf-8').trim())
      try {
        process.kill(lockPid, 0) // Check if process is alive
        console.error(`[db] FATAL: Database locked by running process PID ${lockPid}.`)
        console.error(`[db] If stale, delete: ${LOCK_PATH}`)
        process.exit(1)
      } catch {
        console.log(`[db] Clearing stale lock (PID ${lockPid} is dead)`)
      }
    } catch { /* corrupt lock file */ }
  }
  writeFileSync(LOCK_PATH, String(process.pid))
  console.log(`[db] Lock acquired (PID ${process.pid})`)
}

function releaseLock() {
  try {
    if (!existsSync(LOCK_PATH)) return
    const lockPid = parseInt(readFileSync(LOCK_PATH, 'utf-8').trim())
    if (lockPid === process.pid) {
      unlinkSync(LOCK_PATH)
    }
  } catch { /* ignore */ }
}

acquireLock()
process.on('exit', releaseLock)
process.on('SIGINT', () => { releaseLock(); process.exit(0) })
process.on('SIGTERM', () => { releaseLock(); process.exit(0) })

// ── Backup: auto-backup on startup before any changes ───────────────────
function createBackup(label) {
  if (!existsSync(DB_PATH)) return
  const fileSize = readFileSync(DB_PATH).length
  if (fileSize < 200) return // Don't backup empty databases
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupName = `eval-${ts}${label ? '-' + label : ''}.db`
  const backupPath = join(BACKUP_DIR, backupName)
  copyFileSync(DB_PATH, backupPath)
  console.log(`[db] Backup created: ${backupName} (${(fileSize / 1024).toFixed(1)}KB)`)
  pruneBackups()
}

function pruneBackups() {
  const files = readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('eval-') && f.endsWith('.db'))
    .sort()
  // Keep last 20 backups
  while (files.length > 20) {
    const old = files.shift()
    try { unlinkSync(join(BACKUP_DIR, old)) } catch { /* ignore */ }
  }
}

createBackup('startup')

// ── Database initialization ─────────────────────────────────────────────
const SQL = await initSqlJs()

let db
if (existsSync(DB_PATH)) {
  const buffer = readFileSync(DB_PATH)
  db = new SQL.Database(buffer)
} else {
  db = new SQL.Database()
}

// Run schema migration
const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8')
db.exec(schema)
db.exec('PRAGMA foreign_keys = ON')

// Column migrations for existing tables
const migrations = [
  ['videos', 'file_path', 'ALTER TABLE videos ADD COLUMN file_path TEXT'],
  ['videos', 'thumbnail_path', 'ALTER TABLE videos ADD COLUMN thumbnail_path TEXT'],
  ['videos', 'video_type', "ALTER TABLE videos ADD COLUMN video_type TEXT DEFAULT 'raw'"],
  ['videos', 'group_id', 'ALTER TABLE videos ADD COLUMN group_id INTEGER REFERENCES video_groups(id)'],
  ['transcripts', 'word_timestamps_json', 'ALTER TABLE transcripts ADD COLUMN word_timestamps_json TEXT'],
  ['videos', 'transcription_status', 'ALTER TABLE videos ADD COLUMN transcription_status TEXT'],
  ['videos', 'transcription_error', 'ALTER TABLE videos ADD COLUMN transcription_error TEXT'],
  ['video_groups', 'assembly_status', 'ALTER TABLE video_groups ADD COLUMN assembly_status TEXT'],
  ['video_groups', 'assembly_error', 'ALTER TABLE video_groups ADD COLUMN assembly_error TEXT'],
  ['video_groups', 'assembled_transcript', 'ALTER TABLE video_groups ADD COLUMN assembled_transcript TEXT'],
  ['video_groups', 'assembly_details_json', 'ALTER TABLE video_groups ADD COLUMN assembly_details_json TEXT'],
  ['experiments', 'video_ids_json', 'ALTER TABLE experiments ADD COLUMN video_ids_json TEXT'],
  ['experiment_runs', 'error_message', 'ALTER TABLE experiment_runs ADD COLUMN error_message TEXT'],
  ['video_groups', 'upload_batch_id', 'ALTER TABLE video_groups ADD COLUMN upload_batch_id TEXT'],
  ['video_groups', 'timeline_json', 'ALTER TABLE video_groups ADD COLUMN timeline_json TEXT'],
  ['videos', 'media_type', "ALTER TABLE videos ADD COLUMN media_type TEXT DEFAULT 'video'"],
  ['video_groups', 'rough_cut_config_json', 'ALTER TABLE video_groups ADD COLUMN rough_cut_config_json TEXT'],
  ['video_groups', 'sync_mode', "ALTER TABLE video_groups ADD COLUMN sync_mode TEXT"],
  ['video_groups', 'editor_state_json', 'ALTER TABLE video_groups ADD COLUMN editor_state_json TEXT'],
  ['videos', 'frames_status', 'ALTER TABLE videos ADD COLUMN frames_status TEXT'],
]

// Migrate experiment_runs CHECK constraint to allow 'partial' status
try {
  const tableInfo = db.exec("SELECT sql FROM sqlite_master WHERE name='experiment_runs'")
  const createSql = tableInfo[0]?.values[0]?.[0] || ''
  if (createSql.includes("'partial'") === false) {
    console.log('[db] Migrating experiment_runs to allow partial status...')
    db.exec(`PRAGMA foreign_keys = OFF;
      DROP TABLE IF EXISTS experiment_runs_new;
      CREATE TABLE experiment_runs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id INTEGER NOT NULL REFERENCES experiments(id),
        video_id INTEGER NOT NULL REFERENCES videos(id),
        run_number INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete', 'failed', 'partial')),
        total_score REAL, score_breakdown_json TEXT, total_tokens INTEGER, total_cost REAL,
        total_runtime_ms INTEGER, created_at TEXT DEFAULT (datetime('now')), completed_at TEXT,
        error_message TEXT
      );
      INSERT INTO experiment_runs_new SELECT id, experiment_id, video_id, run_number, status,
        total_score, score_breakdown_json, total_tokens, total_cost, total_runtime_ms,
        created_at, completed_at, error_message FROM experiment_runs;
      DROP TABLE experiment_runs;
      ALTER TABLE experiment_runs_new RENAME TO experiment_runs;
      PRAGMA foreign_keys = ON;
    `)
    console.log('[db] Migration complete')
  }
} catch (e) { console.error('[db] Migration error:', e.message) }

for (const [table, column, sql] of migrations) {
  try {
    const cols = db.exec(`PRAGMA table_info(${table})`)[0]
    const hasCol = cols?.values?.some(row => row[1] === column)
    if (!hasCol) {
      db.exec(sql)
    }
  } catch {
    // Column already exists or table doesn't exist yet
  }
}
// ── Periodic auto-backup (every 10 minutes) ─────────────────────────────
let _saveCount = 0
const BACKUP_EVERY_N_SAVES = 100 // backup after every 100 writes

function save() {
  const data = db.export()
  writeFileSync(DB_PATH, Buffer.from(data))
  _saveCount++
  if (_saveCount >= BACKUP_EVERY_N_SAVES) {
    _saveCount = 0
    createBackup('auto')
  }
}

save() // persist migration changes

// Also backup every 10 minutes
setInterval(() => {
  createBackup('periodic')
}, 10 * 60 * 1000).unref()

// ── Wrapper matching better-sqlite3 API shape ───────────────────────────
function prepare(sql) {
  return {
    run(...params) {
      db.run(sql, params)
      const lastId = db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0]?.[0]
      const changes = db.getRowsModified()
      save()
      return { lastInsertRowid: lastId, changes }
    },
    get(...params) {
      const stmt = db.prepare(sql)
      stmt.bind(params)
      if (stmt.step()) {
        const cols = stmt.getColumnNames()
        const vals = stmt.get()
        stmt.free()
        return Object.fromEntries(cols.map((c, i) => [c, vals[i]]))
      }
      stmt.free()
      return undefined
    },
    all(...params) {
      const stmt = db.prepare(sql)
      stmt.bind(params)
      const cols = stmt.getColumnNames()
      const rows = []
      while (stmt.step()) {
        const vals = stmt.get()
        rows.push(Object.fromEntries(cols.map((c, i) => [c, vals[i]])))
      }
      stmt.free()
      return rows
    }
  }
}

function exec(sql) {
  db.exec(sql)
  save()
}

function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN')
    try {
      const result = fn(...args)
      db.exec('COMMIT')
      save()
      return result
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
}

export default { prepare, exec, transaction, save }
