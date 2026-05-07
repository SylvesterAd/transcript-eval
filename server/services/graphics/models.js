// Model-routing per pipeline step. Add new steps here and update tests in
// __tests__/models.test.js.

export const MODEL_FOR = {
  brief: 'gemini-3-flash-preview',
  classify: 'gemini-3-flash-preview',
  asset: 'gemini-3-flash-preview',
  create: 'claude-opus-4-7',
  review: 'claude-opus-4-7',
  edit_minor: 'gemini-3-flash-preview',
  edit_major: 'claude-opus-4-7',
  reply: 'gemini-3-flash-preview',
};

// $/M tokens — kept in cents per million for integer math.
const PRICING = {
  'claude-opus-4-7':         { in: 1500, out: 7500 },
  'claude-sonnet-4-6':       { in: 300,  out: 1500 },
  'claude-haiku-4-5-20251001': { in: 80, out: 400 },
  'gemini-3-flash-preview':  { in: 50,   out: 300 },
};

export function costCents(model, tokens) {
  const p = PRICING[model];
  if (!p) throw new Error(`unknown model for pricing: ${model}`);
  const inCost  = (tokens.in  / 1_000_000) * p.in;
  const outCost = (tokens.out / 1_000_000) * p.out;
  return Math.ceil(inCost + outCost);
}
