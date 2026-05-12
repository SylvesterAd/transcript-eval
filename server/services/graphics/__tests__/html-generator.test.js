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
    // The rule should mention a ≥3 ease requirement (durable across phrasing).
    // Upstream Hyperframes guide uses "Use at least 3 different eases per scene".
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/(?:at least|≥|minimum (?:of )?|no fewer than)\s*(?:3|three)\b[^.]*?eas/i)
    // And the approved-easing vocabulary must enumerate ≥3 distinct ease names
    // (verified separately by the "lists approved easings" test below).
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
    const { FEW_SHOT_LOWER_THIRD, FEW_SHOT_LOWER_THIRD_WITH_LOGO, FEW_SHOT_LOTTIE_LOGO } = await import('../html-generator.js')
    for (const fs of [FEW_SHOT_LOWER_THIRD, FEW_SHOT_LOWER_THIRD_WITH_LOGO, FEW_SHOT_LOTTIE_LOGO]) {
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

describe('refineHtml', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns refined html + cost + tokens preserving stage marker', async () => {
    vi.doMock('../../../lib/llm/anthropic.js', () => ({
      callAnthropic: vi.fn().mockResolvedValue({
        text: '<!doctype html><html><body><div data-composition-id="main" data-start="0" data-duration="5"></div></body></html>',
        toolUses: [],
        tokens: { in: 800, out: 600 },
        stop: 'end_turn',
      }),
    }))

    const { refineHtml } = await import('../html-generator.js')
    const result = await refineHtml({
      html: '<html><body><div data-composition-id="main"></div></body></html>',
      feedback: 'Lower-third bar slides off-screen too fast; extend hold to 4s.',
      spec: { template: 'lower-third', duration: 5 },
    })
    expect(result.html).toMatch(/data-composition-id="main"/)
    expect(result.cost).toBeGreaterThan(0)
    expect(result.tokens.in).toBeGreaterThan(0)
    expect(result.tokens.out).toBeGreaterThan(0)
  })

  it('REFINE_HTML_SYSTEM_PROMPT is exported and mentions edit-bay refinement', async () => {
    const mod = await import('../html-generator.js')
    expect(mod.REFINE_HTML_SYSTEM_PROMPT).toBeDefined()
    expect(mod.REFINE_HTML_SYSTEM_PROMPT).toMatch(/refine|edit.bay/i)
    // Drift detection: refine prompt must inherit determinism rules from CREATE prompt
    expect(mod.REFINE_HTML_SYSTEM_PROMPT).toMatch(/Math\.random/)
    expect(mod.REFINE_HTML_SYSTEM_PROMPT).toMatch(/autoAlpha/)
  })

  it('throws if html is missing', async () => {
    const { refineHtml } = await import('../html-generator.js')
    await expect(refineHtml({ feedback: 'x', spec: {} })).rejects.toThrow(/html/i)
  })

  it('throws if feedback is empty string', async () => {
    const { refineHtml } = await import('../html-generator.js')
    await expect(refineHtml({ html: '<html></html>', feedback: '   ', spec: {} })).rejects.toThrow(/non-empty feedback required/)
  })
})

describe('specToHtml additionalSystemContext', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('passes plain CREATE_HTML_SYSTEM_PROMPT to callAnthropic when context is null', async () => {
    const callMock = vi.fn().mockResolvedValue({
      text: '<!doctype html><html><body><div data-composition-id="main" data-start="0" data-duration="5"></div></body></html>',
      toolUses: [],
      tokens: { in: 100, out: 100 },
      stop: 'end_turn',
    })
    vi.doMock('../../../lib/llm/anthropic.js', () => ({ callAnthropic: callMock }))

    const { specToHtml, CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    await specToHtml({ spec: { template: 'lower-third', duration: 5 } })

    const call = callMock.mock.calls[0][0]
    expect(call.system).toBe(CREATE_HTML_SYSTEM_PROMPT)
    expect(call.system).not.toMatch(/CORRECTIONS REQUESTED/)
  })

  it('appends CORRECTIONS REQUESTED block when additionalSystemContext is provided', async () => {
    const callMock = vi.fn().mockResolvedValue({
      text: '<!doctype html><html><body><div data-composition-id="main" data-start="0" data-duration="5"></div></body></html>',
      toolUses: [],
      tokens: { in: 100, out: 100 },
      stop: 'end_turn',
    })
    vi.doMock('../../../lib/llm/anthropic.js', () => ({ callAnthropic: callMock }))

    const { specToHtml } = await import('../html-generator.js')
    await specToHtml({
      spec: { template: 'lower-third', duration: 5 },
      additionalSystemContext: 'Lint findings:\n- [ERROR] determinism: Math.random() detected',
    })

    const call = callMock.mock.calls[0][0]
    expect(call.system).toMatch(/## CORRECTIONS REQUESTED/)
    expect(call.system).toMatch(/Math\.random\(\) detected/)
  })
})

describe('few-shots use canonical scene-clip pattern', () => {
  it('FEW_SHOT_LOWER_THIRD has composition root + nested scene clip', async () => {
    const { FEW_SHOT_LOWER_THIRD } = await import('../html-generator.js')
    expect(FEW_SHOT_LOWER_THIRD).toMatch(/data-composition-id="main"/)
    expect(FEW_SHOT_LOWER_THIRD).toMatch(/class="scene clip"\s+id="s1"/)
    expect(FEW_SHOT_LOWER_THIRD).toMatch(/data-track-index="0"/)
    expect(FEW_SHOT_LOWER_THIRD).toMatch(/class="scene-content"/)
  })

  it('FEW_SHOT_LOWER_THIRD_WITH_LOGO has composition root + nested scene clip', async () => {
    const { FEW_SHOT_LOWER_THIRD_WITH_LOGO } = await import('../html-generator.js')
    expect(FEW_SHOT_LOWER_THIRD_WITH_LOGO).toMatch(/data-composition-id="main"/)
    expect(FEW_SHOT_LOWER_THIRD_WITH_LOGO).toMatch(/class="scene clip"\s+id="s1"/)
    expect(FEW_SHOT_LOWER_THIRD_WITH_LOGO).toMatch(/data-track-index="0"/)
    expect(FEW_SHOT_LOWER_THIRD_WITH_LOGO).toMatch(/class="scene-content"/)
  })
})

describe('FEW_SHOT_LOTTIE_LOGO', () => {
  it('is exported and uses window.__hfLottie', async () => {
    const mod = await import('../html-generator.js')
    expect(mod.FEW_SHOT_LOTTIE_LOGO).toBeDefined()
    expect(mod.FEW_SHOT_LOTTIE_LOGO).toMatch(/window\.__hfLottie|hfLottie/)
    expect(mod.FEW_SHOT_LOTTIE_LOGO).toMatch(/lottie-web|@hyperframes\/lottie/)
    expect(mod.FEW_SHOT_LOTTIE_LOGO).toMatch(/data-composition-id="main"/)
  })
})

describe('CREATE_HTML_SYSTEM_PROMPT — canonical multi-scene schema', () => {
  it('teaches canonical scene-clip pattern', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/class="scene clip"/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/data-track-index/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/scene-content/)
  })

  it('teaches anchor vs non-anchor scenes', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/anchor scene/i)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/visibility:\s*hidden/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/style="opacity:\s*0;?"/)
  })

  it('teaches HyperShader.init pattern', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/HyperShader\.init/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/scenes\.length === transitions\.length \+ 1/)
  })

  it('lists transition strategy: hard cuts default, shaders sparingly', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/95%|hard cuts/i)
    // Upstream guide says "2 shader transitions at key moments" and "Rule of
    // thumb: a 6-8 scene video wants 2 shader transitions". Accept either.
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/[2-3]\s*shader\s*transitions?/i)
  })
})

describe('CREATE_HTML_SYSTEM_PROMPT — missing canonical rules now present', () => {
  it('bans known web fonts', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/Inter\b/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/Roboto\b/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/Poppins\b/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/Playfair Display/)
  })

  it('bans known font pairings', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/Fraunces.*JetBrains/)
  })

  it('teaches mid-scene pattern catalog', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    const patterns = ['counter', 'breathing', 'glow', 'stagger', 'Ken Burns', 'highlight sweep', 'orbit']
    const hits = patterns.filter((p) => new RegExp(p, 'i').test(CREATE_HTML_SYSTEM_PROMPT))
    expect(hits.length).toBeGreaterThanOrEqual(5)
  })

  it('maps eases to feelings with durations', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    const feelings = ['Smooth', 'Snappy', 'Bouncy', 'Dramatic', 'Dreamy', 'Mechanical']
    const hits = feelings.filter((f) => new RegExp(`\\b${f}\\b`, 'i').test(CREATE_HTML_SYSTEM_PROMPT))
    expect(hits.length).toBeGreaterThanOrEqual(5)
  })

  it('requires tabular-nums on number columns', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/tabular-nums/)
  })

  it('includes a self-review checklist', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/self-review|before output|verify/i)
  })

  it('preserves Phase 4 rules (determinism, autoAlpha, ≥3 eases)', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/Math\.random/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/autoAlpha/)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/at least 3/)
  })
})

describe('FEW_SHOT_MULTI_SCENE_WITH_SHADER', () => {
  it('is exported and used inside CREATE_HTML_SYSTEM_PROMPT', async () => {
    const mod = await import('../html-generator.js')
    expect(mod.FEW_SHOT_MULTI_SCENE_WITH_SHADER).toBeDefined()
    expect(mod.CREATE_HTML_SYSTEM_PROMPT).toContain(mod.FEW_SHOT_MULTI_SCENE_WITH_SHADER)
  })

  it('has composition root with 3 scenes', async () => {
    const { FEW_SHOT_MULTI_SCENE_WITH_SHADER: f } = await import('../html-generator.js')
    expect(f).toMatch(/data-composition-id="main"/)
    expect(f).toMatch(/id="s1"/)
    expect(f).toMatch(/id="s2"/)
    expect(f).toMatch(/id="s3"/)
  })

  it('uses HyperShader.init with one transition', async () => {
    const { FEW_SHOT_MULTI_SCENE_WITH_SHADER: f } = await import('../html-generator.js')
    expect(f).toMatch(/HyperShader\.init/)
    expect(f).toMatch(/transitions:\s*\[/)
  })

  it('uses anchor + non-anchor visibility patterns', async () => {
    const { FEW_SHOT_MULTI_SCENE_WITH_SHADER: f } = await import('../html-generator.js')
    expect(f).toMatch(/style="opacity:\s*0;?"/)
    expect(f).toMatch(/style="visibility:\s*hidden;?"/)
    expect(f).toMatch(/autoAlpha:\s*1/)
    expect(f).toMatch(/opacity:\s*1/)
  })
})

describe('REFINE_HTML_SYSTEM_PROMPT — scene-scoped editing', () => {
  it('explicitly teaches scene-scoped refinement', async () => {
    const { REFINE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(REFINE_HTML_SYSTEM_PROMPT).toMatch(/scene[- ]scoped|scene N|scene-by-scene/i)
    expect(REFINE_HTML_SYSTEM_PROMPT).toMatch(/Scene 1:|Scene N:/)
  })

  it('still inherits CREATE_HTML_SYSTEM_PROMPT under ORIGINAL CONSTRAINTS', async () => {
    const { REFINE_HTML_SYSTEM_PROMPT, CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(REFINE_HTML_SYSTEM_PROMPT).toContain(CREATE_HTML_SYSTEM_PROMPT)
    expect(REFINE_HTML_SYSTEM_PROMPT).toMatch(/ORIGINAL CONSTRAINTS/i)
  })

  it('teaches composition root duration recalculation on scene duration change', async () => {
    const { REFINE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(REFINE_HTML_SYSTEM_PROMPT).toMatch(/recalculate.*composition.*data-duration|composition root.*data-duration|sum of all scene durations/i)
  })
})

describe('CREATE_HTML_SYSTEM_PROMPT — vendored Hyperframes guide integration', () => {
  it('embeds the upstream guide verbatim and exposes the pinned SHA', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    const { HYPERFRAMES_CLAUDE_DESIGN_GUIDE, HYPERFRAMES_GUIDE_SHA } = await import(
      '../prompts/hyperframes-claude-design.js'
    )
    // SHA is exposed (40-char git hash) so we can audit drift
    expect(HYPERFRAMES_GUIDE_SHA).toMatch(/^[0-9a-f]{40}$/)
    // The guide is non-trivial in size
    expect(HYPERFRAMES_CLAUDE_DESIGN_GUIDE.length).toBeGreaterThan(10_000)
    // And it's spliced into the system prompt body
    expect(CREATE_HTML_SYSTEM_PROMPT).toContain(HYPERFRAMES_CLAUDE_DESIGN_GUIDE)
  })

  it('inherits the upstream self-review checklist (which catches the missing-timeline lint error)', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/window\.__timelines\[["']main["']\]\s*=\s*tl/)
  })

  it('inherits the upstream media rules (no base64, no placeholder URLs, no SVG data: grain)', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/base64 media/i)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/placeholder URLs|placehold\.co/i)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/data:image\/svg\+xml/i)
  })

  it('teaches the map-scene pattern (img background + overlay arrows/hotspots)', async () => {
    const { CREATE_HTML_SYSTEM_PROMPT } = await import('../html-generator.js')
    // Map template handling is pipeline-specific (the upstream guide doesn't
    // cover maps), so we anchor the test on our own preamble copy.
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/map[\s\S]{0,200}img/i)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/arrows.*hotspots|hotspots.*arrows|frontline/i)
    expect(CREATE_HTML_SYSTEM_PROMPT).toMatch(/never paste a giant base-map SVG|never base64/i)
  })
})
