import Anthropic from '@anthropic-ai/sdk';

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export async function callAnthropic({ model, system, messages, tools, max_tokens = 4096, cache = true }) {
  const c = getClient();
  const params = { model, max_tokens, messages };
  if (system) {
    params.system = cache
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;
  }
  if (tools) params.tools = tools;
  const r = await c.messages.create(params);
  const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const toolUses = r.content.filter((b) => b.type === 'tool_use');
  return {
    text,
    toolUses,
    tokens: { in: r.usage.input_tokens, out: r.usage.output_tokens },
    stop: r.stop_reason,
  };
}
