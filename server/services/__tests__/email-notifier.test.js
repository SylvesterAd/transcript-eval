import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSend = vi.fn().mockResolvedValue({ id: 'mock-email-id' })

vi.mock('resend', () => ({
  Resend: vi.fn(() => ({ emails: { send: mockSend } })),
}))

const state = { group: null, user: null, recentNotified: false }

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(...args) {
          if (/SELECT notified_at FROM video_groups WHERE id = \? AND notified_at > NOW\(\)/.test(sql)) {
            return state.recentNotified ? { notified_at: new Date() } : null
          }
          if (/SELECT id, name FROM video_groups WHERE id = \?/.test(sql)) return state.group
          if (/SELECT email FROM auth\.users WHERE id = \?/.test(sql)) return state.user
          throw new Error(`unexpected get: ${sql}`)
        },
        async run(...args) {
          if (/UPDATE video_groups SET notified_at = NOW\(\)/.test(sql)) return { changes: 1 }
          throw new Error(`unexpected run: ${sql}`)
        },
      }
    },
  },
}))

beforeEach(() => {
  process.env.RESEND_API_KEY = 'test_key'
  state.group = { id: 1, name: 'Project X' }
  state.user = { email: 'user@example.com' }
  state.recentNotified = false
  mockSend.mockClear()
})

describe('email-notifier', () => {
  it('noops when RESEND_API_KEY is empty', async () => {
    delete process.env.RESEND_API_KEY
    const mod = await import('../email-notifier.js?nokey=' + Date.now())
    await mod.send('done', { subGroupId: 1, userId: 'u1' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('sends with correct from/subject for done template', async () => {
    const { send } = await import('../email-notifier.js?key=' + Date.now())
    await send('done', { subGroupId: 1, userId: 'u1' })
    expect(mockSend).toHaveBeenCalledOnce()
    const call = mockSend.mock.calls[0][0]
    expect(call.from).toMatch(/Adpunk/)
    expect(call.to).toBe('user@example.com')
    expect(call.subject).toMatch(/Project X.*ready/)
    expect(call.html).toContain('href=')
  })

  it('skips dispatch within 5-minute dedup window', async () => {
    state.recentNotified = true
    const { send } = await import('../email-notifier.js?dedup=' + Date.now())
    await send('done', { subGroupId: 1, userId: 'u1' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('sends paused_at_strategy template with correct subject', async () => {
    const { send } = await import('../email-notifier.js?strat=' + Date.now())
    await send('paused_at_strategy', { subGroupId: 1, userId: 'u1' })
    const call = mockSend.mock.calls[0][0]
    expect(call.subject).toMatch(/Pick.*strategy/)
  })

  it('logs errors but never throws', async () => {
    mockSend.mockRejectedValueOnce(new Error('Resend down'))
    const { send } = await import('../email-notifier.js?err=' + Date.now())
    await expect(send('done', { subGroupId: 1, userId: 'u1' })).resolves.not.toThrow()
  })
})
