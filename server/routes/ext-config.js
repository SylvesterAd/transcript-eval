import { Router } from 'express'
import { getExtConfig } from '../services/ext-config.js'

const router = Router()

// GET /api/ext-config
//
// Public endpoint — no auth. The Chrome extension hits this at
// service-worker startup AND before each export, BEFORE its JWT mint
// flow runs. There is no Authorization header to validate.
//
// Response is a snapshot of the EXT_* env vars (with defaults applied
// for unset vars). Cache-Control: public, max-age=60 gives operators
// a ~60s propagation window on flag flips and protects us from SW
// hot-loops if the extension ever ends up calling this in a tight
// loop.
//
// Falls open: if anything throws here (it shouldn't — getExtConfig is
// synchronous and only validates at module load), the global error
// handler in server/index.js returns 500 and the extension falls back
// to its baked-in defaults (which match this module's DEFAULTS).
router.get('/', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60')
  res.json(getExtConfig())
})

export default router
