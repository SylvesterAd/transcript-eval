import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

let client = null;
function getClient() {
  if (!client) {
    client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );
  }
  return client;
}

export async function uploadRender({ renderId, sessionId, localPath }) {
  const bucket = process.env.GRAPHICS_STORAGE_BUCKET || 'graphics';
  const key = `sessions/${sessionId}/renders/${renderId}.mp4`;
  const data = await readFile(localPath);
  const sb = getClient();
  const { error } = await sb.storage.from(bucket).upload(key, data, {
    contentType: 'video/mp4',
    upsert: true,
  });
  if (error) throw error;
  const { data: signed, error: sErr } = await sb.storage
    .from(bucket)
    .createSignedUrl(key, 60 * 60 * 24 * 7); // 7-day URL
  if (sErr) throw sErr;
  return { url: signed.signedUrl };
}
