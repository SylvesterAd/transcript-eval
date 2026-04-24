// server/services/bundle-parser.js
// Pure parser for Ext.8 Bundle Format (v1). Takes Uint8Array bytes of
// a ZIP, returns { meta, queue, events, environment } or throws a
// BundleParseError. See docs/superpowers/plans/2026-04-24-extension-ext8-diagnostics.md
// § "Bundle format (v1)" for the schema.
//
// Invariants (see WebApp.4 plan):
//   1. STATELESS — no DB, no FS. Pure.
//   3. Only schema_version === 1 accepted. Anything else → BundleParseError
//      with errorCode "unsupported_bundle_version" + httpStatus 422.

import { unzipSync, strFromU8 } from 'fflate'

export const SUPPORTED_SCHEMA_VERSIONS = [1]

const EXPECTED_FILES = ['meta.json', 'queue.json', 'events.json', 'environment.json']

export class BundleParseError extends Error {
  constructor(errorCode, httpStatus, detail = {}) {
    super(errorCode)
    this.errorCode = errorCode
    this.httpStatus = httpStatus
    this.detail = detail
  }
}

export function parseBundle(bytes) {
  if (!bytes || !(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new BundleParseError('missing_zip_body', 400)
  }

  let files
  try {
    files = unzipSync(bytes)
  } catch (err) {
    throw new BundleParseError('invalid_zip', 400, { cause: String(err?.message || err) })
  }

  for (const name of EXPECTED_FILES) {
    if (!files[name]) throw new BundleParseError('missing_bundle_file', 400, { missing: name })
  }

  const parsed = {}
  for (const name of EXPECTED_FILES) {
    const key = name.replace('.json', '') // meta | queue | events | environment
    try {
      parsed[key] = JSON.parse(strFromU8(files[name]))
    } catch (err) {
      throw new BundleParseError('invalid_json', 400, { file: name, cause: String(err?.message || err) })
    }
  }

  // Schema version check — only meta.schema_version gates migration.
  const schema = parsed.meta?.schema_version
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(schema)) {
    throw new BundleParseError('unsupported_bundle_version', 422, {
      supported_versions: SUPPORTED_SCHEMA_VERSIONS,
      got: schema ?? null,
    })
  }

  // Required-field validation per the Bundle Format (v1) contract.
  // Add more checks as spec tightens; each should map to missing_required_field.
  const requireField = (file, obj, field) => {
    if (obj == null || obj[field] === undefined) {
      throw new BundleParseError('missing_required_field', 400, { file, field })
    }
  }
  requireField('meta.json', parsed.meta, 'ext_version')
  requireField('meta.json', parsed.meta, 'generated_at')
  requireField('queue.json', parsed.queue, 'runs')
  requireField('events.json', parsed.events, 'events')
  requireField('environment.json', parsed.environment, 'user_agent')
  requireField('environment.json', parsed.environment, 'platform')
  requireField('environment.json', parsed.environment, 'cookie_presence')
  requireField('environment.json', parsed.environment, 'jwt_presence')
  requireField('environment.json', parsed.environment, 'deny_list')
  requireField('environment.json', parsed.environment, 'daily_counts')
  requireField('environment.json', parsed.environment, 'telemetry_overflow_total')
  requireField('environment.json', parsed.environment, 'telemetry_opt_out')

  return parsed
}
