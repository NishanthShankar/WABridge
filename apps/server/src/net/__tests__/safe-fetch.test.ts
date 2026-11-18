import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchImage } from '../../groups/group-admin.js';
import { buildMessagePayload } from '../../scheduler/message-payload.js';
import {
  assertPublicUrl,
  isPublicAddress,
  safeDispatcher,
  safeFetch,
} from '../safe-fetch.js';

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::127.0.0.1',
    'not an ip',
  ])('blocks %s', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows %s', (ip) => expect(isPublicAddress(ip)).toBe(true));
});

describe('assertPublicUrl', () => {
  it('refuses other schemes and private literal IPs', () => {
    expect(() => assertPublicUrl('file:///etc/passwd')).toThrow(
      /http or https/,
    );
    expect(() => assertPublicUrl('ftp://example.com/a')).toThrow(
      /http or https/,
    );
    expect(() => assertPublicUrl('http://127.0.0.1:4000/admin')).toThrow(
      /not a public/,
    );
    expect(() => assertPublicUrl('http://[::1]/')).toThrow(/not a public/);
    expect(() =>
      assertPublicUrl('http://169.254.169.254/latest/meta-data'),
    ).toThrow(/not a public/);
    expect(assertPublicUrl('https://example.com/a.jpg').hostname).toBe(
      'example.com',
    );
  });

  it('every media send goes through it', () => {
    expect(() => buildMessagePayload('', '/etc/passwd', 'document')).toThrow();
    expect(() =>
      buildMessagePayload('', 'http://10.0.0.5/x.jpg', 'image'),
    ).toThrow(/not a public/);
    expect(
      buildMessagePayload('', 'https://example.com/x.jpg', 'image'),
    ).toMatchObject({ image: { url: 'https://example.com/x.jpg' } });
  });
});

describe('a real local server', () => {
  let server: Server;
  let port: number;
  let hits = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.end('secret');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.close();
    safeDispatcher.close().catch(() => {});
  });

  it('is unreachable by name or by IP, and nothing gets there', async () => {
    await expect(safeFetch(`http://localhost:${port}/`)).rejects.toThrow();
    await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(
      /not a public/,
    );
    await expect(
      fetchImage(`http://localhost:${port}/a.png`),
    ).rejects.toThrow();
    // Even with the URL check skipped, the connection itself refuses (as on a redirect hop)
    await expect(
      fetch(`http://127.0.0.1:${port}/`, {
        dispatcher: safeDispatcher,
      } as RequestInit),
    ).rejects.toThrow();
    await expect(
      fetch(`http://localhost:${port}/`, {
        dispatcher: safeDispatcher,
      } as RequestInit),
    ).rejects.toThrow();
    expect(hits).toBe(0);
  });

  it('WABRIDGE_ALLOW_PRIVATE_URLS=1 lets self-hosters reach their LAN', async () => {
    process.env.WABRIDGE_ALLOW_PRIVATE_URLS = '1';
    try {
      expect(await (await safeFetch(`http://127.0.0.1:${port}/`)).text()).toBe(
        'secret',
      );
    } finally {
      Reflect.deleteProperty(process.env, 'WABRIDGE_ALLOW_PRIVATE_URLS');
    }
  });
});
