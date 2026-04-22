import pg from 'pg'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Connection ─────────────────────────────────────────────────────────
// DATABASE_URL must point to Supavisor transaction mode (port 6543).
// Session mode (port 5432) caps concurrent clients at pool_size (~15
// on Nano/Micro), which we exhausted. Transaction mode returns the
// backend to the shared pool after each transaction, so pg.Pool can
// hold many idle clients without reserving Supabase backends.
// Do NOT use named prepared statements (client.query({ name:...})) —
// they break under transaction pooling.
const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('[db] FATAL: DATABASE_URL environment variable is required')
  process.exit(1)
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
})

pool.on('error', (err) => {
  console.error('[db] Pool error:', err.message)
})

// ── Schema initialization ──────────────────────────────────────────────
const schema = readFileSync(join(__dirname, 'schema-pg.sql'), 'utf-8')
try {
  await pool.query(schema)
  console.log('[db] Schema initialized')
  // Migrations for existing databases
  try {
    await pool.query(`ALTER TABLE transcripts DROP CONSTRAINT IF EXISTS transcripts_type_check`)
    await pool.query(`ALTER TABLE transcripts ADD CONSTRAINT transcripts_type_check CHECK (type IN ('raw', 'human_edited', 'rough_cut_adjusted'))`)
    await pool.query(`ALTER TABLE broll_example_sources ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT FALSE`)
    await pool.query(`CREATE TABLE IF NOT EXISTS user_tokens (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      balance INTEGER NOT NULL DEFAULT 10000,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`)
    await pool.query(`CREATE TABLE IF NOT EXISTS token_transactions (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('initial', 'debit', 'credit', 'refund')),
      description TEXT,
      group_id INTEGER REFERENCES video_groups(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`)
    await pool.query(`CREATE TABLE IF NOT EXISTS broll_searches (
      id SERIAL PRIMARY KEY,
      plan_pipeline_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      chapter_index INTEGER NOT NULL,
      placement_index INTEGER NOT NULL,
      variant_label TEXT,
      description TEXT,
      brief TEXT,
      keywords_json TEXT,
      status TEXT NOT NULL DEFAULT 'waiting',
      results_json TEXT,
      num_results INTEGER DEFAULT 0,
      error TEXT,
      api_log_id INTEGER,
      duration_ms INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    )`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_broll_searches_pipeline ON broll_searches(plan_pipeline_id)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_broll_searches_batch ON broll_searches(batch_id)`)
  } catch {}
} catch (e) {
  console.error('[db] Schema error:', e.message)
}

// ── Helpers ────────────────────────────────────────────────────────────

// Convert SQLite-style ? placeholders to PostgreSQL $1, $2, $3
function convertPlaceholders(sql) {
  let idx = 0
  return sql.replace(/\?/g, () => `$${++idx}`)
}

// Convert datetime('now') to NOW() in any SQL
function convertSql(sql) {
  let converted = convertPlaceholders(sql)
  converted = converted.replace(/datetime\('now'\)/gi, 'NOW()')
  return converted
}

// Retry on transient pool/connection errors — pgBouncer session-mode
// rejects with "MaxClientsInSessionMode" when pool_size is saturated.
// A short backoff usually clears this.
async function queryWithRetry(sql, params, maxRetries = 3) {
  let lastErr
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await pool.query(sql, params)
    } catch (err) {
      lastErr = err
      const msg = err?.message || ''
      const transient = /max clients|MaxClientsInSessionMode|ECONNREFUSED|Connection terminated|timeout/i.test(msg)
      if (!transient || attempt === maxRetries) throw err
      await new Promise(r => setTimeout(r, 75 * Math.pow(2, attempt)))
    }
  }
  throw lastErr
}

// ── Wrapper matching previous sync API shape (now async) ───────────────
function prepare(sql) {
  const pgSql = convertSql(sql)

  return {
    async run(...params) {
      // For INSERT, try to append RETURNING id if not already present
      const isInsert = /^\s*INSERT\s/i.test(pgSql)
      let execSql = pgSql
      if (isInsert && !/RETURNING\s/i.test(pgSql)) {
        execSql = pgSql + ' RETURNING id'
      }
      const result = await queryWithRetry(execSql, params)
      const lastInsertRowid = result.rows?.[0]?.id ?? null
      return { lastInsertRowid, changes: result.rowCount }
    },

    async get(...params) {
      const result = await queryWithRetry(pgSql, params)
      return result.rows[0] || undefined
    },

    async all(...params) {
      const result = await queryWithRetry(pgSql, params)
      return result.rows
    }
  }
}

async function exec(sql) {
  const pgSql = convertSql(sql)
  await queryWithRetry(pgSql, [])
}

function transaction(fn) {
  return async (...args) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(...args)
      await client.query('COMMIT')
      return result
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }
}

// No-op save for backward compatibility (PostgreSQL persists automatically)
function save() {}

export default { prepare, exec, transaction, save, pool }
