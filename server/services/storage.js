import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, copyFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMP_DIR = join(__dirname, '..', '..', 'uploads', 'temp')
mkdirSync(TEMP_DIR, { recursive: true })

// ── Supabase client (server-side with secret key) ──────────────────────
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SECRET_KEY

let supabase = null
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey)
  console.log('[storage] Supabase Storage enabled')
} else {
  console.log('[storage] Supabase Storage disabled (missing SUPABASE_URL or SUPABASE_SECRET_KEY)')
}

const BUCKETS = ['videos', 'thumbnails', 'frames']

// ── Initialize buckets ─────────────────────────────────────────────────
export async function initBuckets() {
  if (!supabase) return
  for (const name of BUCKETS) {
    const { error } = await supabase.storage.createBucket(name, {
      public: true,
    })
    if (error && !error.message.includes('already exists')) {
      console.error(`[storage] Error creating bucket "${name}":`, error.message)
    }
  }
  console.log('[storage] Buckets ready')
}

// ── Upload file to Supabase Storage ────────────────────────────────────
export async function uploadFile(bucket, storagePath, localFilePath) {
  if (!supabase) {
    // Fallback: copy file to local uploads dir for dev without Supabase
    const destDir = join(__dirname, '..', '..', 'uploads', bucket)
    mkdirSync(destDir, { recursive: true })
    const destPath = join(destDir, storagePath)
    // Only copy if source and dest differ (file may already be in the right place)
    if (localFilePath !== destPath) {
      try { copyFileSync(localFilePath, destPath) } catch {}
    }
    return `/uploads/${bucket}/${storagePath}`
  }

  const buffer = readFileSync(localFilePath)
  const contentType = guessContentType(storagePath)

  const { error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType,
      upsert: true,
    })

  if (error) throw new Error(`Upload failed (${bucket}/${storagePath}): ${error.message}`)

  return getPublicUrl(bucket, storagePath)
}

// ── Upload buffer directly ─────────────────────────────────────────────
export async function uploadBuffer(bucket, storagePath, buffer, contentType) {
  if (!supabase) {
    return `/uploads/${bucket}/${storagePath}`
  }

  const { error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType: contentType || guessContentType(storagePath),
      upsert: true,
    })

  if (error) throw new Error(`Upload failed (${bucket}/${storagePath}): ${error.message}`)

  return getPublicUrl(bucket, storagePath)
}

// ── Get public URL ─────────────────────────────────────────────────────
export function getPublicUrl(bucket, storagePath) {
  if (!supabase) return `/uploads/${bucket}/${storagePath}`
  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath)
  return data.publicUrl
}

// ── Delete file ────────────────────────────────────────────────────────
export async function deleteFile(bucket, storagePath) {
  if (!supabase) return
  const { error } = await supabase.storage.from(bucket).remove([storagePath])
  if (error) console.error(`[storage] Delete failed (${bucket}/${storagePath}):`, error.message)
}

// ── Delete folder (all files under prefix) ─────────────────────────────
export async function deleteFolder(bucket, prefix) {
  if (!supabase) return

  // List all files under prefix
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 10000 })
  if (error || !data?.length) return

  const paths = data.map(f => `${prefix}/${f.name}`)
  const { error: delError } = await supabase.storage.from(bucket).remove(paths)
  if (delError) console.error(`[storage] Folder delete failed (${bucket}/${prefix}):`, delError.message)
}

// ── Delete by full URL (extract bucket + path from URL) ────────────────
export async function deleteByUrl(url) {
  if (!supabase || !url) return
  // URL format: https://{project}.supabase.co/storage/v1/object/public/{bucket}/{path}
  const match = url.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)/)
  if (!match) return
  await deleteFile(match[1], match[2])
}

// ── Download file from URL to temp ─────────────────────────────────────
export async function downloadToTemp(url, filename) {
  if (!url) throw new Error('No URL provided')

  // If it's already a local path, return it
  if (url.startsWith('/uploads/') || url.startsWith('uploads/')) {
    const localPath = join(__dirname, '..', '..', url.startsWith('/') ? url.slice(1) : url)
    return localPath
  }

  const tempPath = join(TEMP_DIR, filename || `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`)

  // Reuse existing temp file if it exists and has content
  try {
    const { statSync } = await import('fs')
    const stat = statSync(tempPath)
    if (stat.size > 0) return tempPath
  } catch {}

  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)

  // Stream to disk using pipeline (handles backpressure correctly)
  const { Readable } = await import('stream')
  const { pipeline } = await import('stream/promises')
  const { createWriteStream: cws } = await import('fs')
  const nodeStream = Readable.fromWeb(response.body)
  await pipeline(nodeStream, cws(tempPath))
  return tempPath
}

// ── Upload all frames from a local directory ───────────────────────────
export async function uploadFrames(videoId, localFramesDir) {
  if (!supabase) return

  const files = readdirSync(localFramesDir).filter(f => f.endsWith('.jpg')).sort((a, b) => {
    return parseInt(a) - parseInt(b)
  })

  for (const file of files) {
    const localPath = join(localFramesDir, file)
    const storagePath = `${videoId}/${file}`
    await uploadFile('frames', storagePath, localPath)
  }

  return files.length
}

// ── Check if storage is enabled ────────────────────────────────────────
export function isEnabled() {
  return Boolean(supabase)
}

// ── Temp dir path ──────────────────────────────────────────────────────
export { TEMP_DIR }

// ── Helpers ────────────────────────────────────────────────────────────
function guessContentType(path) {
  if (path.endsWith('.mp4')) return 'video/mp4'
  if (path.endsWith('.mp3')) return 'audio/mpeg'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.webm')) return 'video/webm'
  if (path.endsWith('.wav')) return 'audio/wav'
  if (path.endsWith('.txt')) return 'text/plain'
  return 'application/octet-stream'
}
