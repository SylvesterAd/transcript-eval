// One-off RSA keygen. Pins a stable extension ID by writing the SPKI
// public key into manifest.json's `key` field. Chrome derives the
// extension ID from the key, so committing the key means the ID is
// stable across unpacked loads and across machines.
//
// Run via: npm run ext:generate-key
//
// Regenerating is destructive — it changes the extension ID and breaks
// the externally_connectable whitelist in both directions. Refuses to
// run if manifest.json already has a `key` field; delete the field
// manually if you really need to rotate.

import { generateKeyPairSync, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const EXT_ROOT = path.resolve(__dirname, '..')         // extension/
const REPO_ROOT = path.resolve(EXT_ROOT, '..')          // repo root

const MANIFEST_PATH = path.join(EXT_ROOT, 'manifest.json')
const ID_OUT_PATH = path.join(EXT_ROOT, '.extension-id')
const SECRETS_DIR = path.join(REPO_ROOT, '.secrets')
const PRIV_OUT_PATH = path.join(SECRETS_DIR, 'extension-private-key.pem')

function deriveExtensionId(pubKeyDer) {
  // Chrome: sha256(public_key_DER) -> first 16 bytes (32 hex chars)
  // -> map each hex digit 0-f to letter a-p.
  const hash = createHash('sha256').update(pubKeyDer).digest('hex').slice(0, 32)
  return hash.split('').map(c => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('')
}

function main() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`manifest.json not found at ${MANIFEST_PATH}`)
    process.exit(1)
  }

  const manifestRaw = readFileSync(MANIFEST_PATH, 'utf-8')
  const manifest = JSON.parse(manifestRaw)

  if (manifest.key) {
    console.error('manifest.json already has a `key` field. Refusing to overwrite.')
    console.error('Rotating the key changes the extension ID and breaks externally_connectable.')
    console.error('If you really want to rotate, delete the `key` field manually and rerun.')
    process.exit(1)
  }

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  const pubB64 = pubDer.toString('base64')
  const extId = deriveExtensionId(pubDer)

  manifest.key = pubB64
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')

  mkdirSync(SECRETS_DIR, { recursive: true })
  writeFileSync(PRIV_OUT_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }))

  writeFileSync(ID_OUT_PATH, extId + '\n')

  console.log('✓ Generated extension key')
  console.log(`  Extension ID: ${extId}`)
  console.log(`  Manifest:     ${MANIFEST_PATH}`)
  console.log(`  Private key:  ${PRIV_OUT_PATH} (gitignored)`)
  console.log(`  ID file:      ${ID_OUT_PATH} (committed)`)
}

main()
