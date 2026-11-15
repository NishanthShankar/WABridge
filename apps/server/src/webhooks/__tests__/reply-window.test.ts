import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../db/client.js';
import { insideReplyWindow, lastInbound, recordInbound, REPLY_WINDOW_MS } from '../chat-activity.js';
import { createWebhooksService } from '../webhooks.service.js';
import { isGroupJid, jidToPhone, toJid } from '../jid.js';

function freshDb() {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  return db;
}

describe('jid helpers', () => {
  it('turns phones and JIDs into JIDs', () => {
    expect(toJid('+91 98123 45678')).toBe('919812345678@s.whatsapp.net');
    expect(toJid('919812345678')).toBe('919812345678@s.whatsapp.net');
    expect(toJid('120363012345678@g.us')).toBe('120363012345678@g.us');
    expect(toJid('2384756@lid')).toBe('2384756@lid');
    expect(toJid('not a phone')).toBeNull();
    expect(toJid('x@example.com')).toBeNull();
  });

  it('strips device and server', () => {
    expect(jidToPhone('919812345678:12@s.whatsapp.net')).toBe('919812345678');
    expect(isGroupJid('120363012345678@g.us')).toBe(true);
    expect(isGroupJid('919812345678@s.whatsapp.net')).toBe(false);
  });
});

describe('reply window', () => {
  it('is closed for a chat that never wrote', () => {
    const db = freshDb();
    expect(insideReplyWindow(db, ['919812345678@s.whatsapp.net'])).toBe(false);
  });

  it('opens for 24 hours after an inbound message, for both the LID and phone JID', () => {
    const db = freshDb();
    const at = new Date('2026-11-15T10:00:00Z');
    recordInbound(db, '2384756@lid', '919812345678@s.whatsapp.net', at);

    expect(lastInbound(db, ['919812345678@s.whatsapp.net'])?.toISOString()).toBe(at.toISOString());
    expect(insideReplyWindow(db, ['2384756@lid'], at.getTime() + 1000)).toBe(true);
    expect(insideReplyWindow(db, ['919812345678@s.whatsapp.net'], at.getTime() + REPLY_WINDOW_MS - 1)).toBe(true);
    expect(insideReplyWindow(db, ['919812345678@s.whatsapp.net'], at.getTime() + REPLY_WINDOW_MS)).toBe(false);
  });

  it('moves forward with each new message', () => {
    const db = freshDb();
    const jid = '120363012345678@g.us';
    recordInbound(db, jid, null, new Date('2026-11-14T00:00:00Z'));
    recordInbound(db, jid, null, new Date('2026-11-15T00:00:00Z'));
    expect(lastInbound(db, [jid])?.toISOString()).toBe('2026-11-15T00:00:00.000Z');
  });
});

describe('webhooks allEvents', () => {
  it('only catch-all webhooks that opted in receive group and other events', () => {
    const db = freshDb();
    const svc = createWebhooksService(db);
    svc.create({ url: 'https://old.example.com/hook' });
    svc.create({ url: 'https://phone.example.com/hook', phone: '919812345678', allEvents: true });
    const opted = svc.create({ url: 'https://whatodo.example.com/hook', allEvents: true });

    expect(svc.getAllEvents().map((w) => w.id)).toEqual([opted.id]);
    expect(svc.getByPhone('919812345678')).toHaveLength(3);
  });
});
