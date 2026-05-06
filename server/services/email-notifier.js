// Resend-backed transactional email dispatcher for slice-2 chain notifications.
//
// Templates: done | paused_at_strategy | paused_at_plan | failed.
// Dedup: per-sub-group 5-minute window (notified_at column on video_groups).
// Failure: logs and swallows; never throws out of send() so the orchestrator
//          can stay fire-and-forget.
//
// When RESEND_API_KEY is unset (e.g. during local dev or before DNS is
// verified), every call is a no-op and a single console.log marks it.

import { Resend } from 'resend'
import db from '../db.js'

const FROM = 'Cutpunk <noreply@cutpunk.ai>'
const PUBLIC_FRONTEND_URL = process.env.PUBLIC_FRONTEND_URL
  || 'https://transcript-eval-sylvesterads-projects.vercel.app'

let resend = null
function getClient() {
  if (resend !== null) return resend
  resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : false
  return resend || null
}

const TEMPLATES = {
  done: ({ projectName, editorUrl }) => ({
    subject: `Your project "${projectName}" is ready`,
    html: `<p>We've finished processing your project.</p><p><a href="${editorUrl}">Open project →</a></p>`,
  }),
  paused_at_rough_cut: ({ projectName, editorUrl }) => ({
    subject: `Review the rough cut for "${projectName}"`,
    html: `<p>The AI rough cut is ready. Review the cuts and click "B-Roll Strategy" in the sidebar when you're happy with it.</p><p><a href="${editorUrl}">Open project →</a></p>`,
  }),
  paused_at_strategy: ({ projectName, editorUrl }) => ({
    subject: `Pick a creative strategy for "${projectName}"`,
    html: `<p>Your project's references have been analyzed. Pick the strategy you'd like to run.</p><p><a href="${editorUrl}">Open project →</a></p>`,
  }),
  paused_at_plan: ({ projectName, editorUrl }) => ({
    subject: `Pick a b-roll plan for "${projectName}"`,
    html: `<p>Your strategy is set. Pick a plan to start the b-roll search.</p><p><a href="${editorUrl}">Open project →</a></p>`,
  }),
  failed: ({ projectName, editorUrl, error }) => ({
    subject: `Something went wrong with "${projectName}"`,
    html: `<p>We hit an error processing your project: ${error || 'unknown'}.</p><p><a href="${editorUrl}">Open project to retry →</a></p>`,
  }),
}

const ROUTE_BY_TEMPLATE = {
  paused_at_rough_cut: (id) => `/editor/${id}/roughcut`,
  paused_at_strategy:  (id) => `/editor/${id}/brolls/strategy/strategy`,
  paused_at_plan:      (id) => `/editor/${id}/brolls/strategy/plan`,
  done:                (id) => `/editor/${id}/brolls/edit`,
  failed:              (id) => `/editor/${id}/sync`,
}

export async function send(template, { subGroupId, userId, error } = {}) {
  const client = getClient()
  if (!client) {
    console.log(`[email] no API key — skipping ${template} for sub-group ${subGroupId}`)
    return
  }
  const tpl = TEMPLATES[template]
  if (!tpl) {
    console.error(`[email] unknown template: ${template}`)
    return
  }

  try {
    const recent = await db.prepare(
      "SELECT notified_at FROM video_groups WHERE id = ? AND notified_at > NOW() - INTERVAL '5 minutes'"
    ).get(subGroupId)
    if (recent?.notified_at) return

    const sg = await db.prepare('SELECT id, name FROM video_groups WHERE id = ?').get(subGroupId)
    if (!sg) return
    const user = await db.prepare('SELECT email FROM auth.users WHERE id = ?').get(userId)
    if (!user?.email) return

    const editorUrl = `${PUBLIC_FRONTEND_URL}${ROUTE_BY_TEMPLATE[template](subGroupId)}`
    const { subject, html } = tpl({ projectName: sg.name, editorUrl, error })

    // Resend's SDK never throws on delivery failure — it returns
    // `{ data, error }` on the resolved Promise. Without this check, an
    // unverified-from-domain (e.g. cutpunk.ai DNS not configured), a
    // bounce, or any 4xx from Resend looks like a successful send: the
    // notified_at column gets stamped and the user silently never sees
    // the mail. Surface the error so chain failures are diagnosable
    // from Railway logs, and skip the notified_at update so a periodic
    // sweep resume gets another chance to notify on its next run.
    const result = await client.emails.send({ from: FROM, to: user.email, subject, html })
    if (result?.error) {
      const errMsg = result.error.message || JSON.stringify(result.error)
      console.error(`[email] resend error for ${template} sub-group ${subGroupId}: ${errMsg}`)
      return
    }
    await db.prepare('UPDATE video_groups SET notified_at = NOW() WHERE id = ?').run(subGroupId)
    console.log(`[email] sent ${template} for sub-group ${subGroupId} to ${user.email} (id=${result?.data?.id || '?'})`)
  } catch (err) {
    console.error('[email] send failed:', err.message)
  }
}
