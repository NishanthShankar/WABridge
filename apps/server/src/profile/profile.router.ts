import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { getContext } from '../context.js';
import { fetchImage } from '../groups/group-admin.js';
import { jidToPhone } from '../webhooks/jid.js';
import {
  businessProfileSchema,
  imageUrlSchema,
  profileSchema,
  readProfile,
  toWhatsAppHours,
} from './profile.js';

const notConnected = {
  error: 'not_connected',
  message: 'WhatsApp not connected',
} as const;

/** fetchImage's 400/422 for a bad URL or file, 502 when WhatsApp refused. */
const imageStatus = (err: unknown) => {
  const code = (err as { statusCode?: number }).statusCode;
  return code === 400 || code === 422 ? code : 502;
};

/**
 * /api/profile: how this account appears to the people it writes to.
 *
 * - GET    /                  name, about, picture and (business accounts) the business profile
 * - PATCH  /                  change the name and/or about text
 * - PUT    /picture           set the profile picture from an image URL
 * - DELETE /picture           remove it
 * - PATCH  /business          description, address, email, websites, opening hours
 * - PUT    /business/cover    set the business cover photo from an image URL
 *
 * Everything here is public: every chat and customer sees it.
 */
export function createProfileRouter() {
  const router = new Hono();

  router.get('/', async (c) => {
    const sock = getContext(c).getSocket();
    if (!sock) return c.json(notConnected, 503);
    const profile = await readProfile(sock);
    if (!profile) return c.json(notConnected, 503);
    return c.json(profile);
  });

  router.patch('/', zValidator('json', profileSchema), async (c) => {
    const sock = getContext(c).getSocket();
    if (!sock) return c.json(notConnected, 503);
    const { name, about } = c.req.valid('json');
    const applied: string[] = [];
    const failed: Array<{ field: string; error: string }> = [];
    for (const [field, run] of [
      ['name', name === undefined ? null : () => sock.updateProfileName(name)],
      [
        'about',
        about === undefined ? null : () => sock.updateProfileStatus(about),
      ],
    ] as const) {
      if (!run) continue;
      try {
        await run();
        applied.push(field);
      } catch (err) {
        failed.push({ field, error: (err as Error).message });
      }
    }
    if (!applied.length)
      return c.json(
        {
          error: 'not_changed',
          message: 'WhatsApp refused every change',
          applied,
          failed,
        },
        502,
      );
    return c.json({ applied, failed });
  });

  router.put('/picture', zValidator('json', imageUrlSchema), async (c) => {
    const sock = getContext(c).getSocket();
    if (!sock?.user?.id) return c.json(notConnected, 503);
    const jid = `${jidToPhone(sock.user.id)}@s.whatsapp.net`;
    try {
      await sock.updateProfilePicture(
        jid,
        await fetchImage(c.req.valid('json').imageUrl),
      );
    } catch (err) {
      return c.json(
        { error: 'picture_not_set', message: (err as Error).message },
        imageStatus(err),
      );
    }
    const pictureUrl = await sock
      .profilePictureUrl(jid, 'image')
      .catch(() => null);
    return c.json({ set: true, pictureUrl: pictureUrl ?? null });
  });

  router.delete('/picture', async (c) => {
    const sock = getContext(c).getSocket();
    if (!sock?.user?.id) return c.json(notConnected, 503);
    try {
      await sock.removeProfilePicture(
        `${jidToPhone(sock.user.id)}@s.whatsapp.net`,
      );
    } catch (err) {
      return c.json(
        { error: 'picture_not_removed', message: (err as Error).message },
        502,
      );
    }
    return c.json({ removed: true });
  });

  router.patch(
    '/business',
    zValidator('json', businessProfileSchema),
    async (c) => {
      const sock = getContext(c).getSocket();
      if (!sock) return c.json(notConnected, 503);
      const input = c.req.valid('json');
      try {
        await sock.updateBussinesProfile({
          description: input.description,
          address: input.address,
          email: input.email,
          websites: input.websites,
          hours: input.hours ? toWhatsAppHours(input.hours) : undefined,
        });
      } catch (err) {
        return c.json(
          {
            error: 'not_changed',
            message: `${(err as Error).message} (is this a WhatsApp Business account?)`,
          },
          502,
        );
      }
      const profile = await readProfile(sock);
      return c.json({
        updated: Object.keys(input),
        business: profile?.business ?? null,
      });
    },
  );

  router.put(
    '/business/cover',
    zValidator('json', imageUrlSchema),
    async (c) => {
      const sock = getContext(c).getSocket();
      if (!sock) return c.json(notConnected, 503);
      try {
        const id = await sock.updateCoverPhoto(
          await fetchImage(c.req.valid('json').imageUrl),
        );
        return c.json({ set: true, coverPhotoId: String(id) });
      } catch (err) {
        return c.json(
          { error: 'cover_not_set', message: (err as Error).message },
          imageStatus(err),
        );
      }
    },
  );

  return router;
}
