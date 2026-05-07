import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual('node:fs/promises')
  return { ...real, readFile: vi.fn().mockResolvedValue(Buffer.from('fake png')) }
})
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ error: null }),
        createSignedUrl: vi.fn().mockResolvedValue({
          data: { signedUrl: 'https://supabase.example/frame.png' },
          error: null,
        }),
      })),
    },
  })),
}))

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb-test'
})

describe('uploadFrames', () => {
  it('uploads each frame and returns array of signed URLs', async () => {
    const { uploadFrames } = await import('../uploader.js')
    const urls = await uploadFrames({
      renderId: 7,
      iterationIndex: 1,
      framePaths: ['/tmp/f0.png', '/tmp/f1.png'],
    })
    expect(urls).toHaveLength(2)
    expect(urls[0]).toMatch(/^https:/)
  })
})
