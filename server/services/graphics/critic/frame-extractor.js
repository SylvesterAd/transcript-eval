import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const exec = promisify(execFile)

export async function extractFrames({ mp4Path, durationSec, startSec = 0, endSec = null, count = 4, outDir }) {
  if (count < 1) throw new Error('count must be >= 1')
  await mkdir(outDir, { recursive: true })
  const windowEnd = endSec ?? durationSec
  const windowDur = Math.max(0, windowEnd - startSec)
  const paths = []
  for (let i = 0; i < count; i++) {
    // Spread frames across [startSec + 0.1, windowEnd - 0.1] to avoid black first/last frames
    const inset = 0.1
    const t = startSec + inset + (i / Math.max(1, count - 1)) * Math.max(0, windowDur - 2 * inset)
    const out = path.join(outDir, `frame-${i}.png`)
    await exec(
      'ffmpeg',
      ['-y', '-ss', String(t), '-i', mp4Path, '-frames:v', '1', '-q:v', '2', out],
      { timeout: 30000 }
    )
    paths.push(out)
  }
  return paths
}
