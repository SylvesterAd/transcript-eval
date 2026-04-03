import express from 'express'
import cors from 'cors'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import videosRouter from './routes/videos.js'
import strategiesRouter from './routes/strategies.js'
import experimentsRouter from './routes/experiments.js'
import diffsRouter from './routes/diffs.js'
import rankingsRouter from './routes/rankings.js'
import { attachAuth, hasServerAuthConfig } from './auth.js'
import { initBuckets, isEnabled as storageEnabled } from './services/storage.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',')
  : undefined
app.use(cors({
  origin: allowedOrigins || true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
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
})
