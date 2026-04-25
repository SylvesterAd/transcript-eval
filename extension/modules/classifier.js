// Ext.7 — single-purpose error classifier.
//
// Maps (phase, error) to a verdict that the queue dispatches on.
// Verdicts are disjoint:
//   { retry: { delay_ms, attempts_left } }
//     — sleep delay_ms, then retry. Classifier tracks attempt count
//       via the error's `attempt` field; caller decrements.
//   { skip: { error_code, detail? } }
//     — item-only failure; queue calls failItem.
//   { hardStop: { error_code, detail? } }
//     — whole-queue failure; queue calls hardStopQueue.
//   { pauseThenRetry: { pause_ms, error_code, final_attempt_left: true } }
//     — pause the queue for pause_ms, then on resume attempt once
//       more; if that fails, hardStop.
//   { cooldownThenRetry: { cooldown_ms, error_code, final_attempt } }
//     — same as pauseThenRetry but semantically tied to 429 escalation.
//
// The classifier is pure so it's unit-testable without booting the
// queue. Future phases (Ext.9 kill-switch) can intercept the verdict
// before dispatch.

import {
  ENVATO_LICENSE_BACKOFF_MS,
  ENVATO_429_COOLDOWN_MS,
  RETRY_AFTER_MIN_SEC,
  RETRY_AFTER_MAX_SEC,
  RETRY_AFTER_JITTER,
  RESOLVER_MAX_ATTEMPTS,
  RESOLVER_RETRY_DELAY_MS,
  DOWNLOAD_NETWORK_RETRY_CAP,
} from '../config.js'

// Parse Retry-After header (RFC 7231: seconds OR HTTP-date).
// Returns seconds, clamped to [RETRY_AFTER_MIN_SEC, RETRY_AFTER_MAX_SEC],
// with ±RETRY_AFTER_JITTER jitter. Null input → default 60s.
export function parseRetryAfter(header) {
  if (!header) return 60
  const asNum = Number(header)
  let sec
  if (Number.isFinite(asNum)) {
    sec = asNum
  } else {
    const dateMs = Date.parse(header)
    if (Number.isFinite(dateMs)) {
      sec = Math.floor((dateMs - Date.now()) / 1000)
    } else {
      sec = 60
    }
  }
  sec = Math.max(RETRY_AFTER_MIN_SEC, Math.min(RETRY_AFTER_MAX_SEC, sec))
  const jitterBand = sec * RETRY_AFTER_JITTER
  const jittered = sec + (Math.random() * 2 - 1) * jitterBand
  return Math.max(RETRY_AFTER_MIN_SEC, Math.floor(jittered))
}

// Classify a resolver-phase error (Phase 1).
// Triggers: resolve_timeout, no_uuid, unexpected.
// item.resolve_attempts is maintained by the queue across retries.
export function classifyResolverError(err, item) {
  const msg = String(err?.message || err)
  if (msg === 'resolve_timeout') {
    const attempts = (item?.resolve_attempts || 0) + 1
    if (attempts < RESOLVER_MAX_ATTEMPTS) {
      return { retry: { delay_ms: RESOLVER_RETRY_DELAY_MS, attempts_left: RESOLVER_MAX_ATTEMPTS - attempts } }
    }
    return { skip: { error_code: 'resolve_failed', detail: 'resolve_timeout after retries' } }
  }
  // Envato's resolver throws a different shape for "no UUID in redirect"
  // — the resolver tab committed to a non-app.envato.com URL (likely
  // the old slug is delisted). No retry; spec says "skip, no retry".
  if (msg.includes('no_uuid') || msg.includes('delisted')) {
    return { skip: { error_code: 'envato_unavailable', detail: msg } }
  }
  // Unknown — skip conservatively.
  return { skip: { error_code: 'resolve_failed', detail: msg } }
}

// Classify a licenser-phase error (Envato Phase 2).
// The error carries err.httpStatus + err.retryAfter + err.body when
// available (envato.js attaches these before throwing in Task 4).
// item.license_attempts is the number of prior attempts.
export function classifyLicenseError(err, item) {
  const msg = String(err?.message || err)
  const status = err?.httpStatus
  const body = err?.body || ''
  const attempts = item?.license_attempts || 0

  // 401 — session expired.
  if (msg === 'envato_session_missing' || status === 401) {
    // Ext.5 already pauses the queue + broadcasts refresh_session via
    // handle401Envato. The classifier returns skip; queue calls
    // failItem with envato_session_401 and the queue-level pause is
    // the broader mechanism.
    return { skip: { error_code: 'envato_session_401', detail: msg } }
  }

  // 402 or 403-with-"upgrade" body → tier-restricted, skip.
  if (status === 402) {
    return { skip: { error_code: 'envato_402_tier', detail: msg } }
  }
  if (status === 403 && /upgrade/i.test(body)) {
    return { skip: { error_code: 'envato_402_tier', detail: 'http_403 body contains upgrade' } }
  }
  // 403 generic → hard stop.
  if (status === 403) {
    return { hardStop: { error_code: 'envato_403', detail: msg } }
  }

  // 429 escalation: first 429 → Retry-After + jitter, 1 retry.
  //                 second 429 → 5min cooldown, 1 final retry.
  //                 third 429 → hard stop.
  if (status === 429 || msg === 'envato_429') {
    const retryCount = item?.rate_limit_429_count || 0
    if (retryCount === 0) {
      const retryAfterSec = parseRetryAfter(err?.retryAfter)
      return { retry: { delay_ms: retryAfterSec * 1000, attempts_left: 2, error_code_on_fail: 'envato_429' } }
    }
    if (retryCount === 1) {
      return { cooldownThenRetry: { cooldown_ms: ENVATO_429_COOLDOWN_MS, error_code: 'envato_429', final_attempt: true } }
    }
    return { hardStop: { error_code: 'envato_429', detail: 'third 429 after cooldown' } }
  }

  // 5xx / network / DNS / timeout — exponential backoff per config.
  if ((status && status >= 500) || msg === 'envato_network_error' || msg.startsWith('envato_network_error')) {
    const backoff = ENVATO_LICENSE_BACKOFF_MS
    if (attempts < backoff.length) {
      return { retry: { delay_ms: backoff[attempts], attempts_left: backoff.length - attempts, error_code_on_fail: 'envato_unavailable' } }
    }
    return { skip: { error_code: 'envato_unavailable', detail: 'license 5xx retries exhausted' } }
  }

  // Empty downloadUrl — item delisted. Skip.
  if (msg === 'envato_unavailable') {
    return { skip: { error_code: 'envato_unavailable', detail: 'empty downloadUrl' } }
  }

  // Unsupported filetype (post-license URL check) — skip + deny-list.
  // Queue is responsible for the deny-list write; classifier just
  // returns the verdict.
  if (msg === 'envato_unsupported_filetype') {
    return { skip: { error_code: 'envato_unsupported_filetype', detail: err?.detail || 'zip/aep/prproj' } }
  }

  // Unknown — skip conservatively.
  return { skip: { error_code: 'envato_unavailable', detail: msg } }
}

// Classify a Freepik/Pexels mint-phase error.
export function classifySourceMintError(err, item) {
  const msg = String(err?.message || err)
  const status = err?.httpStatus

  if (msg === 'pexels_404' || msg === 'freepik_404') {
    const code = msg === 'pexels_404' ? 'pexels_404' : 'freepik_404'
    return { skip: { error_code: code, detail: 'upstream 404' } }
  }

  if (msg === 'freepik_429' || status === 429) {
    const attempts = item?.freepik_429_count || 0
    if (attempts === 0) {
      return { cooldownThenRetry: { cooldown_ms: ENVATO_429_COOLDOWN_MS, error_code: 'freepik_429', final_attempt: true } }
    }
    return { hardStop: { error_code: 'freepik_429', detail: 'second freepik 429 after cooldown' } }
  }

  if (msg === 'freepik_unconfigured') {
    // Skip this item AND every other freepik item in the run; queue
    // pulls that behaviour out of the skip verdict via the special
    // skip_whole_source flag.
    return { skip: { error_code: 'freepik_unconfigured', detail: 'backend 503 no API key', skip_whole_source: 'freepik' } }
  }

  if (msg.startsWith('network_error')) {
    const attempts = item?.mint_attempts || 0
    const backoff = ENVATO_LICENSE_BACKOFF_MS
    if (attempts < backoff.length) {
      return { retry: { delay_ms: backoff[attempts], attempts_left: backoff.length - attempts, error_code_on_fail: 'freepik_404' } }
    }
    return { skip: { error_code: 'freepik_404', detail: 'mint network exhausted' } }
  }

  // Source-aware default: keep error_code attached to the actual source
  // so the State F UI doesn't blame Freepik for an A-roll/Envato failure.
  const itemSource = String(item?.source || '').toLowerCase()
  if (msg.startsWith('pexels')) return { skip: { error_code: 'pexels_404', detail: msg } }
  if (msg.startsWith('aroll') || itemSource === 'aroll') return { skip: { error_code: 'aroll_unavailable', detail: msg } }
  return { skip: { error_code: 'freepik_404', detail: msg } }
}

// Classify a download-phase error (chrome.downloads interrupt).
// Called from handleDownloadInterrupt.
export function classifyDownloadInterrupt(reason, item) {
  if (reason === 'USER_CANCELED') {
    // Treated as skip-but-continue (not an error). Queue calls
    // failItem with 'cancelled' so the item counts as failed, but
    // the queue keeps rolling on other items.
    return { skip: { error_code: 'cancelled', detail: 'user cancelled' } }
  }
  if (reason.startsWith('NETWORK_')) {
    const retries = item?.retries || 0
    if (retries < DOWNLOAD_NETWORK_RETRY_CAP) {
      return { retry: { delay_ms: 0, attempts_left: DOWNLOAD_NETWORK_RETRY_CAP - retries, error_code_on_fail: 'network_failed', use_chrome_resume: true } }
    }
    return { skip: { error_code: 'network_failed', detail: reason } }
  }
  if (reason.startsWith('FILE_')) {
    return { hardStop: { error_code: 'disk_failed', detail: reason } }
  }
  if (reason === 'SERVER_FORBIDDEN' || reason === 'SERVER_UNAUTHORIZED') {
    // Signed URL expired mid-download. For Freepik, the queue will
    // try a URL refetch before treating as failure (it checks the
    // item's source + refetch_count). Here we just signal skip; the
    // queue will decide whether to promote to a refetch retry.
    return { skip: { error_code: 'url_expired_refetch_failed', detail: reason, maybe_refetch: true } }
  }
  return { skip: { error_code: 'network_failed', detail: reason } }
}

// Classify an integrity-check failure.
export function classifyIntegrityError(item) {
  const attempts = item?.integrity_retries || 0
  if (attempts === 0) {
    return { retry: { delay_ms: 0, attempts_left: 1, error_code_on_fail: 'integrity_failed', redownload: true } }
  }
  return { skip: { error_code: 'integrity_failed', detail: 'size mismatch after retry' } }
}
