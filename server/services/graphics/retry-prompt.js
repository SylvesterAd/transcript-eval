// server/services/graphics/retry-prompt.js
//
// System prompt for the SECOND-pass creator (when the critic forced a retry).
// Same output shape as create-prompt.js (var-JSON), but constrained by critic feedback.

import { CREATE_SYSTEM_PROMPT } from './create-prompt.js'

export function buildRetryPrompt({ priorCritique, priorVars }) {
  return `${CREATE_SYSTEM_PROMPT}

# Prior attempt
A prior render of this spec was scored ${priorCritique.score} by the art-director critic. The critic feedback was:

"${priorCritique.feedback}"

Per-criteria scores: ${JSON.stringify(priorCritique.criteria)}

The prior var output was:
${JSON.stringify(priorVars, null, 2)}

# Your task
Output a NEW JSON object with adjustments that address the critique. Keep aspect ratio + duration + content fields the same; only adjust visual parameters (sizes, positions, accent shade) the critic flagged. Output JSON only, no commentary.`
}
