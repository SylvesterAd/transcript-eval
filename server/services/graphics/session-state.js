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

const SCENE_REQUIRED = ['template', 'duration', 'mainText', 'subText'];
const TOPLEVEL_FOR_SCENES = ['aspectRatio', 'tone'];

export function mergeSpec(current = {}, update = {}) {
  const out = { ...current };
  for (const [k, v] of Object.entries(update)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

export function isMultiScene(spec) {
  return Array.isArray(spec.scenes) && spec.scenes.length > 0;
}

export function isSpecComplete(spec) {
  if (isMultiScene(spec)) {
    if (!TOPLEVEL_FOR_SCENES.every((f) => spec[f] !== undefined && spec[f] !== null)) return false;
    return spec.scenes.every((sc) =>
      SCENE_REQUIRED.every((f) => sc[f] !== undefined && sc[f] !== null)
    );
  }
  return REQUIRED_FIELDS.every((f) => spec[f] !== undefined && spec[f] !== null);
}

export function missingFields(spec) {
  if (isMultiScene(spec)) {
    const missing = [];
    for (const f of TOPLEVEL_FOR_SCENES) {
      if (spec[f] === undefined || spec[f] === null) missing.push(f);
    }
    spec.scenes.forEach((sc, i) => {
      for (const f of SCENE_REQUIRED) {
        if (sc[f] === undefined || sc[f] === null) missing.push(`scenes[${i}].${f}`);
      }
    });
    return missing;
  }
  return REQUIRED_FIELDS.filter((f) => spec[f] === undefined || spec[f] === null);
}
