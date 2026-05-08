// server/services/graphics/scene-concat.js
//
// ffmpeg concat-demuxer helper. Concatenates N scene MP4s into one file
// without re-encoding (`-c copy`). Requires inputs to share codec/format,
// which Hyperframes' default H.264/AAC output guarantees.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const exec = promisify(execFile)

export async function concatScenes({ sceneMp4Paths, outputPath }) {
  if (!sceneMp4Paths || sceneMp4Paths.length === 0) {
    throw new Error('concatScenes: needs at least one scene mp4')
  }
  const outputDir = path.dirname(outputPath)
  await mkdir(outputDir, { recursive: true })
  const manifestPath = path.join(outputDir, 'concat-manifest.txt')
  const manifest = sceneMp4Paths.map((p) => `file '${p}'`).join('\n') + '\n'
  await writeFile(manifestPath, manifest, 'utf8')
  const start = Date.now()
  await exec(
    'ffmpeg',
    ['-y', '-f', 'concat', '-safe', '0', '-i', manifestPath, '-c', 'copy', outputPath],
    { timeout: 5 * 60 * 1000 }
  )
  return { durationMs: Date.now() - start, outputPath }
}
