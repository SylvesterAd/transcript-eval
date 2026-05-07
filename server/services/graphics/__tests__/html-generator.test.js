import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/llm/anthropic.js', () => ({
  callAnthropic: vi.fn().mockResolvedValue({
    text: '<!doctype html><html><body><div id="stage" data-composition-id="main" data-start="0" data-duration="5" data-width="1920" data-height="1080"><div class="lt-bar">Hi</div></div><script>window.__timelines={main: {paused:true}}</script></body></html>',
    toolUses: [],
    tokens: { in: 600, out: 400 },
    stop: 'end_turn',
  }),
}))

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test'
})

describe('specToHtml', () => {
  it('returns html + cost + tokens', async () => {
    const { specToHtml } = await import('../html-generator.js')
    const r = await specToHtml({
      spec: { template: 'lower-third', aspectRatio: '16:9', duration: 5, mainText: 'Anna Rivera', subText: 'Journalist', tone: 'neutral' },
    })
    expect(r.html).toContain('<div id="stage"')
    expect(r.html).toContain('data-composition-id="main"')
    expect(r.cost).toBeGreaterThan(0)
    expect(r.tokens).toEqual({ in: 600, out: 400 })
  })

  it('strips markdown fences from response', async () => {
    const { callAnthropic } = await import('../../../lib/llm/anthropic.js')
    callAnthropic.mockResolvedValueOnce({
      text: '```html\n<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080">x</div></body></html>\n```',
      toolUses: [],
      tokens: { in: 100, out: 50 },
      stop: 'end_turn',
    })
    const { specToHtml } = await import('../html-generator.js')
    const r = await specToHtml({ spec: { template: 'lower-third', duration: 5 } })
    expect(r.html).not.toContain('```')
    expect(r.html.startsWith('<!doctype html>')).toBe(true)
  })

  it('passes spec to the LLM via the user message', async () => {
    const { callAnthropic } = await import('../../../lib/llm/anthropic.js')
    callAnthropic.mockClear()
    callAnthropic.mockResolvedValueOnce({
      text: '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080"></div></body></html>',
      toolUses: [],
      tokens: { in: 0, out: 0 },
      stop: 'end_turn',
    })
    const { specToHtml } = await import('../html-generator.js')
    await specToHtml({
      spec: { template: 'lower-third', aspectRatio: '9:16', duration: 6, mainText: 'Test', subText: 'X', tone: 'dramatic' },
    })
    const lastCall = callAnthropic.mock.calls.at(-1)[0]
    expect(lastCall.model).toBe('claude-opus-4-7')
    const userMsg = lastCall.messages[0].content
    expect(userMsg).toContain('"mainText": "Test"')
    expect(userMsg).toContain('"aspectRatio": "9:16"')
  })

  it('throws on response that lacks the Hyperframes root marker', async () => {
    const { callAnthropic } = await import('../../../lib/llm/anthropic.js')
    callAnthropic.mockResolvedValueOnce({
      text: '<html><body>just words, no stage div</body></html>',
      toolUses: [],
      tokens: { in: 0, out: 0 },
      stop: 'end_turn',
    })
    const { specToHtml } = await import('../html-generator.js')
    await expect(
      specToHtml({ spec: { template: 'lower-third', duration: 5 } })
    ).rejects.toThrow(/missing.*data-composition-id="main"/i)
  })
})
