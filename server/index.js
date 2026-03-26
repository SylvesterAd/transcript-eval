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

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = 3001

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.text({ limit: '10mb' })) // for sendBeacon (text/plain)
app.use(attachAuth)
app.use('/uploads', express.static(join(__dirname, '..', 'uploads')))

app.use('/api/videos', videosRouter)
app.use('/api/strategies', strategiesRouter)
app.use('/api/experiments', experimentsRouter)
app.use('/api/diffs', diffsRouter)
app.use('/api/rankings', rankingsRouter)

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.listen(PORT, () => {
  console.log(`Transcript Eval API running on http://localhost:${PORT}`)
  console.log(`[auth] ${hasServerAuthConfig ? 'Supabase JWT verification enabled' : 'Supabase JWT verification disabled'}`)
})
