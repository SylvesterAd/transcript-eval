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

  it('system prompt includes asset-usage guidance', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/Asset usage/i)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/spec\.assets/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/<img src=/)
    expect(CREATE_HTML_SYSTEM_PROMPT).not.toMatch(/Stay close to this style for now/)
  })

  it('passes assets array to the LLM via the user message', async () => {
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
      spec: {
        template: 'lower-third',
        aspectRatio: '16:9',
        duration: 8,
        mainText: 'Anna Rivera',
        subText: 'Senior journalist',
        tone: 'neutral',
        assets: [
          { role: 'logo', url: 'https://example.com/wsj.svg', alt: 'WSJ logo', source: 'wikimedia.org' },
        ],
      },
    })
    const lastCall = callAnthropic.mock.calls.at(-1)[0]
    const userMsg = lastCall.messages[0].content
    expect(userMsg).toContain('"assets":')
    expect(userMsg).toContain('https://example.com/wsj.svg')
    expect(userMsg).toContain('"role": "logo"')
  })
})

describe('CREATE_HTML_SYSTEM_PROMPT canonical Hyperframes rules', () => {
  it('bans non-deterministic APIs', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/Math\.random/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/Date\.now/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/performance\.now/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/setInterval/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/setTimeout/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/repeat:\s*-1/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/from:\s*['"]random['"]/)
  })

  it('mandates mid-scene activity', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/mid-scene|after.*entrance|keep moving/i)
  })

  it('requires at least 3 different easings per scene', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    // The rule should mention a ≥3 ease requirement (durable across phrasing)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/(?:at least|≥|minimum (?:of )?|no fewer than)\s*(?:3|three)\b[^.]*?eas/i)
    // And the approved-easing list must enumerate ≥3 entries
    const approvedMatch = CREATE_HTML_SYSTEM_PROMPT.match(/Approved:\s*([^\n]+)/)
    expect(approvedMatch).not.toBeNull()
    const eases = approvedMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
    expect(eases.length).toBeGreaterThanOrEqual(3)
  })

  it('lists approved easings', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/power2\.out/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/back\.out/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/expo\.out/)
  })

  it('specifies size floors', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/60px/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/20px/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/16px/)
  })

  it('teaches autoAlpha for non-anchor scene visibility', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/autoAlpha/)
  })
})

describe('few-shot examples comply with canonical rules', () => {
  it('FEW_SHOT_LOWER_THIRD does not use banned APIs', async () => {
    const { FEW_SHOT_LOWER_THIRD, FEW_SHOT_LOWER_THIRD_WITH_LOGO } = await import('../html-generator.js')
    for (const fs of [FEW_SHOT_LOWER_THIRD, FEW_SHOT_LOWER_THIRD_WITH_LOGO]) {
      expect(fs).not.toMatch(/Math\.random\s*\(/)
      expect(fs).not.toMatch(/Date\.now\s*\(/)
      expect(fs).not.toMatch(/performance\.now\s*\(/)
      expect(fs).not.toMatch(/setTimeout\s*\(/)
      expect(fs).not.toMatch(/setInterval\s*\(/)
    }
  })

  it('FEW_SHOT_LOWER_THIRD shows autoAlpha usage', async () => {
    const mod = await import('../html-generator.js')
    expect(mod.CREATE_HTML_SYSTEM_PROMPT).toMatch(/autoAlpha:\s*[01]/)
  })

  it('FEW_SHOT_LOWER_THIRD shows ≥3 unique eases', async () => {
    const mod = await import('../html-generator.js')
    const prompt = mod.CREATE_HTML_SYSTEM_PROMPT
    const eases = new Set()
    const easeRegex = /ease:\s*['"]([a-z0-9.()-]+)['"]/gi
    let m
    while ((m = easeRegex.exec(prompt)) !== null) {
      eases.add(m[1])
    }
    expect(eases.size).toBeGreaterThanOrEqual(3)
  })
})
