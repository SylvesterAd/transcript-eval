// server/services/graphics/lint-runner.js
//
// Wraps `npx hyperframes lint <projectDir> --json` and returns structured findings.
// Used as a pre-render gate in render-worker; non-zero errorCount triggers a
// feedback re-prompt via specToHtml.
//
// NOTE: hyperframes lint requires a DIRECTORY argument containing an index.html;
// passing a single file path errors with "Not a directory". Callers must write
// the HTML into a per-scene project dir as `<projectDir>/index.html`.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function runLint({ projectDir }) {
  if (!projectDir) throw new Error('runLint: projectDir required')

  let stdout
  try {
    ;({ stdout } = await exec(
      'npx',
      ['--yes', 'hyperframes', 'lint', projectDir, '--json'],
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

  // hyperframes lint --json prints a single JSON object on stdout, but the
  // CLI can also print a telemetry banner on first run (and possibly other
  // status text). Slice from the first `{` to the last `}` so any preamble or
  // trailing noise is ignored.
  let parsed
  const firstBrace = stdout.indexOf('{')
  const lastBrace = stdout.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error(
      `runLint: no JSON object found in hyperframes lint output.\nstdout (first 500 chars): ${String(stdout).slice(0, 500)}`
    )
  }
  const jsonStr = stdout.slice(firstBrace, lastBrace + 1)
  try {
    parsed = JSON.parse(jsonStr)
  } catch (e) {
    throw new Error(
      `runLint: failed to parse hyperframes lint output as JSON: ${e.message}\nsliced JSON (first 500 chars): ${jsonStr.slice(0, 500)}`
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
