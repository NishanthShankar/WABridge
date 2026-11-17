import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../db/client.js';
import { groups } from '../../db/schema.js';
import {
  fetchImage,
  setGroupPicture,
  updateGroupInfo,
} from '../group-admin.js';

const GID = '120363000000000001@g.us';

function freshDb() {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  const now = new Date();
  db.insert(groups)
    .values({
      id: GID,
      name: 'Old',
      description: 'old desc',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return db;
}

function fakeSock(opts: { refuseName?: boolean } = {}) {
  const calls: Array<[string, unknown[]]> = [];
  return {
    calls,
    async groupUpdateSubject(...a: unknown[]) {
      if (opts.refuseName) throw new Error('not-authorized');
      calls.push(['subject', a]);
    },
    async groupUpdateDescription(...a: unknown[]) {
      calls.push(['description', a]);
    },
    async updateProfilePicture(...a: unknown[]) {
      calls.push(['picture', a]);
    },
  };
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const fakeFetch = (
  body: Buffer,
  headers: Record<string, string>,
  status = 200,
) =>
  (async () =>
    new Response(new Uint8Array(body), {
      status,
      headers,
    })) as unknown as typeof fetch;

describe('group info', () => {
  it('renames and changes the description, and updates the local copy', async () => {
    const db = freshDb();
    const sock = fakeSock();
    const r = await updateGroupInfo(db, sock as never, GID, {
      name: 'New name',
      description: 'Hello',
    });
    expect(r).toEqual({ applied: ['name', 'description'], failed: [] });
    expect(sock.calls).toEqual([
      ['subject', [GID, 'New name']],
      ['description', [GID, 'Hello']],
    ]);
    expect(
      db.select().from(groups).where(eq(groups.id, GID)).get(),
    ).toMatchObject({ name: 'New name', description: 'Hello' });
  });

  it('an empty description clears it; a refused rename is reported and not saved', async () => {
    const db = freshDb();
    const sock = fakeSock({ refuseName: true });
    const r = await updateGroupInfo(db, sock as never, GID, {
      name: 'X',
      description: '',
    });
    expect(r.applied).toEqual(['description']);
    expect(r.failed).toEqual([{ field: 'name', error: 'not-authorized' }]);
    expect(sock.calls).toEqual([['description', [GID, undefined]]]);
    expect(
      db.select().from(groups).where(eq(groups.id, GID)).get(),
    ).toMatchObject({ name: 'Old', description: null });
  });

  it('sets the picture from a downloaded image', async () => {
    const sock = fakeSock();
    await setGroupPicture(
      sock as never,
      GID,
      'https://x/p.png',
      fakeFetch(PNG, { 'content-type': 'image/png' }),
    );
    expect(sock.calls[0][0]).toBe('picture');
    expect(sock.calls[0][1]).toEqual([GID, PNG]);
  });

  it('refuses non-images, failed downloads, big files and non-http URLs', async () => {
    await expect(
      fetchImage(
        'https://x/a',
        fakeFetch(PNG, { 'content-type': 'text/html' }),
      ),
    ).rejects.toThrow(/Not an image/);
    await expect(
      fetchImage('https://x/a', fakeFetch(PNG, {}, 404)),
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      fetchImage(
        'https://x/a',
        fakeFetch(PNG, {
          'content-type': 'image/png',
          'content-length': String(6 * 1024 * 1024),
        }),
      ),
    ).rejects.toThrow(/5 MB/);
    await expect(fetchImage('file:///etc/passwd')).rejects.toThrow(
      /http or https/,
    );
  });
});
