import crypto from 'crypto';

let _publicKey = null;
let _privateKey = null;

/**
 * Initialize or load RSA key pair.
 * Set RSA_PRIVATE_KEY_PEM in .env to use existing keys, otherwise generates on first use.
 */
function ensureKeys() {
  if (_privateKey) return;
  const pem = process.env.RSA_PRIVATE_KEY_PEM;
  if (pem) {
    _privateKey = crypto.createPrivateKey(pem);
    _publicKey = crypto.createPublicKey(_privateKey);
  } else {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    _publicKey = crypto.createPublicKey(publicKey);
    _privateKey = crypto.createPrivateKey(privateKey);
    // In production, set RSA_PRIVATE_KEY_PEM so keys persist across restarts
    if (process.env.NODE_ENV === 'production') {
      console.warn('RSA: Using ephemeral keys. Set RSA_PRIVATE_KEY_PEM for production.');
    }
  }
}

/** Get PEM public key for frontend to encrypt credentials */
export function getPublicKeyPem() {
  ensureKeys();
  return _publicKey.export({ type: 'spki', format: 'pem' });
}

/**
 * Decrypt RSA-OAEP base64 ciphertext to plain password.
 * Returns null if decryption fails.
 */
export function decryptCredentials(cipherBase64) {
  ensureKeys();
  try {
    const buf = Buffer.from(cipherBase64, 'base64');
    if (buf.length < 200) return null; // RSA 2048 cipher is ~256 bytes
    const decrypted = crypto.privateDecrypt(
      { key: _privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
      buf
    );
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}
