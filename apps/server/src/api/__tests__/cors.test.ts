import { describe, expect, it } from 'vitest';
import { corsAllows } from '../routes.js';

const ALLOWED = ['https://status.example.com', 'https://*.example.org'];

describe('corsAllows', () => {
  it('exact origins, case-insensitive', () => {
    expect(corsAllows(ALLOWED, 'https://status.example.com')).toBe(true);
    expect(corsAllows(ALLOWED, 'HTTPS://Status.Example.com')).toBe(true);
    expect(corsAllows(ALLOWED, 'http://status.example.com')).toBe(false);
    expect(corsAllows(ALLOWED, 'https://status.example.com.evil.test')).toBe(
      false,
    );
  });

  it('a wildcard matches one subdomain level of that domain only', () => {
    expect(corsAllows(ALLOWED, 'https://app.example.org')).toBe(true);
    expect(corsAllows(ALLOWED, 'https://example.org')).toBe(false);
    expect(corsAllows(ALLOWED, 'https://a.b.example.org')).toBe(false);
    expect(corsAllows(ALLOWED, 'https://app.example.org.evil.test')).toBe(
      false,
    );
    expect(corsAllows(ALLOWED, 'https://appXexample.org')).toBe(false);
    expect(corsAllows(ALLOWED, 'http://app.example.org')).toBe(false);
  });

  it('nothing configured: nothing allowed', () => {
    expect(corsAllows([], 'https://status.example.com')).toBe(false);
  });
});
