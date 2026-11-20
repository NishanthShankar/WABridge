import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listFiles,
  needlesFor,
  scanBuffer,
  scanFile,
  scanRedis,
} from '../canary-scan.js';

const WORD = 'zorbleflux-canary';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wab-canary-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('canary scan', () => {
  it('finds the word however it is written, and nothing in what does not hold it', () => {
    const needles = needlesFor(WORD);
    const word = Buffer.from(WORD);
    const hidden: Record<string, Buffer> = {
      'plain text': Buffer.from(`before ${WORD} after`),
      'UTF-16 text': Buffer.concat([
        Buffer.from('xx'),
        Buffer.from(WORD, 'utf16le'),
      ]),
      hex: Buffer.from(`00${word.toString('hex')}ff`),
      'hex (upper case)': Buffer.from(word.toString('hex').toUpperCase()),
    };
    for (const [form, bytes] of Object.entries(hidden))
      expect(
        scanBuffer(bytes, needles).map((h) => h.form),
        form,
      ).toContain(form);
    // base64 inside a larger blob, at each of the three alignments
    for (const lead of ['', 'a', 'ab', 'abc', 'abcd']) {
      const blob = Buffer.from(`${lead}${WORD} and more`).toString('base64');
      expect(
        scanBuffer(Buffer.from(`{"data":"${blob}"}`), needles).some(
          (h) => h.form === 'base64',
        ),
        `lead ${lead.length}`,
      ).toBe(true);
    }
    expect(
      scanBuffer(Buffer.from('nothing to see, zorble flux canary'), needles),
    ).toEqual([]);
    // Random-looking bytes are not a hit
    expect(
      scanBuffer(
        Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 73) % 256)),
        needles,
      ),
    ).toEqual([]);
  });

  it('finds a non-ASCII word in JSON-escaped form too', () => {
    const needles = needlesFor('grüßwörtchen');
    expect(
      scanBuffer(
        Buffer.from('{"t":"gr\\u00fc\\u00dfw\\u00f6rtchen"}'),
        needles,
      ).map((h) => h.form),
    ).toEqual(['JSON-escaped text']);
  });

  it('scans large files in pieces, including a word that straddles two pieces', async () => {
    const needles = needlesFor(WORD);
    const piece = 4 * 1024 * 1024;
    const big = Buffer.alloc(piece + 5000, 0x61);
    Buffer.from(WORD).copy(big, piece - 6); // across the boundary
    writeFileSync(join(dir, 'big.log'), big);
    writeFileSync(join(dir, 'clean.db'), Buffer.alloc(100_000, 0x62));
    expect(await scanFile(join(dir, 'big.log'), needles)).toEqual([
      { form: 'plain text', offset: piece - 6 },
    ]);
    expect(await scanFile(join(dir, 'clean.db'), needles)).toEqual([]);
    expect(listFiles(dir).sort()).toEqual([
      join(dir, 'big.log'),
      join(dir, 'clean.db'),
    ]);
  });

  it('looks at every Redis key and value, and reports where, not what', async () => {
    const store: Record<string, { type: string; value: unknown }> = {
      'bull:message-send:42': {
        type: 'hash',
        value: {
          data: Buffer.from(`{"text":"${WORD}"}`),
          name: Buffer.from('send'),
        },
      },
      'bull:message-send:43': {
        type: 'hash',
        value: { data: Buffer.from('{"scheduledMessageId":"abc"}') },
      },
      'bull:message-send:wait': {
        type: 'list',
        value: [Buffer.from('42'), Buffer.from('43')],
      },
      [`weird:${WORD}`]: { type: 'string', value: Buffer.from('1') },
      'bull:events': {
        type: 'stream',
        value: [['1-0', ['event', 'completed']]],
      },
    };
    const redis = {
      scan: async () => ['0', Object.keys(store)] as [string, string[]],
      type: async (k: string) => store[k].type,
      getBuffer: async (k: string) => store[k].value as Buffer,
      hgetallBuffer: async (k: string) =>
        store[k].value as Record<string, Buffer>,
      lrangeBuffer: async (k: string) => store[k].value as Buffer[],
      smembersBuffer: async () => [],
      zrangeBuffer: async () => [],
      xrange: async (k: string) => store[k].value as Array<[string, string[]]>,
      quit: async () => {},
    };
    const result = await scanRedis(redis, needlesFor(WORD));
    expect(result.keys).toBe(5);
    expect(result.hits).toEqual([
      {
        key: 'bull:message-send:42',
        type: 'hash',
        where: 'field data',
        form: 'plain text',
      },
      {
        key: `weird:${WORD}`,
        type: 'string',
        where: 'key name',
        form: 'plain text',
      },
    ]);
  });
});
