import { describe, it, expect, vi } from 'vitest'

// Mock fetch globally so no real ElevenLabs call is made
global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({
    text: 'hello world',
    words: [
      { type: 'word', text: 'hello', start: 0.0, end: 0.5 },
      { type: 'word', text: 'world', start: 0.6, end: 1.0 },
    ],
  }),
  text: async () => '',
})

import { transcribeVideo } from '../whisper.js'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('transcribeVideo with audio input', () => {
  it('returns words for a small mp3 input without crashing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wht-'))
    const path = join(dir, 'tiny.mp3')
    // Tiny file — 49MB threshold not crossed, so no ffmpeg extract.
    writeFileSync(path, Buffer.alloc(1024, 0))
    try {
      const result = await transcribeVideo(path)
      expect(result.words).toHaveLength(2)
      expect(result.words[0].word).toBe('hello')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
