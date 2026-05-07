import { GoogleGenerativeAI } from '@google/generative-ai';

let client = null;
function getClient() {
  if (!client) {
    // Accept any of the common Google AI key env names — different teams ship the same key under different names.
    const key =
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error(
        'No Gemini API key set (tried GOOGLE_GENERATIVE_AI_API_KEY, GOOGLE_API_KEY, GEMINI_API_KEY)'
      );
    }
    client = new GoogleGenerativeAI(key);
  }
  return client;
}

export async function callGemini({ model, system, messages, tools, thinkingLevel = 'low', max_tokens = 4096 }) {
  const gen = getClient().getGenerativeModel({
    model,
    systemInstruction: system,
    generationConfig: {
      maxOutputTokens: max_tokens,
      temperature: 1.0, // Google warns: do NOT lower for Gemini 3 Flash
      thinkingConfig: { thinkingLevel },
    },
    tools,
  });
  const history = messages.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content,
  }));
  const lastMsg = messages[messages.length - 1];
  const chat = gen.startChat({ history });
  const result = await chat.sendMessage(lastMsg.content);
  const response = result.response;
  return {
    text: response.text(),
    toolUses: response.functionCalls() || [],
    tokens: {
      in: response.usageMetadata?.promptTokenCount || 0,
      out: response.usageMetadata?.candidatesTokenCount || 0,
    },
    stop: response.candidates?.[0]?.finishReason || 'STOP',
  };
}
