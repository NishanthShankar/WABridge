import { zValidator } from '@hono/zod-validator';
import type { WAMessageKey } from '@whiskeysockets/baileys';
import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../context.js';
import { diskDbOf } from '../db/private.js';
import { contacts } from '../db/schema.js';
import { toJid } from '../webhooks/jid.js';

export const STATUS_JID = 'status@broadcast';
/** WhatsApp encrypts a Status for every viewer's devices, so a very long list is slow. */
export const MAX_AUDIENCE = 256;
/** A Status lasts 24 hours; after that there is nothing to delete. */
const STATUS_LIFETIME_MS = 24 * 3_600_000;

const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), {
    message: 'mediaUrl must be http or https',
  });

export const postStatusSchema = z
  .object({
    /** The text of a text Status, or the caption of an image or video Status */
    text: z.string().min(1).max(700).optional(),
    mediaUrl: httpUrl.optional(),
    mediaType: z.enum(['image', 'video']).optional(),
    /** Text Status only: background colour, e.g. "#128C7E" */
    backgroundColor: z
      .string()
      .regex(/^#?[0-9a-fA-F]{6}$/)
      .optional(),
    /** Text Status only: WhatsApp font 0-5 */
    font: z.number().int().min(0).max(5).optional(),
    /** Who may see it: phones or JIDs. They also need this number saved to see it. */
    audience: z
      .array(z.string().min(3).max(64))
      .min(1)
      .max(MAX_AUDIENCE)
      .optional(),
    /** Instead of audience: everyone in this account's contacts (GET /api/contacts) */
    allContacts: z.literal(true).optional(),
  })
  .refine((v) => !!v.text || !!v.mediaUrl, {
    message: 'Give text, mediaUrl or both',
  })
  .refine((v) => !v.mediaUrl === !v.mediaType, {
    message: 'mediaUrl and mediaType go together',
  })
  .refine((v) => !!v.audience !== !!v.allContacts, {
    message: 'Give exactly one of audience or allContacts',
  })
  .refine(
    (v) =>
      !v.mediaUrl || (v.backgroundColor === undefined && v.font === undefined),
    {
      message: 'backgroundColor and font are for text Status only',
    },
  );

/**
 * /api/status: post a Status (the 24 hour stories) to chosen people, and take it down.
 *
 * - POST   /           post a text, image or video Status
 * - DELETE /:statusId  delete it for everyone who could see it (within 24 hours, before a restart)
 */
export function createStatusRouter() {
  const router = new Hono();
  /** Who each Status went to: deleting needs the same list. In memory, 24 hours. */
  const posted = new Map<
    string,
    { audience: string[]; at: number; tenantId: string }
  >();

  router.post('/', zValidator('json', postStatusSchema), async (c) => {
    const { db, getSocket, tenantId } = getContext(c);
    const input = c.req.valid('json');

    const raw = input.allContacts
      ? // The saved contacts, also for a private request (whose own contacts table is empty)
        diskDbOf(db)
          .select({ phone: contacts.phone })
          .from(contacts)
          .all()
          .map((r) => r.phone)
      : (input.audience ?? []);
    const audience = [
      ...new Set(
        raw
          .map((p) => toJid(p))
          .filter((j): j is string => !!j && j.endsWith('@s.whatsapp.net')),
      ),
    ];
    const invalid = (input.audience ?? []).filter((p) => !toJid(p));
    if (!audience.length)
      return c.json(
        {
          error: 'no_audience',
          message: 'Nobody valid to show it to',
          invalid,
        },
        400,
      );
    if (audience.length > MAX_AUDIENCE)
      return c.json(
        {
          error: 'audience_too_large',
          message: `At most ${MAX_AUDIENCE} people per Status (this would be ${audience.length})`,
        },
        400,
      );

    const sock = getSocket();
    if (!sock)
      return c.json(
        { error: 'not_connected', message: 'WhatsApp not connected' },
        503,
      );

    const content = input.mediaUrl
      ? input.mediaType === 'video'
        ? { video: { url: input.mediaUrl }, caption: input.text }
        : { image: { url: input.mediaUrl }, caption: input.text }
      : { text: input.text as string };
    const style = input.mediaUrl
      ? {}
      : {
          backgroundColor: input.backgroundColor
            ? `#${input.backgroundColor.replace('#', '')}`.toUpperCase()
            : '#128C7E',
          font: input.font ?? 0,
        };
    try {
      const sent = await sock.sendMessage(STATUS_JID, content, {
        statusJidList: audience,
        broadcast: true,
        ...style,
      });
      const statusId = sent?.key?.id ?? null;
      if (!statusId)
        return c.json(
          { error: 'send_failed', message: 'WhatsApp did not return an id' },
          502,
        );
      const now = Date.now();
      posted.set(statusId, { audience, at: now, tenantId });
      for (const [id, p] of posted)
        if (now - p.at > STATUS_LIFETIME_MS) posted.delete(id);
      return c.json({ statusId, audienceCount: audience.length, invalid }, 201);
    } catch (err) {
      return c.json(
        { error: 'send_failed', message: (err as Error).message },
        502,
      );
    }
  });

  router.delete('/:statusId', async (c) => {
    const { getSocket, tenantId } = getContext(c);
    const statusId = c.req.param('statusId');
    const entry = posted.get(statusId);
    if (
      !entry ||
      entry.tenantId !== tenantId ||
      Date.now() - entry.at > STATUS_LIFETIME_MS
    )
      return c.json(
        {
          error: 'not_found',
          message:
            'No Status with this id posted in the last 24 hours since the server started',
        },
        404,
      );
    const sock = getSocket();
    if (!sock)
      return c.json(
        { error: 'not_connected', message: 'WhatsApp not connected' },
        503,
      );
    const key: WAMessageKey = {
      remoteJid: STATUS_JID,
      id: statusId,
      fromMe: true,
    };
    try {
      await sock.sendMessage(
        STATUS_JID,
        { delete: key },
        { statusJidList: entry.audience, broadcast: true },
      );
    } catch (err) {
      return c.json(
        { error: 'send_failed', message: (err as Error).message },
        502,
      );
    }
    posted.delete(statusId);
    return c.json({ statusId, deleted: true });
  });

  return router;
}
