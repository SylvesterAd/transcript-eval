import express from 'express'
import cors from 'cors'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import videosRouter from './routes/videos.js'
import strategiesRouter from './routes/strategies.js'
import experimentsRouter from './routes/experiments.js'
import diffsRouter from './routes/diffs.js'
import rankingsRouter from './routes/rankings.js'
import brollRouter, { brollSearchesRouter } from './routes/broll.js'
import storyblocksRouter from './routes/storyblocks.js'
import pexelsRouter from './routes/pexels.js'
import adminRouter from './routes/admin.js'
import gpuRouter from './routes/gpu.js'
import exportsRouter, { sessionTokenRouter, exportEventsRouter, pexelsUrlRouter, freepikUrlRouter } from './routes/exports.js'
import graphicsRouter from './routes/graphics.js'
import graphicsEventsRouter from './routes/graphics-events.js'
import { startWorker as startGraphicsWorker } from './services/graphics/render-worker.js'
import adminExportsRouter from './routes/admin/exports.js'
import adminSupportBundlesRouter from './routes/admin/support-bundles.js'
import adminUsersRouter from './routes/admin/users.js'
import exportXmlRouter from './routes/export-xml.js'
import extConfigRouter from './routes/ext-config.js'
import { attachAuth, hasServerAuthConfig } from './auth.js'
import { initBuckets, isEnabled as storageEnabled } from './services/storage.js'
import { startGpuFailurePoller } from './services/gpu-failure-poller.js'
import { startWorker as startBrollSearchWorker, stopWorker as stopBrollSearchWorker } from './services/broll-search-worker.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection:', reason?.message || reason)
})
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception:', err?.message || err)
})

// CORS: explicit list from CORS_ORIGIN env var (web app origins),
// PLUS any chrome-extension:// origin. The extension's ID differs
// between the Web Store build (key-derived, stable) and Load Unpacked
// builds (manifest key stripped during packaging → Chrome falls back
// to a hash-derived ID that varies per user machine), so listing
// exact extension URLs is fragile. Allowing all chrome-extension://
// origins is safe because every extension API endpoint sits behind
// requireExtAuth (signed JWT) — CORS just controls which origins
// can READ responses; it doesn't grant API access.
const allowedOriginsList = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
  : null
function corsOrigin(origin, cb) {
  // No Origin header (server-to-server, curl, same-origin) → allow.
  if (!origin) return cb(null, true)
  // Any chrome-extension origin — see comment above.
  if (origin.startsWith('chrome-extension://')) return cb(null, true)
  // No env list → reflect any origin (dev mode).
  if (!allowedOriginsList) return cb(null, true)
  // Otherwise, explicit allow-list match.
  if (allowedOriginsList.includes(origin)) return cb(null, true)
  cb(null, false)
}
app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Tus-Resumable', 'Upload-Length', 'Upload-Metadata', 'Upload-Offset'],
  exposedHeaders: ['Location', 'Tus-Resumable', 'Stream-Media-Id', 'Upload-Offset'],
}))
app.use(express.json({ limit: '10mb' }))
app.use(express.text({ limit: '10mb' })) // for sendBeacon (text/plain)
app.use(attachAuth)
// Serve local uploads as fallback when Supabase Storage is disabled
app.use('/uploads', express.static(join(__dirname, '..', 'uploads')))

app.use('/api/videos', videosRouter)
app.use('/api/strategies', strategiesRouter)
app.use('/api/experiments', experimentsRouter)
app.use('/api/diffs', diffsRouter)
app.use('/api/rankings', rankingsRouter)
app.use('/api/broll', brollRouter)
app.use('/api/broll-searches', brollSearchesRouter)
app.use('/api/graphics', graphicsRouter)
app.use('/api/graphics', graphicsEventsRouter)
app.use('/api/storyblocks', storyblocksRouter)
app.use('/api/pexels', pexelsRouter)
app.use('/api/admin', adminRouter)
app.use('/api/admin/exports', adminExportsRouter)
app.use('/api/admin/support-bundles', adminSupportBundlesRouter)
app.use('/api/admin/users', adminUsersRouter)
app.use('/api/gpu', gpuRouter)
app.use('/api/exports', exportsRouter)
app.use('/api/exports', exportXmlRouter)
app.use('/api/session-token', sessionTokenRouter)
app.use('/api/export-events', exportEventsRouter)
app.use('/api/pexels-url', pexelsUrlRouter)
app.use('/api/freepik-url', freepikUrlRouter)
app.use('/api/ext-config', extConfigRouter)

const APP_VERSION = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || process.env.RENDER_GIT_COMMIT?.slice(0, 7) || 'dev'
const DEPLOY_TIME = new Date().toISOString()

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: APP_VERSION, deployed: DEPLOY_TIME, timestamp: new Date().toISOString() })
})

// Global error handler — catches unhandled errors in async route handlers
app.use((err, req, res, _next) => {
  console.error(`[error] ${req.method} ${req.path}:`, err.message || err)
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || 'Internal server error' })
  }
})

app.listen(PORT, async () => {
  console.log(`Transcript Eval API running on http://localhost:${PORT}`)
  console.log(`[auth] ${hasServerAuthConfig ? 'Supabase JWT verification enabled' : 'Supabase JWT verification disabled'}`)
  if (storageEnabled()) {
    await initBuckets()
  }
  startGpuFailurePoller()
  startBrollSearchWorker().catch(err => console.error('[startup] broll-search-worker failed:', err.message))
  startGraphicsWorker().catch(e => console.error('[graphics-worker]', e))
})

let isShuttingDown = false
async function shutdown(signal) {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`[shutdown] received ${signal}, stopping broll-search-worker`)
  try { await stopBrollSearchWorker() } catch (err) { console.warn('[shutdown] worker stop:', err.message) }
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

;(async () => {
  try {
    const { resumeStuckFullAutoChains, resumeInterruptedFullAutoChains, resumeStuckYouTubeDownloads } =
      await import('./services/auto-orchestrator.js')
    await resumeStuckFullAutoChains()
    await resumeStuckYouTubeDownloads()

    // Periodic sweep for chains that go stale mid-runtime (worker dies
    // without writing a failed status — OOM, unhandled rejection on an
    // LLM stream, container restart between heartbeats). The boot-time
    // call above only catches chains stale at startup; a chain that went
    // stale 10 min after a deploy used to sit forever until the next
    // deploy. The HEARTBEAT_TTL_MS (90 s) gate inside
    // resumeInterruptedFullAutoChains is what guarantees we never resume
    // a chain whose worker is still alive — live workers tick the
    // heartbeat every HEARTBEAT_INTERVAL_MS (30 s).
    //
    // Stuck chains (status IS NULL) are intentionally NOT swept here —
    // see auto-orchestrator.js comment.
    //
    // 5 min cadence: comfortably above the heartbeat TTL so a legitimate
    // worker mid-LLM-call isn't flagged, and well below any timescale a
    // user would notice. .unref() so the timer doesn't keep the process
    // alive past SIGTERM during a graceful shutdown.
    const PERIODIC_RESUME_INTERVAL_MS = 5 * 60 * 1000
    setInterval(() => {
      resumeInterruptedFullAutoChains().catch(err =>
        console.error('[periodic-resume] sweep failed:', err.message),
      )
    }, PERIODIC_RESUME_INTERVAL_MS).unref()
  } catch (err) {
    console.error('[startup] resume failed:', err.message)
  }
})()
