import express from 'express'
import cors from 'cors'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import videosRouter from './routes/videos.js'
import strategiesRouter from './routes/strategies.js'
import experimentsRouter from './routes/experiments.js'
import diffsRouter from './routes/diffs.js'
import rankingsRouter from './routes/rankings.js'
import brollRouter from './routes/broll.js'
import storyblocksRouter from './routes/storyblocks.js'
import pexelsRouter from './routes/pexels.js'
import adminRouter from './routes/admin.js'
import gpuRouter from './routes/gpu.js'
import exportsRouter, { sessionTokenRouter, exportEventsRouter, pexelsUrlRouter, freepikUrlRouter } from './routes/exports.js'
import exportXmlRouter from './routes/export-xml.js'
import { attachAuth, hasServerAuthConfig } from './auth.js'
import { initBuckets, isEnabled as storageEnabled } from './services/storage.js'
import { startGpuFailurePoller } from './services/gpu-failure-poller.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection:', reason?.message || reason)
})
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception:', err?.message || err)
})

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',')
  : undefined
app.use(cors({
  origin: allowedOrigins || true,
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
app.use('/api/storyblocks', storyblocksRouter)
app.use('/api/pexels', pexelsRouter)
app.use('/api/admin', adminRouter)
app.use('/api/gpu', gpuRouter)
app.use('/api/exports', exportsRouter)
app.use('/api/exports', exportXmlRouter)
app.use('/api/session-token', sessionTokenRouter)
app.use('/api/export-events', exportEventsRouter)
app.use('/api/pexels-url', pexelsUrlRouter)
app.use('/api/freepik-url', freepikUrlRouter)

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
})
