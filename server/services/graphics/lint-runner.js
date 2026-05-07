// server/services/graphics/lint-runner.js
//
// Wraps `npx hyperframes lint <htmlPath> --json` and returns structured findings.
// Used as a pre-render gate in render-worker; non-zero errorCount triggers a
// feedback re-prompt via specToHtml.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function runLint({ htmlPath }) {
  if (!htmlPath) throw new Error('runLint: htmlPath required')

  let stdout
  try {
    ;({ stdout } = await exec(
      'npx',
      ['--yes', 'hyperframes', 'lint', htmlPath, '--json'],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
    ))
  } catch (err) {
    // hyperframes lint exits non-zero when errorCount > 0; the JSON payload is still on err.stdout.
    if (err && typeof err.stdout === 'string' && err.stdout.length > 0) {
      stdout = err.stdout
    } else {
      throw err
    }
  }

  // hyperframes lint --json prints a single JSON object on stdout
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (e) {
    throw new Error(
      `runLint: failed to parse hyperframes lint output as JSON: ${e.message}\nstdout (first 500 chars): ${String(stdout).slice(0, 500)}`
    )
  }

  return {
    errorCount: parsed.errorCount ?? 0,
    warningCount: parsed.warningCount ?? 0,
    infoCount: parsed.infoCount ?? 0,
    findings: parsed.findings ?? [],
  }
}

export function formatFindingsForPrompt(findings) {
  if (!findings || findings.length === 0) return ''
  const lines = findings.map(
    (f) => `- [${f.severity?.toUpperCase() ?? 'ERROR'}] ${f.rule ?? 'lint'}: ${f.message}`
  )
  return `Lint findings:\n${lines.join('\n')}`
}
