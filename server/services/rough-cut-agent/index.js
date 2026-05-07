// server/services/rough-cut-agent/index.js
//
// Anthropic tool-use loop. Drives the model through propose_cut/finish until
// stop_reason='end_turn' OR the agent calls 'finish' OR the 60-call cap is hit.

import Anthropic from '@anthropic-ai/sdk'
import { TOOL_SCHEMAS, dispatchTool } from './tools.js'
import { createState } from './state.js'
import { SYSTEM_PROMPT } from './system-prompt.js'

const MAX_TOOL_CALLS = 60
const DEFAULT_MAX_TOKENS = 4096

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
 * }} args
 * @returns {Promise<{
 *   cuts: Array, uncertain: Array, stopReason: string,
 *   totalTokens: {in: number, out: number}, toolCalls: number,
 * }>}
 */
export async function runAgent(args) {
  const {
    assembledTranscript,
    wordTimestamps,
    model,
    chaptersFetcher = null,
    maxTokens = DEFAULT_MAX_TOKENS,
  } = args

  const client = getClient()
  const state = createState({ assembledTranscript, wordTimestamps })

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
  let toolCalls = 0
  let stopReason = 'unknown'

  while (toolCalls <= MAX_TOOL_CALLS) {
    const resp = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemBlocks,
      tools: TOOL_SCHEMAS,
      messages,
    })

    totalIn += resp.usage?.input_tokens || 0
    totalOut += resp.usage?.output_tokens || 0

    const toolUses = (resp.content || []).filter(b => b.type === 'tool_use')

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
    totalTokens: { in: totalIn, out: totalOut },
    toolCalls,
  }
}
