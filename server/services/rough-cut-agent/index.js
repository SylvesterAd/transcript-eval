// server/services/rough-cut-agent/index.js
//
// Anthropic tool-use loop. Drives the model through propose_cut/finish until
// stop_reason='end_turn' OR the agent calls 'finish' OR the call cap is hit.

import Anthropic from '@anthropic-ai/sdk'
import { TOOL_SCHEMAS, dispatchTool } from './tools.js'
import { createState } from './state.js'
import { SYSTEM_PROMPT } from './system-prompt.js'

// Chunked workflow uses ~5-7 calls per chunk (get_transcript, clusters,
// 1-2 propose_cut, preview_diff, commit_chunk) plus a final whole-video
// pass. 100 covers ~14 chunks comfortably; the token budget regression
// test (200K in / 50K out) is the hard ceiling on cost.
const MAX_TOOL_CALLS = 100
const DEFAULT_MAX_TOKENS = 4096
// Extended thinking budget per turn. 16K accommodates cross-chunk
// reasoning in the final pass without truncating mid-thought; the model
// rarely uses the full budget (~30-60% in practice). Anthropic API
// requires max_tokens > budget_tokens; we add THINKING_HEADROOM for
// visible output.
const DEFAULT_THINKING_BUDGET = 16000
const THINKING_HEADROOM = 4096

let _client = null
function getClient() {
  if (_client) return _client
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set')
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

/**
 * @param {{
 *   assembledTranscript: string,
 *   wordTimestamps: Array,
 *   model: string,
 *   chaptersFetcher?: Function,
 *   maxTokens?: number,
 *   thinking?: boolean | { budget_tokens: number },
 * }} args
 */
export async function runAgent(args) {
  const {
    assembledTranscript,
    wordTimestamps,
    acousticFeatures = null,
    model,
    chaptersFetcher = null,
    maxTokens = DEFAULT_MAX_TOKENS,
    thinking = false,
  } = args

  // Resolve thinking config. true → default budget; object → custom.
  const thinkingConfig = thinking
    ? {
        type: 'enabled',
        budget_tokens: typeof thinking === 'object' && thinking.budget_tokens
          ? thinking.budget_tokens
          : DEFAULT_THINKING_BUDGET,
      }
    : null

  // When thinking is on, max_tokens must exceed budget_tokens. Otherwise the
  // API rejects the request.
  const effectiveMaxTokens = thinkingConfig
    ? Math.max(maxTokens, thinkingConfig.budget_tokens + THINKING_HEADROOM)
    : maxTokens

  const client = getClient()
  const state = createState({ assembledTranscript, wordTimestamps, acousticFeatures })

  // First user message: pass the transcript so the agent can hold the whole
  // thing in its first prompt (cached). Tool calls below refine.
  // cache_control: 'ephemeral' on the transcript block + system prompt is what
  // the spec §Beta deployment plan step 4 calls "prompt caching".
  const initialUserMessage = [
    { type: 'text', text: 'Transcript follows. Identify cuts using the tools.' },
    { type: 'text', text: assembledTranscript, cache_control: { type: 'ephemeral' } },
  ]
  const messages = [{ role: 'user', content: initialUserMessage }]
  const systemBlocks = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ]

  let totalIn = 0
  let totalOut = 0
  let totalCacheCreate = 0
  let totalCacheRead = 0
  let toolCalls = 0
  let stopReason = 'unknown'
  const toolCallLog = []
  const thinkingLog = []

  while (toolCalls <= MAX_TOOL_CALLS) {
    const apiArgs = {
      model,
      max_tokens: effectiveMaxTokens,
      system: systemBlocks,
      tools: TOOL_SCHEMAS,
      messages,
    }
    if (thinkingConfig) apiArgs.thinking = thinkingConfig
    const resp = await client.messages.create(apiArgs)

    totalIn += resp.usage?.input_tokens || 0
    totalOut += resp.usage?.output_tokens || 0
    totalCacheCreate += resp.usage?.cache_creation_input_tokens || 0
    totalCacheRead += resp.usage?.cache_read_input_tokens || 0

    const toolUses = (resp.content || []).filter(b => b.type === 'tool_use')

    // Capture thinking + visible text from this turn for post-run inspection.
    // The thinking blocks must also be passed back verbatim in subsequent
    // assistant messages — we already do that via `messages.push({role:'assistant', content: resp.content})` below.
    const thinkingBlocks = (resp.content || []).filter(b => b.type === 'thinking' || b.type === 'redacted_thinking')
    const textBlocks    = (resp.content || []).filter(b => b.type === 'text')
    if (thinkingBlocks.length || textBlocks.length || toolUses.length) {
      thinkingLog.push({
        turn: thinkingLog.length + 1,
        thinking: thinkingBlocks.map(b => b.thinking || '[redacted]').join('\n\n'),
        text:     textBlocks.map(b => b.text).join('\n\n'),
        toolNames: toolUses.map(t => t.name),
      })
    }

    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
      stopReason = resp.stop_reason || 'end_turn'
      break
    }

    // Append the assistant turn verbatim so tool_use_id matches in the next user turn.
    messages.push({ role: 'assistant', content: resp.content })

    const toolResults = []
    let finishCalled = false

    for (const tu of toolUses) {
      toolCalls++
      let result
      try {
        result = await dispatchTool(tu.name, tu.input || {}, state, { chaptersFetcher })
      } catch (err) {
        result = { error: String(err.message || err) }
      }
      if (tu.name === 'finish') finishCalled = true
      // Log scope-bearing args concisely so we can see the chunk plan after the fact.
      const scope = tu.input?.scope
      const scopeStr = scope ? `[${scope.start?.toFixed(1)}-${scope.end?.toFixed(1)}]` : ''
      toolCallLog.push(`${tu.name}${scopeStr}`)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      })
      if (toolCalls >= MAX_TOOL_CALLS) break
    }

    messages.push({ role: 'user', content: toolResults })

    if (finishCalled) {
      stopReason = 'finish'
      break
    }
    if (toolCalls >= MAX_TOOL_CALLS) {
      stopReason = 'tool_call_limit'
      break
    }
  }

  return {
    cuts: state.cuts,
    uncertain: state.uncertain,
    stopReason,
    totalTokens: {
      in: totalIn,
      out: totalOut,
      cache_create: totalCacheCreate,
      cache_read: totalCacheRead,
    },
    toolCalls,
    toolCallLog,
    thinkingLog,
    thinkingEnabled: !!thinkingConfig,
  }
}
