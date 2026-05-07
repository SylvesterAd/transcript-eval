// server/services/graphics/retry-prompt.js
//
// System prompt for the SECOND-pass HTML author (when the critic forced a retry).
// Same Hyperframes contract as create-prompt; constrained by critic feedback.

import { CREATE_HTML_SYSTEM_PROMPT } from './html-generator.js'

export function buildRetryPrompt({ priorCritique, priorHtml }) {
  return `${CREATE_HTML_SYSTEM_PROMPT}

# Prior attempt
A prior render of this spec was scored ${priorCritique.score} by the art-director critic. The critic feedback was:

"${priorCritique.feedback}"

Per-criteria scores: ${JSON.stringify(priorCritique.criteria)}

The prior HTML output was:

\`\`\`html
${priorHtml}
\`\`\`

# Your task
Output a NEW complete HTML file that addresses the critique. Keep the same content (text, duration, aspect) — only adjust visual parameters (sizing, colors, positioning, animation timing) the critic flagged. Output ONLY the HTML file, no commentary, no markdown fences.`
}
