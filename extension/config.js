// Compile-time extension config. Chrome extensions cannot read .env
// at runtime — config is baked in at build time. ENV = "dev" on the
// unpacked build, "prod" when packaged for the Chrome Web Store.
// Change ENV by editing this file before packaging; there's no
// build-step substitution yet (added in Ext.10).

export const EXT_VERSION = '0.1.0'
export const ENV = 'dev'  // "dev" | "prod"

export const BACKEND_URL = ENV === 'prod'
  ? 'https://backend-production-4b19.up.railway.app'
  : 'http://localhost:3001'

// Message protocol version. Bump only on breaking changes to the
// web app ↔ extension message shape. See spec § "Versioning".
export const MESSAGE_VERSION = 1
