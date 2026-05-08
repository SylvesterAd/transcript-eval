import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../events/emitter.js', () => ({ emit: vi.fn() }));

// Correction #1: paths use 3-up traversal (__tests__ → graphics → services → server)
vi.mock('../../../lib/llm/gemini.js', () => ({
  callGemini: vi.fn().mockResolvedValue({
    text: 'What aspect ratio?\n[SPEC]{"template":"lower-third"}',
    toolUses: [],
    tokens: { in: 500, out: 50 },
    stop: 'STOP',
  }),
}));
vi.mock('../../../lib/llm/anthropic.js', () => ({
  callAnthropic: vi.fn(),
}));
// Correction #2: db.js default export — mock with { default: { prepare, transaction } }
// SQL-aware dispatch lets iterating-mode tests stub specific queries.
const dbState = {
  loadSessionResult: { id: 1, spec_json: {}, status: 'briefing' },
  loadHistoryResult: [],
  parentResult: null,            // graphics_renders parent lookup
  iterationCountResult: { c: 0 }, // SELECT COUNT(*)
  insertedRenderId: 7,
  txCalls: [],                    // capture INSERT/UPDATE SQLs run inside transactions
};

vi.mock('../../../db.js', () => {
  const makePrepare = (capture) => vi.fn((sql) => {
    return {
      run: vi.fn().mockImplementation((...args) => {
        capture.push({ sql, args })
        return { lastInsertRowid: 1, changes: 1 }
      }),
      get: vi.fn().mockImplementation((...args) => {
        capture.push({ sql, args })
        if (/FROM graphics_sessions WHERE id/i.test(sql)) return dbState.loadSessionResult
        if (/FROM graphics_messages/i.test(sql))         return undefined
        if (/COUNT\(\*\).*graphics_renders/i.test(sql))  return dbState.iterationCountResult
        if (/FROM graphics_renders\s+WHERE session_id/i.test(sql) && /status\s*=\s*'complete'/i.test(sql)) return dbState.parentResult
        if (/INSERT INTO graphics_renders/i.test(sql))   return { id: dbState.insertedRenderId }
        return { id: 1, spec_json: {}, status: 'briefing' }
      }),
      all: vi.fn().mockImplementation((...args) => {
        capture.push({ sql, args })
        if (/FROM graphics_messages/i.test(sql)) return dbState.loadHistoryResult
        return []
      }),
    }
  });
  // outer prepare uses non-tx capture (we mainly inspect tx via dbState.txCalls)
  const outerCapture = []
  const txCapture = dbState.txCalls
  return {
    default: {
      prepare: makePrepare(outerCapture),
      transaction: vi.fn(async (fn) => fn({ prepare: makePrepare(txCapture) })),
    },
  };
});

beforeEach(() => {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-test'
  // Reset dbState defaults each test
  dbState.loadSessionResult  = { id: 1, spec_json: {}, status: 'briefing' }
  dbState.loadHistoryResult  = []
  dbState.parentResult       = null
  dbState.iterationCountResult = { c: 0 }
  dbState.txCalls.length = 0
})

describe('orchestrator', () => {
  it('extracts [SPEC] block from assistant reply and merges into session', async () => {
    const { runChatTurn } = await import('../orchestrator.js');
    const result = await runChatTurn({ sessionId: 1, userMessage: 'I want a lower-third' });
    expect(result.assistantText).toContain('What aspect ratio?');
    expect(result.assistantText).not.toContain('[SPEC]');  // strip check
    expect(result.specUpdate).toEqual({ template: 'lower-third' });
  });

  it('passes Google Search grounding tools on the brief callGemini call', async () => {
    const { callGemini } = await import('../../../lib/llm/gemini.js')
    callGemini.mockClear()
    callGemini.mockResolvedValue({
      text: '[SPEC]{"template":"lower-third"}',
      toolUses: [],
      tokens: { in: 100, out: 10 },
      stop: 'STOP',
    })
    const { runChatTurn } = await import('../orchestrator.js')
    await runChatTurn({ sessionId: 1, userMessage: 'use the WSJ logo' })
    const lastCall = callGemini.mock.calls.at(-1)[0]
    expect(lastCall.tools).toEqual([{ googleSearch: {} }])
    expect(lastCall.model).toBe('gemini-3-flash-preview')
  })
});

describe('BRIEF_SYSTEM_PROMPT documents available adapters', () => {
  it('lists gsap, lottie, three, animejs, waapi, css-animations as adapter options', async () => {
    const { BRIEF_SYSTEM_PROMPT } = await import('../brief-prompt.js')
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/gsap/i)
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/lottie/i)
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/three/i)
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/animejs|anime\.js/i)
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/waapi|web animations/i)
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/css-animations|css animation/i)
  })
})

describe('BRIEF_SYSTEM_PROMPT teaches single-HTML multi-scene', () => {
  it('describes scenes as nested in one composition (not separate renders)', async () => {
    const { BRIEF_SYSTEM_PROMPT } = await import('../brief-prompt.js')
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/single (?:HTML|composition)|one composition|nested/i)
  })

  it('mentions HyperShader transitions are LLM-decided, sparingly', async () => {
    const { BRIEF_SYSTEM_PROMPT } = await import('../brief-prompt.js')
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/shader transition|HyperShader/i)
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/sparingly|2.{0,5}3 |hard cuts|95%/i)
  })
})

describe('orchestrator — iterating mode', () => {
  it('bypasses brief LLM and enqueues a refine render off the latest complete parent', async () => {
    dbState.loadSessionResult = { id: 1, spec_json: { template: 'lower-third' }, status: 'iterating' }
    dbState.parentResult = {
      id: 7, iteration: 1, template: 'lower-third',
      spec_snapshot_json: { template: 'lower-third', mainText: 'A', subText: 'B', aspectRatio: '16:9', duration: 5, tone: 'neutral' },
      final_html_text: '<!doctype html><div data-composition-id="main">PARENT</div>',
    }
    dbState.iterationCountResult = { c: 1 }
    dbState.insertedRenderId = 8

    const { callGemini } = await import('../../../lib/llm/gemini.js')
    callGemini.mockClear()

    const { runChatTurn } = await import('../orchestrator.js')
    const result = await runChatTurn({ sessionId: 1, userMessage: 'make it bigger' })

    // Brief LLM was NOT called
    expect(callGemini).not.toHaveBeenCalled()
    // A new render row was inserted with parent_render_id + human_feedback set
    const insertRender = dbState.txCalls.find(
      (c) => /INSERT INTO graphics_renders/i.test(c.sql)
    )
    expect(insertRender).toBeDefined()
    expect(insertRender.sql).toMatch(/parent_render_id/i)
    expect(insertRender.sql).toMatch(/human_feedback/i)
    // I-1: Position-aware args checks (was: .toContain, value-only)
    const argsArr = insertRender.args
    expect(argsArr[0]).toBe(1)                      // sessionId
    expect(argsArr[1]).toBe(2)                      // iteration = parent.iteration + 1
    expect(typeof argsArr[2]).toBe('string')        // spec_snapshot_json (stringified)
    expect(JSON.parse(argsArr[2]).template).toBe('lower-third')  // confirms it's the parent's spec
    expect(argsArr[3]).toBe('lower-third')          // template (copied from parent.template)
    expect(argsArr[4]).toBe(7)                      // parent_render_id (from parent.id)
    expect(argsArr[5]).toBe('make it bigger')       // human_feedback (from userMessage)
    // Session flips to 'rendering'
    const sessionUpdate = dbState.txCalls.find(
      (c) => /UPDATE graphics_sessions/i.test(c.sql) && /status\s*=\s*'rendering'/i.test(c.sql)
    )
    expect(sessionUpdate).toBeDefined()
    // Returned shape
    expect(result.assistantText).toBe('Refining…')
    expect(result.renderId).toBe(8)
    // I-2: Atomicity — user msg + ack msg + render insert + session update all inside the transaction
    const messageInserts = dbState.txCalls.filter((c) => /INSERT INTO graphics_messages/i.test(c.sql))
    expect(messageInserts).toHaveLength(2)
    // First message insert: the user's message
    expect(messageInserts[0].args).toContain(1)              // sessionId
    expect(messageInserts[0].args).toContain('user')         // role
    expect(messageInserts[0].args).toContain('make it bigger') // content
    // Second message insert: the assistant ack
    expect(messageInserts[1].args).toContain(1)              // sessionId
    expect(messageInserts[1].args).toContain('assistant')    // role
    expect(messageInserts[1].args).toContain('Refining…')    // content
  })
})
