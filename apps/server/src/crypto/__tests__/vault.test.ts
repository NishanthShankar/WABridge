import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, generateEncryptionKey } from '../vault.js';

describe('vault', () => {
  const masterKey = generateEncryptionKey();

  describe('encrypt then decrypt', () => {
    it('returns original string for simple text', () => {
      const plaintext = 'hello world';
      const encrypted = encrypt(plaintext, masterKey);
      const decrypted = decrypt(encrypted, masterKey);
      expect(decrypted).toBe(plaintext);
    });

    it('returns original string for empty string', () => {
      const plaintext = '';
      const encrypted = encrypt(plaintext, masterKey);
      const decrypted = decrypt(encrypted, masterKey);
      expect(decrypted).toBe(plaintext);
    });

    it('returns original string for unicode content', () => {
      const plaintext = 'Hola mundo! Emoji test: coffee cup, rocket, fire';
      const encrypted = encrypt(plaintext, masterKey);
      const decrypted = decrypt(encrypted, masterKey);
      expect(decrypted).toBe(plaintext);
    });

    it('returns original string for long content', () => {
      const plaintext = 'x'.repeat(100_000);
      const encrypted = encrypt(plaintext, masterKey);
      const decrypted = decrypt(encrypted, masterKey);
      expect(decrypted).toBe(plaintext);
    });

    it('returns original string for JSON content', () => {
      const obj = {
        key: 'value',
        nested: { array: [1, 2, 3] },
        binary: 'base64data==',
      };
      const plaintext = JSON.stringify(obj);
      const encrypted = encrypt(plaintext, masterKey);
      const decrypted = decrypt(encrypted, masterKey);
      expect(JSON.parse(decrypted)).toEqual(obj);
    });
  });

  describe('unique ciphertext per encryption', () => {
    it('produces different ciphertext for the same plaintext', () => {
      const plaintext = 'same input';
      const encrypted1 = encrypt(plaintext, masterKey);
      const encrypted2 = encrypt(plaintext, masterKey);
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('produces ciphertext in salt:iv:tag:data format', () => {
      const encrypted = encrypt('test', masterKey);
      const parts = encrypted.split(':');
      expect(parts).toHaveLength(4);
      // Each part should be valid base64
      for (const part of parts) {
        expect(() => Buffer.from(part, 'base64')).not.toThrow();
      }
    });
  });

  describe('decrypt with wrong key', () => {
    it('throws an error when decrypting with a different key', () => {
      const encrypted = encrypt('secret data', masterKey);
      const wrongKey = generateEncryptionKey();
      expect(() => decrypt(encrypted, wrongKey)).toThrow();
    });
  });

  describe('tampered ciphertext detection', () => {
    it('throws when ciphertext is modified', () => {
      const encrypted = encrypt('secret data', masterKey);
      const parts = encrypted.split(':');
      // Tamper with the ciphertext (last part)
      const tampered = Buffer.from(parts[3], 'base64');
      tampered[0] = tampered[0] ^ 0xff; // flip bits
      parts[3] = tampered.toString('base64');
      const tamperedStr = parts.join(':');
      expect(() => decrypt(tamperedStr, masterKey)).toThrow();
    });

    it('throws when auth tag is modified', () => {
      const encrypted = encrypt('secret data', masterKey);
      const parts = encrypted.split(':');
      // Tamper with the auth tag (third part)
      const tampered = Buffer.from(parts[2], 'base64');
      tampered[0] = tampered[0] ^ 0xff;
      parts[2] = tampered.toString('base64');
      const tamperedStr = parts.join(':');
      expect(() => decrypt(tamperedStr, masterKey)).toThrow();
    });
  });

  describe('generateEncryptionKey', () => {
    it('returns a base64 string of sufficient length', () => {
      const key = generateEncryptionKey();
      // 32 bytes base64-encoded = 44 characters (with padding)
      expect(key.length).toBeGreaterThanOrEqual(32);
      // Verify it decodes to 32 bytes
      const decoded = Buffer.from(key, 'base64');
      expect(decoded.length).toBe(32);
    });

    it('generates unique keys each time', () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      expect(key1).not.toBe(key2);
    });
  });
});
