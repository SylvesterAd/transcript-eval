// server/services/graphics/session-state.js
//
// The brief agent updates this spec turn-by-turn. Once isSpecComplete returns
// true, the orchestrator transitions session.status from 'briefing' to 'rendering'.

export const REQUIRED_FIELDS = [
  'template',       // 'lower-third' (only one in MVP)
  'aspectRatio',    // '16:9' | '9:16' | '1:1'
  'duration',       // seconds, integer
  'mainText',       // headline string
  'subText',        // sub-headline string (can be empty string but must be set)
  'tone',           // 'analytical' | 'dramatic' | 'neutral' | 'playful'
];

export function mergeSpec(current = {}, update = {}) {
  const out = { ...current };
  for (const [k, v] of Object.entries(update)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

export function isSpecComplete(spec) {
  return REQUIRED_FIELDS.every((f) => spec[f] !== undefined && spec[f] !== null);
}

export function missingFields(spec) {
  return REQUIRED_FIELDS.filter((f) => spec[f] === undefined || spec[f] === null);
}
