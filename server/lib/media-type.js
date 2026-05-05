const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma'])

export function isAudioMimeType(mimetype) {
  if (!mimetype || typeof mimetype !== 'string') return false
  return mimetype.toLowerCase().startsWith('audio/')
}

export function isAudioFilename(filename) {
  if (!filename || typeof filename !== 'string') return false
  const lower = filename.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return AUDIO_EXTENSIONS.has(lower.slice(dot))
}

// Convenience: detect from a multer file object (mimetype OR extension fallback,
// because some browsers send application/octet-stream for unfamiliar formats).
export function isAudioFile(file) {
  if (!file) return false
  return isAudioMimeType(file.mimetype) || isAudioFilename(file.originalname)
}
