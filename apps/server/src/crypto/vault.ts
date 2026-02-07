import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const TAG_LENGTH = 16; // 128-bit auth tag
const SALT_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

/**
 * Derive a 256-bit encryption key from a password and salt using scrypt.
 */
function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH);
}

/**
 * Encrypt a plaintext string using AES-256-GCM with a random salt and IV.
 * Each call produces unique ciphertext (random salt + IV per encryption).
 *
 * @returns Colon-separated base64 string: `salt:iv:tag:ciphertext`
 */
export function encrypt(plaintext: string, masterKey: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(masterKey, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    salt.toString('base64'),
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a string produced by encrypt().
 * Throws if the master key is wrong or the ciphertext has been tampered with.
 */
export function decrypt(encryptedStr: string, masterKey: string): string {
  const [saltB64, ivB64, tagB64, dataB64] = encryptedStr.split(':');
  const salt = Buffer.from(saltB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const encrypted = Buffer.from(dataB64, 'base64');

  const key = deriveKey(masterKey, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    'utf8',
  );
}

/**
 * Generate a cryptographically secure random encryption key.
 * Returns a base64-encoded 32-byte key suitable for use as a master key.
 */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_LENGTH).toString('base64');
}

/**
 * Generate a prefixed API key: `sk_` + 32 random hex characters.
 */
export function generateApiKey(): string {
  return `sk_${randomBytes(16).toString('hex')}`;
}
