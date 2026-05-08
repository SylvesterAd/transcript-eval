import Anthropic from '@anthropic-ai/sdk';

let client = null;
function getClient() {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (!apiKey) {
      throw new Error('No Anthropic API key set (tried ANTHROPIC_API_KEY, CLAUDE_API_KEY)');
    }
    client = new Anthropic({ apiKey });
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
