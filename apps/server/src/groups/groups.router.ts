import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createGroupSchema, groupSettingsSchema, listGroupsSchema, updateParticipantsSchema } from './groups.schema.js';
import { applyGroupSettings, createGroup, GroupCapError, inviteLink, readGroupSettings, updateParticipants } from './group-admin.js';
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
 * - POST /       — Create a group (capped per day: groups.create_daily_cap)
 * - POST /:id/participants — Add, remove, promote or demote members
 * - GET /:id/invite — The group's invite link (this account must be admin)
 * - GET /:id/settings — Who can add members, edit group info, send messages
 * - PATCH /:id/settings — Change those (this account must be admin)
 */
export function createGroupsRouter() {
  const router = new Hono();

  function getService(c: Parameters<typeof getContext>[0]) {
    const ctx = getContext(c);
    return createGroupsService(ctx.db, ctx.getSocket);
  }

  // CREATE a group (this account becomes admin)
  router.post('/', zValidator('json', createGroupSchema), async (c) => {
    const { db, getSocket, config } = getContext(c);
    const sock = getSocket();
    if (!sock) return c.json({ error: 'WhatsApp not connected' }, 503);
    try {
      const result = await createGroup(db, sock, config.groups.create_daily_cap, c.req.valid('json'));
      return c.json(result, 201);
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      if (err instanceof GroupCapError) return c.json({ error: 'group_cap_reached', message: e.message }, 429);
      return c.json({ error: e.message }, (e.statusCode as 400) ?? 502);
    }
  });

  // ADD / REMOVE / PROMOTE / DEMOTE members
  router.post('/:id/participants', zValidator('json', updateParticipantsSchema), async (c) => {
    const { getSocket } = getContext(c);
    const sock = getSocket();
    if (!sock) return c.json({ error: 'WhatsApp not connected' }, 503);
    const id = c.req.param('id');
    if (!id.endsWith('@g.us')) return c.json({ error: 'Not a group JID' }, 400);
    try {
      return c.json(await updateParticipants(sock, id, c.req.valid('json')));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // SETTINGS: read
  router.get('/:id/settings', async (c) => {
    const { getSocket } = getContext(c);
    const sock = getSocket();
    if (!sock) return c.json({ error: 'WhatsApp not connected' }, 503);
    const id = c.req.param('id');
    if (!id.endsWith('@g.us')) return c.json({ error: 'Not a group JID' }, 400);
    try {
      return c.json({ id, settings: await readGroupSettings(sock, id) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // SETTINGS: change (only the fields given)
  router.patch('/:id/settings', zValidator('json', groupSettingsSchema), async (c) => {
    const { getSocket } = getContext(c);
    const sock = getSocket();
    if (!sock) return c.json({ error: 'WhatsApp not connected' }, 503);
    const id = c.req.param('id');
    if (!id.endsWith('@g.us')) return c.json({ error: 'Not a group JID' }, 400);
    const result = await applyGroupSettings(sock, id, c.req.valid('json'));
    const settings = await readGroupSettings(sock, id).catch(() => null);
    if (result.applied.length === 0)
      return c.json({ error: 'settings_not_changed', message: 'WhatsApp refused every change (is this account an admin?)', ...result, settings }, 502);
    return c.json({ id, ...result, settings });
  });

  // INVITE link
  router.get('/:id/invite', async (c) => {
    const { getSocket } = getContext(c);
    const sock = getSocket();
    if (!sock) return c.json({ error: 'WhatsApp not connected' }, 503);
    const id = c.req.param('id');
    if (!id.endsWith('@g.us')) return c.json({ error: 'Not a group JID' }, 400);
    const link = await inviteLink(sock, id);
    if (!link) return c.json({ error: 'Could not get the invite link (is this account an admin?)' }, 502);
    return c.json({ id, inviteLink: link });
  });

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
