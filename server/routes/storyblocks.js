import { Router } from 'express'
import { requireAuth } from '../auth.js'
import {
  isEnabled,
  searchVideos,
  searchAudio,
  searchImages,
  getVideoDownload,
  getAudioDownload,
  getVideoDetails,
  getSimilarVideos,
  getVideoCategories,
} from '../services/storyblocks.js'

const router = Router()

router.get('/status', (req, res) => {
  res.json({ enabled: isEnabled() })
})

router.get('/videos/search', requireAuth, async (req, res) => {
  try {
    const result = await searchVideos({
      keywords: req.query.keywords,
      page: req.query.page ? parseInt(req.query.page) : 1,
      resultsPerPage: req.query.per_page ? parseInt(req.query.per_page) : 20,
      quality: req.query.quality,
      contentType: req.query.content_type,
      minDuration: req.query.min_duration,
      maxDuration: req.query.max_duration,
      orientation: req.query.orientation,
      sortBy: req.query.sort_by,
      userId: req.auth?.userId || 'anonymous',
      projectId: req.query.project_id || 'transcript-eval',
    })
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/audio/search', requireAuth, async (req, res) => {
  try {
    const result = await searchAudio({
      keywords: req.query.keywords,
      page: req.query.page ? parseInt(req.query.page) : 1,
      resultsPerPage: req.query.per_page ? parseInt(req.query.per_page) : 20,
      contentType: req.query.content_type,
      minBpm: req.query.min_bpm,
      maxBpm: req.query.max_bpm,
      hasVocals: req.query.has_vocals,
      userId: req.auth?.userId || 'anonymous',
      projectId: req.query.project_id || 'transcript-eval',
    })
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/images/search', requireAuth, async (req, res) => {
  try {
    const result = await searchImages({
      keywords: req.query.keywords,
      page: req.query.page ? parseInt(req.query.page) : 1,
      resultsPerPage: req.query.per_page ? parseInt(req.query.per_page) : 20,
      contentType: req.query.content_type,
      orientation: req.query.orientation,
      userId: req.auth?.userId || 'anonymous',
      projectId: req.query.project_id || 'transcript-eval',
    })
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/videos/:id/download', requireAuth, async (req, res) => {
  try {
    const result = await getVideoDownload(req.params.id, {
      userId: req.auth?.userId || 'anonymous',
      projectId: req.query.project_id || 'transcript-eval',
    })
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/audio/:id/download', requireAuth, async (req, res) => {
  try {
    const result = await getAudioDownload(req.params.id, {
      userId: req.auth?.userId || 'anonymous',
      projectId: req.query.project_id || 'transcript-eval',
    })
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/videos/:id/details', requireAuth, async (req, res) => {
  try {
    const result = await getVideoDetails(req.params.id)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/videos/:id/similar', requireAuth, async (req, res) => {
  try {
    const result = await getSimilarVideos(req.params.id, req.query.limit ? parseInt(req.query.limit) : 10)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/videos/categories', requireAuth, async (req, res) => {
  try {
    const result = await getVideoCategories()
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

export default router
