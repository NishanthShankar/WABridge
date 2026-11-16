import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { configSchema } from '../config/schema.js';
import {
  type Extension,
  attachExtensions,
  loadExtensions,
} from '../extensions.js';

const logger = pino({ level: 'silent' });

describe('extensions', () => {
  it('skips a package that is not installed instead of failing', async () => {
    const config = configSchema.parse({
      extensions: { '@openwa/does-not-exist': {} },
    });
    expect(await loadExtensions(config, logger)).toEqual([]);
  });

  it('defaults to no extensions', async () => {
    expect(configSchema.parse({}).extensions).toEqual({});
  });

  it('gives each extension its own options, and one failure does not stop the rest', () => {
    const config = configSchema.parse({ extensions: { a: { x: 1 }, b: {} } });
    const seen: unknown[] = [];
    const exts: Extension[] = [
      { name: 'a', onConnected: (_s, ctx) => seen.push(ctx.options) },
      {
        name: 'boom',
        onConnected: () => {
          throw new Error('nope');
        },
      },
      { name: 'b', onConnected: vi.fn() },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: the socket and db are not used by these extensions
    attachExtensions(exts, {} as any, { db: {} as any, config, logger });
    expect(seen).toEqual([{ x: 1 }]);
    expect(exts[2].onConnected).toHaveBeenCalledOnce();
  });
});
