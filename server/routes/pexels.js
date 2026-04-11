import { Router } from 'express'
import { requireAuth } from '../auth.js'
import { isEnabled, searchVideos, searchPhotos, getVideo, getPhoto, popularVideos, curatedPhotos } from '../services/pexels.js'

const router = Router()

router.get('/status', (req, res) => {
  res.json({ enabled: isEnabled() })
})

router.get('/videos/search', requireAuth, async (req, res) => {
  try {
    const result = await searchVideos({
      query: req.query.query || req.query.keywords,
      page: req.query.page ? parseInt(req.query.page) : 1,
      perPage: req.query.per_page ? parseInt(req.query.per_page) : 15,
      orientation: req.query.orientation,
      size: req.query.size,
      locale: req.query.locale,
    })
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/photos/search', requireAuth, async (req, res) => {
  try {
    const result = await searchPhotos({
      query: req.query.query || req.query.keywords,
      page: req.query.page ? parseInt(req.query.page) : 1,
      perPage: req.query.per_page ? parseInt(req.query.per_page) : 15,
      orientation: req.query.orientation,
      size: req.query.size,
      color: req.query.color,
      locale: req.query.locale,
    })
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/videos/:id', requireAuth, async (req, res) => {
  try {
    res.json(await getVideo(req.params.id))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/photos/:id', requireAuth, async (req, res) => {
  try {
    res.json(await getPhoto(req.params.id))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/videos/popular', requireAuth, async (req, res) => {
  try {
    const result = await popularVideos({
      page: req.query.page ? parseInt(req.query.page) : 1,
      perPage: req.query.per_page ? parseInt(req.query.per_page) : 15,
      minDuration: req.query.min_duration,
      maxDuration: req.query.max_duration,
    })
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/photos/curated', requireAuth, async (req, res) => {
  try {
    res.json(await curatedPhotos({
      page: req.query.page ? parseInt(req.query.page) : 1,
      perPage: req.query.per_page ? parseInt(req.query.per_page) : 15,
    }))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

export default router
