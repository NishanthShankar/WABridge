import { zValidator } from '@hono/zod-validator';
import type { NewsletterMetadata } from '@whiskeysockets/baileys';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppContext, getContext } from '../context.js';
import { sessionMeta } from '../db/schema.js';
import { fetchImage } from '../groups/group-admin.js';
import { errorMessage } from '../net/safe-fetch.js';
import { buildMessagePayload } from '../scheduler/message-payload.js';

/** New channels per account per day (IST). WhatsApp flags accounts that create many. */
export const CHANNEL_CREATE_DAILY_CAP = 2;
/** Posts per channel per minute, so a loop in a client can't flood followers. */
const POSTS_PER_MINUTE = 6;

const CHANNEL_JID = /^\d+@newsletter$/;

/** "120363…@newsletter", or the digits alone. null when it is neither. */
export function channelJid(raw: string): string | null {
  const s = raw.trim();
  if (CHANNEL_JID.test(s)) return s;
  return /^\d{10,}$/.test(s) ? `${s}@newsletter` : null;
}

/** The invite code of a channel link (https://whatsapp.com/channel/<code>), or the bare code. */
export function channelInviteCode(raw: string): string | null {
  const s = raw.trim();
  const m = s.match(
    /^https?:\/\/(?:www\.)?whatsapp\.com\/channel\/([\w-]{10,64})/i,
  );
  if (m) return m[1];
  return /^[\w-]{10,64}$/.test(s) ? s : null;
}

const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), { message: 'Must be http or https' });

export const createChannelSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2048).optional(),
});

export const updateChannelSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(2048).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'Give name or description',
  });

export const channelPostSchema = z
  .object({
    /** The post, or the caption of the image or video */
    text: z.string().min(1).max(4096).optional(),
    mediaUrl: httpUrl.optional(),
    mediaType: z.enum(['image', 'video']).optional(),
  })
  .refine((v) => !!v.text || !!v.mediaUrl, {
    message: 'Give text, mediaUrl or both',
  })
  .refine((v) => !v.mediaUrl === !v.mediaType, {
    message: 'mediaUrl and mediaType go together',
  });

const imageUrlSchema = z.object({ imageUrl: httpUrl });

/** WhatsApp sends text fields as { text } and numbers as strings; older shapes are flat. */
const textOf = (v: unknown): string | null =>
  typeof v === 'string'
    ? v
    : v && typeof (v as { text?: unknown }).text === 'string'
      ? (v as { text: string }).text
      : null;
const numberOf = (v: unknown): number | null => {
  const n = typeof v === 'string' && v !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** One shape for a channel, whether WhatsApp answered with its raw form or Baileys' parsed one. */
export function describe(meta: NewsletterMetadata) {
  const m = meta as unknown as Record<string, unknown>;
  const thread = (m.thread_metadata ?? {}) as Record<string, unknown>;
  const viewer = (m.viewer_metadata ?? {}) as Record<string, unknown>;
  const picture = (thread.picture ?? m.picture ?? {}) as Record<string, unknown>;
  const invite = textOf(thread.invite ?? m.invite);
  const created = numberOf(thread.creation_time ?? m.creation_time);
  const path = textOf(picture.direct_path ?? picture.directPath);
  return {
    id: meta.id,
    name: textOf(thread.name) ?? textOf(m.name) ?? '',
    description: textOf(thread.description) ?? textOf(m.description),
    link: invite ? `https://whatsapp.com/channel/${invite}` : null,
    followers: numberOf(thread.subscribers_count ?? m.subscribers),
    verified: (thread.verification ?? m.verification) === 'VERIFIED',
    /** This account's part in the channel: owner, admin, subscriber or guest (not following) */
    role: textOf(viewer.role)?.toLowerCase() ?? null,
    muted: (viewer.mute ?? m.mute_state) === 'ON',
    createdAt: created ? new Date(created * 1000).toISOString() : null,
    pictureUrl:
      textOf(picture.url) ?? (path ? `https://pps.whatsapp.net${path}` : null),
  };
}

const istDay = (now = Date.now()) =>
  new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10);

function createdToday(db: AppContext['db']) {
  const key = `channels_created:${istDay()}`;
  const row = db
    .select()
    .from(sessionMeta)
    .where(eq(sessionMeta.key, key))
    .get();
  return { key, count: row ? Number(row.value) || 0 : 0 };
}

const notConnected = {
  error: 'not_connected',
  message: 'WhatsApp not connected',
} as const;
const invalidId = {
  error: 'invalid_channel',
  message: 'Not a channel id: expected "<digits>@newsletter"',
} as const;

/**
 * /api/channels: WhatsApp Channels (one-way broadcasts that anyone can follow).
 *
 * - GET    /lookup?invite=…   read a channel from its link or invite code
 * - GET    /:id               read a channel by id
 * - POST   /                  create a channel owned by this account (2 a day)
 * - PATCH  /:id               change the name and/or description (owner)
 * - PUT    /:id/picture       set the picture from an image URL (owner)
 * - DELETE /:id/picture       remove the picture (owner)
 * - POST   /:id/follow        follow a channel
 * - DELETE /:id/follow        unfollow it
 * - POST   /:id/messages      post text, an image or a video to a channel this account owns
 */
export function createChannelsRouter() {
  const router = new Hono();
  const posts = new Map<string, number[]>();

  router.get('/lookup', async (c) => {
    const code = channelInviteCode(c.req.query('invite') ?? '');
    if (!code)
      return c.json(
        {
          error: 'invalid_invite',
          message: 'Give invite: a whatsapp.com/channel/… link or its code',
        },
        400,
      );
    const sock = getContext(c).getSocket();
    if (!sock) return c.json(notConnected, 503);
    const meta = await sock
      .newsletterMetadata('invite', code)
      .catch(() => null);
    if (!meta)
      return c.json(
        { error: 'not_found', message: 'No channel with this link' },
        404,
      );
    return c.json(describe(meta));
  });

  router.get('/:id', async (c) => {
    const jid = channelJid(c.req.param('id'));
    if (!jid) return c.json(invalidId, 400);
    const sock = getContext(c).getSocket();
    if (!sock) return c.json(notConnected, 503);
    const meta = await sock.newsletterMetadata('jid', jid).catch(() => null);
    if (!meta)
      return c.json({ error: 'not_found', message: 'No such channel' }, 404);
    return c.json(describe(meta));
  });

  router.post('/', zValidator('json', createChannelSchema), async (c) => {
    const { db, getSocket } = getContext(c);
    const sock = getSocket();
    if (!sock) return c.json(notConnected, 503);
    const { key, count } = createdToday(db);
    if (count >= CHANNEL_CREATE_DAILY_CAP)
      return c.json(
        {
          error: 'daily_cap_reached',
          message: `This account already created ${count} channels today (limit ${CHANNEL_CREATE_DAILY_CAP})`,
        },
        429,
      );
    const { name, description } = c.req.valid('json');
    try {
      const meta = await sock.newsletterCreate(name, description);
      db.insert(sessionMeta)
        .values({ key, value: String(count + 1) })
        .onConflictDoUpdate({
          target: sessionMeta.key,
          set: { value: String(count + 1) },
        })
        .run();
      return c.json(describe(meta), 201);
    } catch (err) {
      return c.json(
        { error: 'not_created', message: (err as Error).message },
        502,
      );
    }
  });

  router.patch('/:id', zValidator('json', updateChannelSchema), async (c) => {
    const jid = channelJid(c.req.param('id'));
    if (!jid) return c.json(invalidId, 400);
    const sock = getContext(c).getSocket();
    if (!sock) return c.json(notConnected, 503);
    const input = c.req.valid('json');
    try {
      await sock.newsletterUpdate(jid, input);
    } catch (err) {
      return c.json(
        {
          error: 'not_changed',
          message: `${(err as Error).message} (only the owner can change a channel)`,
        },
        502,
      );
    }
    return c.json({ id: jid, updated: Object.keys(input) });
  });

  router.put('/:id/picture', zValidator('json', imageUrlSchema), async (c) => {
    const jid = channelJid(c.req.param('id'));
    if (!jid) return c.json(invalidId, 400);
    const sock = getContext(c).getSocket();
    if (!sock) return c.json(notConnected, 503);
    try {
      await sock.newsletterUpdatePicture(
        jid,
        await fetchImage(c.req.valid('json').imageUrl),
      );
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      return c.json(
        { error: 'picture_not_set', message: (err as Error).message },
        code === 400 || code === 422 ? code : 502,
      );
    }
    return c.json({ id: jid, set: true });
  });

  router.delete('/:id/picture', async (c) => {
    const jid = channelJid(c.req.param('id'));
    if (!jid) return c.json(invalidId, 400);
    const sock = getContext(c).getSocket();
    if (!sock) return c.json(notConnected, 503);
    try {
      await sock.newsletterRemovePicture(jid);
    } catch (err) {
      return c.json(
        { error: 'not_changed', message: (err as Error).message },
        502,
      );
    }
    return c.json({ id: jid, removed: true });
  });

  for (const follow of [true, false]) {
    router.on(follow ? 'POST' : 'DELETE', '/:id/follow', async (c) => {
      const jid = channelJid(c.req.param('id'));
      if (!jid) return c.json(invalidId, 400);
      const sock = getContext(c).getSocket();
      if (!sock) return c.json(notConnected, 503);
      try {
        await (follow
          ? sock.newsletterFollow(jid)
          : sock.newsletterUnfollow(jid));
      } catch (err) {
        return c.json(
          { error: 'not_changed', message: (err as Error).message },
          502,
        );
      }
      return c.json({ id: jid, following: follow });
    });
  }

  router.post(
    '/:id/messages',
    zValidator('json', channelPostSchema),
    async (c) => {
      const { getSocket, tenantId } = getContext(c);
      const jid = channelJid(c.req.param('id'));
      if (!jid) return c.json(invalidId, 400);
      const sock = getSocket();
      if (!sock) return c.json(notConnected, 503);

      const bucket = `${tenantId}|${jid}`;
      const now = Date.now();
      const recent = (posts.get(bucket) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= POSTS_PER_MINUTE)
        return c.json(
          {
            error: 'too_many_posts',
            message: 'Slow down: too many posts to this channel',
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((recent[0] + 60_000 - now) / 1000),
            ),
          },
          429,
        );
      recent.push(now);
      posts.set(bucket, recent);

      const input = c.req.valid('json');
      try {
        const sent = await sock.sendMessage(
          jid,
          buildMessagePayload(
            input.text ?? '',
            input.mediaUrl,
            input.mediaType,
          ),
        );
        return c.json({ id: jid, messageId: sent?.key?.id ?? null }, 201);
      } catch (err) {
        return c.json(
          {
            error: 'send_failed',
            message: `${errorMessage(err)} (only the owner or an admin can post)`,
          },
          502,
        );
      }
    },
  );

  return router;
}
