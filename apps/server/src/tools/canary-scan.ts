import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

/**
 * Canary scan: look for a word everywhere this server keeps things, and say only WHERE it was
 * found. Never prints what is around it.
 *
 *   cd apps/server && pnpm canary-scan <word> [--data DIR]... [--logs DIR]... [--path P]...
 *                                             [--config FILE] [--no-redis]
 *
 * Looks in: every file under the data folders (databases, their WAL files, held media,
 * anything else), every file under the log folders, and every key and value in Redis.
 * Looks for the word as plain text (UTF-8 and UTF-16), as base64 and base64url at any
 * alignment, as hex, and as JSON-escaped text. Exit code 0: not found. 1: found. 2: could
 * not complete.
 *
 * Defaults: data = ./data of the server folder, logs = ../../logs, config =
 * OPENWA_CONFIG_PATH or ../../config.yaml. Use a made-up word of 8 letters or more.
 */

export interface Needle {
  form: string;
  bytes: Buffer;
}

/** The byte patterns a word could appear as. */
export function needlesFor(word: string): Needle[] {
  const utf8 = Buffer.from(word, 'utf8');
  const out: Needle[] = [
    { form: 'plain text', bytes: utf8 },
    { form: 'UTF-16 text', bytes: Buffer.from(word, 'utf16le') },
    { form: 'hex', bytes: Buffer.from(utf8.toString('hex')) },
    {
      form: 'hex (upper case)',
      bytes: Buffer.from(utf8.toString('hex').toUpperCase()),
    },
  ];
  // base64 depends on where in a larger blob the word starts: three alignments
  for (let shift = 0; shift < 3; shift++) {
    const total = shift + utf8.length;
    const encoded = Buffer.concat([Buffer.alloc(shift), utf8])
      .toString('base64')
      .replace(/=+$/, '');
    // Only the characters fully decided by the word itself
    const stable = encoded.slice(
      Math.ceil((shift * 8) / 6),
      Math.floor((total * 8) / 6),
    );
    if (stable.length < 8) continue;
    out.push({ form: 'base64', bytes: Buffer.from(stable) });
    const url = stable.replace(/\+/g, '-').replace(/\//g, '_');
    if (url !== stable)
      out.push({ form: 'base64url', bytes: Buffer.from(url) });
  }
  const escaped = JSON.stringify(word)
    .slice(1, -1)
    .replace(
      /[\u0080-￿]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  if (escaped !== word)
    out.push({ form: 'JSON-escaped text', bytes: Buffer.from(escaped) });
  return out;
}

/** Where in a buffer any needle occurs: [{ form, offset }], first hit per form. */
export function scanBuffer(
  buffer: Buffer,
  needles: Needle[],
): Array<{ form: string; offset: number }> {
  const hits: Array<{ form: string; offset: number }> = [];
  for (const n of needles) {
    const at = buffer.indexOf(n.bytes);
    if (at !== -1) hits.push({ form: n.form, offset: at });
  }
  return hits;
}

/** Scan a file of any size without loading it whole. Offsets are from the start of the file. */
export async function scanFile(
  path: string,
  needles: Needle[],
): Promise<Array<{ form: string; offset: number }>> {
  const overlap = Math.max(...needles.map((n) => n.bytes.length)) - 1;
  const found = new Map<string, number>();
  let carry: Buffer = Buffer.alloc(0);
  let base = 0;
  for await (const chunk of createReadStream(path, {
    highWaterMark: 4 * 1024 * 1024,
  })) {
    const window = carry.length
      ? Buffer.concat([carry, chunk as Buffer])
      : (chunk as Buffer);
    for (const hit of scanBuffer(window, needles))
      if (!found.has(hit.form))
        found.set(hit.form, base - carry.length + hit.offset);
    base += (chunk as Buffer).length;
    carry = window.subarray(Math.max(0, window.length - overlap));
  }
  return [...found].map(([form, offset]) => ({ form, offset }));
}

export function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const info = statSync(root);
  if (info.isFile()) return [root];
  if (!info.isDirectory()) return [];
  return readdirSync(root).flatMap((name) => listFiles(join(root, name)));
}

interface RedisLike {
  scan(
    cursor: string,
    ...args: Array<string | number>
  ): Promise<[string, string[]]>;
  type(key: string): Promise<string>;
  getBuffer(key: string): Promise<Buffer | null>;
  hgetallBuffer(key: string): Promise<Record<string, Buffer>>;
  lrangeBuffer(key: string, a: number, b: number): Promise<Buffer[]>;
  smembersBuffer(key: string): Promise<Buffer[]>;
  zrangeBuffer(key: string, a: number, b: number): Promise<Buffer[]>;
  xrange(key: string, a: string, b: string): Promise<Array<[string, string[]]>>;
  quit(): Promise<unknown>;
}

/** Every key name and every value in Redis. Returns the keys with a hit, and how many were read. */
export async function scanRedis(redis: RedisLike, needles: Needle[]) {
  const hits: Array<{
    key: string;
    type: string;
    where: string;
    form: string;
  }> = [];
  let keys = 0;
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'COUNT', 500);
    cursor = next;
    for (const key of batch) {
      keys++;
      const type = await redis.type(key);
      const parts: Array<[string, Buffer]> = [['key name', Buffer.from(key)]];
      if (type === 'string')
        parts.push(['value', (await redis.getBuffer(key)) ?? Buffer.alloc(0)]);
      else if (type === 'hash')
        for (const [field, value] of Object.entries(
          await redis.hgetallBuffer(key),
        ))
          parts.push([
            `field ${field}`,
            Buffer.concat([Buffer.from(field), Buffer.from('\n'), value]),
          ]);
      else if (type === 'list')
        parts.push([
          'list',
          Buffer.concat(
            (await redis.lrangeBuffer(key, 0, -1)).flatMap((b) => [
              b,
              Buffer.from('\n'),
            ]),
          ),
        ]);
      else if (type === 'set')
        parts.push([
          'set',
          Buffer.concat(
            (await redis.smembersBuffer(key)).flatMap((b) => [
              b,
              Buffer.from('\n'),
            ]),
          ),
        ]);
      else if (type === 'zset')
        parts.push([
          'sorted set',
          Buffer.concat(
            (await redis.zrangeBuffer(key, 0, -1)).flatMap((b) => [
              b,
              Buffer.from('\n'),
            ]),
          ),
        ]);
      else if (type === 'stream')
        parts.push([
          'stream',
          Buffer.from(JSON.stringify(await redis.xrange(key, '-', '+'))),
        ]);
      for (const [where, bytes] of parts)
        // A hash field's name is a job or field id, not content: safe to show
        for (const hit of scanBuffer(bytes, needles))
          hits.push({ key, type, where, form: hit.form });
    }
  } while (cursor !== '0');
  return { hits, keys };
}

async function main(argv: string[]): Promise<number> {
  const VALUE_FLAGS = ['--data', '--logs', '--path', '--config'];
  const all = (flag: string) =>
    argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []));
  const word = argv.find(
    (a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]),
  );
  if (!word || word.startsWith('--')) {
    console.error(
      'Usage: canary-scan <word> [--data DIR]... [--logs DIR]... [--path P]... [--config FILE] [--no-redis]',
    );
    return 2;
  }
  if (Buffer.byteLength(word) < 8) {
    console.error(
      'Use a made-up word of at least 8 letters: a short or common word matches by accident.',
    );
    return 2;
  }
  const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const data = all('--data').length ? all('--data') : [join(serverDir, 'data')];
  const logs = all('--logs').length
    ? all('--logs')
    : [resolve(serverDir, '../../logs')];
  const roots = [...data, ...logs, ...all('--path')];
  const needles = needlesFor(word);
  let found = 0;
  let incomplete = false;

  let files = 0;
  let bytes = 0;
  for (const root of roots) {
    if (!existsSync(root)) {
      console.log(`skipped  ${root} (does not exist)`);
      continue;
    }
    for (const file of listFiles(root)) {
      files++;
      bytes += statSync(file).size;
      try {
        for (const hit of await scanFile(file, needles)) {
          found++;
          console.log(
            `FOUND    file   ${file}   at byte ${hit.offset}   as ${hit.form}`,
          );
        }
      } catch (err) {
        incomplete = true;
        console.log(`UNREAD   file   ${file}   (${(err as Error).name})`);
      }
    }
  }
  console.log(
    `scanned  ${files} files, ${(bytes / 1_048_576).toFixed(1)} MB, under: ${roots.join(', ')}`,
  );

  if (!argv.includes('--no-redis')) {
    const configPath =
      all('--config')[0] ??
      process.env.OPENWA_CONFIG_PATH ??
      resolve(serverDir, '../../config.yaml');
    const config = (
      existsSync(configPath) ? yaml.load(readFileSync(configPath, 'utf8')) : {}
    ) as {
      valkey?: { host?: string; port?: number; password?: string };
    } | null;
    const { host = 'localhost', port = 6379, password } = config?.valkey ?? {};
    try {
      // The Redis client the queue library already brings
      const require = createRequire(import.meta.url);
      const Redis = require(
        require.resolve('ioredis', {
          paths: [dirname(require.resolve('bullmq'))],
        }),
      ) as {
        new (o: object): RedisLike;
      } & { default?: new (o: object) => RedisLike };
      const redis = new (Redis.default ?? Redis)({
        host,
        port,
        password,
        lazyConnect: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
      });
      const result = await scanRedis(redis, needles);
      await redis.quit();
      for (const hit of result.hits) {
        found++;
        console.log(
          `FOUND    redis  ${hit.key}   (${hit.type}, ${hit.where})   as ${hit.form}`,
        );
      }
      console.log(`scanned  ${result.keys} Redis keys at ${host}:${port}`);
    } catch (err) {
      incomplete = true;
      console.log(`UNREAD   redis  ${host}:${port}   (${(err as Error).name})`);
    }
  }

  if (found) console.log(`\nFOUND in ${found} place(s).`);
  else if (incomplete)
    console.log(
      '\nNot found in what could be read, but the scan was not complete.',
    );
  else console.log('\nNot found anywhere.');
  return found ? 1 : incomplete ? 2 : 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).then((code) => process.exit(code));
