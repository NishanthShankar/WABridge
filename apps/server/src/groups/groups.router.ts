import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { listGroupsSchema } from './groups.schema.js';
import { createGroupsService } from './groups.service.js';
import { getContext } from '../context.js';
import { jidToPhone, ownJids } from '../webhooks/jid.js';

/**
 * Create the groups API router.
 *
 * Routes:
 * - POST /sync  — Sync groups from WhatsApp
 * - GET /       — List groups (query: search, limit, offset)
 * - GET /:id    — Get single group by JID
 * - GET /:id/participants — Live member list from WhatsApp (phone, LID, admin)
 */
export function createGroupsRouter() {
  const router = new Hono();

  function getService(c: Parameters<typeof getContext>[0]) {
    const ctx = getContext(c);
    return createGroupsService(ctx.db, ctx.getSocket);
  }

  // SYNC groups from WhatsApp
  router.post('/sync', async (c) => {
    try {
      const service = getService(c);
      const result = await service.syncGroups();
      return c.json(result);
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'WhatsApp not connected') {
        return c.json({ error: message }, 503);
      }
      return c.json({ error: message }, 500);
    }
  });

  // LIST groups
  router.get(
    '/',
    zValidator('query', listGroupsSchema),
    async (c) => {
      const service = getService(c);
      const filters = c.req.valid('query');
      const result = service.list(filters);
      return c.json(result);
    },
  );

  // GET live participants (not stored; asked from WhatsApp on each call)
  router.get('/:id/participants', async (c) => {
    const { getSocket } = getContext(c);
    const sock = getSocket();
    if (!sock) return c.json({ error: 'WhatsApp not connected' }, 503);
    const id = c.req.param('id');
    if (!id.endsWith('@g.us')) return c.json({ error: 'Not a group JID' }, 400);
    try {
      const meta = await sock.groupMetadata(id);
      const own = ownJids(sock);
      const participants = await Promise.all(
        meta.participants.map(async (p) => {
          let pn = p.phoneNumber ?? (p.id.endsWith('@s.whatsapp.net') ? p.id : null);
          if (!pn && p.id.endsWith('@lid')) {
            pn = await sock.signalRepository.lidMapping.getPNForLID(p.id).catch(() => null);
          }
          const lid = p.lid ?? (p.id.endsWith('@lid') ? p.id : null);
          return {
            jid: p.id,
            phone: pn ? jidToPhone(pn) : null,
            lid,
            admin: p.admin ?? null,
            isMe:
              (!!pn && own.has(`${jidToPhone(pn)}@s.whatsapp.net`)) ||
              (!!lid && own.has(`${jidToPhone(lid)}@lid`)),
          };
        }),
      );
      return c.json({ id: meta.id, name: meta.subject ?? null, participants });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // GET single group
  router.get('/:id', async (c) => {
    const service = getService(c);
    const id = c.req.param('id');
    const group = service.getById(id);
    if (!group) return c.json({ error: 'Group not found' }, 404);
    return c.json(group);
  });

  return router;
}
