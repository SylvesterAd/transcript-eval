import pg from 'pg'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { extractYouTubeId } from './services/youtube.js'

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
  max: Number(process.env.PG_POOL_MAX) || 10,
  min: 0,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  statement_timeout: 30000,
  query_timeout: 30000,
  application_name: 'transcript-eval',
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
    await pool.query(`ALTER TABLE video_groups ADD COLUMN IF NOT EXISTS libraries_json TEXT`)
    await pool.query(`ALTER TABLE video_groups ADD COLUMN IF NOT EXISTS freepik_opt_in BOOLEAN DEFAULT TRUE`)
    await pool.query(`ALTER TABLE video_groups ADD COLUMN IF NOT EXISTS audience_json TEXT`)
    await pool.query(`ALTER TABLE video_groups ADD COLUMN IF NOT EXISTS path_id TEXT`)
    // Audit columns on videos for tracking transcription_status flips. Added
    // 2026-04-28 after a 'done' status mysteriously regressed to NULL with no
    // discoverable cause — without these we have no way to attribute future
    // regressions to a specific code path.
    await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`)
    await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS transcription_history JSONB DEFAULT '[]'::jsonb`)
    // Canonical 11-char YouTube video ID for cross-project download
    // reuse. Indexed so the lookup at download time stays cheap as the
    // videos table grows. Backfilled below for any rows that already
    // have a youtube_url but no youtube_id (one-time, on next deploy).
    await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS youtube_id TEXT`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_videos_youtube_id ON videos(youtube_id) WHERE youtube_id IS NOT NULL`)
    {
      const { rows: pending } = await pool.query(
        `SELECT id, youtube_url FROM videos WHERE youtube_url IS NOT NULL AND youtube_id IS NULL`
      )
      if (pending.length) {
        let backfilled = 0
        for (const row of pending) {
          const ytId = extractYouTubeId(row.youtube_url)
          if (!ytId) continue
          await pool.query(`UPDATE videos SET youtube_id = $1 WHERE id = $2`, [ytId, row.id])
          backfilled++
        }
        console.log(`[db] Backfilled youtube_id on ${backfilled}/${pending.length} videos rows`)
      }
    }
    await pool.query(`
      CREATE OR REPLACE FUNCTION videos_set_updated_at() RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await pool.query(`DROP TRIGGER IF EXISTS videos_updated_at ON videos`)
    await pool.query(`
      CREATE TRIGGER videos_updated_at BEFORE UPDATE ON videos
        FOR EACH ROW EXECUTE FUNCTION videos_set_updated_at()
    `)
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
    await pool.query(`CREATE TABLE IF NOT EXISTS broll_editor_state (
      plan_pipeline_id TEXT PRIMARY KEY,
      state_json       TEXT    NOT NULL DEFAULT '{}',
      version          INTEGER NOT NULL DEFAULT 1,
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )`)
    await pool.query(`CREATE TABLE IF NOT EXISTS exports (
      id               TEXT PRIMARY KEY,
      user_id          TEXT,
      plan_pipeline_id TEXT NOT NULL,
      variant_labels   TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','complete','failed','partial')),
      manifest_json    TEXT NOT NULL,
      result_json      TEXT,
      xml_paths        TEXT,
      folder_path      TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at     TIMESTAMPTZ
    )`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_exports_user_created ON exports(user_id, created_at DESC)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_exports_pipeline ON exports(plan_pipeline_id)`)
    await pool.query(`CREATE TABLE IF NOT EXISTS export_events (
      id           BIGSERIAL PRIMARY KEY,
      export_id    TEXT NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
      user_id      TEXT,
      event        TEXT NOT NULL,
      item_id      TEXT,
      source       TEXT,
      phase        TEXT,
      error_code   TEXT,
      http_status  INTEGER,
      retry_count  INTEGER,
      meta_json    TEXT,
      t            BIGINT NOT NULL,
      received_at  BIGINT NOT NULL
    )`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_export_events_export ON export_events(export_id, t)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_export_events_failures ON export_events(event, received_at) WHERE event IN ('item_failed','rate_limit_hit','session_expired')`)
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

// Retry once on transient TCP/connection blips (ECONNREFUSED, terminated,
// timeout). Supavisor transaction mode handles concurrency natively, so
// this is defense-in-depth against genuine network hiccups — not pool
// saturation. The `max clients` patterns are kept in the regex as a
// safety net in case the DATABASE_URL ever slips back to port 5432.
async function queryWithRetry(sql, params, maxRetries = 1) {
  let lastErr
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await pool.query(sql, params)
    } catch (err) {
      lastErr = err
      const msg = err?.message || ''
      const transient = /max clients|MaxClientsInSessionMode|ECONNREFUSED|Connection terminated|timeout/i.test(msg)
      if (!transient || attempt === maxRetries) throw err
      console.warn(`[db] queryWithRetry transient (${msg}) — retrying in 150ms`)
      await new Promise(r => setTimeout(r, 150))
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

// transaction(fn) — runs `fn(tx)` inside a Postgres BEGIN/COMMIT on a single
// pinned client. `tx` exposes the same `prepare(sql)` shape as the default db
// wrapper, but every query routes through the held client so all writes land
// in the same transaction. Throws → ROLLBACK; returns normally → COMMIT.
// The client is always released back to the pool in `finally`.
async function transaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const tx = {
      prepare(sql) {
        const pgSql = convertSql(sql)
        return {
          async run(...params) {
            const isInsert = /^\s*INSERT\s/i.test(pgSql)
            const execSql = isInsert && !/RETURNING\s/i.test(pgSql) ? pgSql + ' RETURNING id' : pgSql
            const result = await client.query(execSql, params)
            return { lastInsertRowid: result.rows?.[0]?.id ?? null, changes: result.rowCount }
          },
          async get(...params) {
            const result = await client.query(pgSql, params)
            return result.rows[0] || undefined
          },
          async all(...params) {
            const result = await client.query(pgSql, params)
            return result.rows
          },
        }
      },
    }
    const out = await fn(tx)
    await client.query('COMMIT')
    return out
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
}

// No-op save for backward compatibility (PostgreSQL persists automatically)
function save() {}

export default { prepare, exec, save, pool, transaction }
