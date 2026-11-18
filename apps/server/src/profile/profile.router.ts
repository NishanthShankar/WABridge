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

/** How long to wait for WhatsApp to return the catalog. */
const CATALOG_TIMEOUT_MS = 15_000;

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
 * - GET    /business/catalog  the products of the catalog (business accounts)
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

  // The products of this Business account's catalog: their ids are what a product card needs.
  router.get('/business/catalog', async (c) => {
    const sock = getContext(c).getSocket();
    if (!sock) return c.json(notConnected, 503);
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 50);
    try {
      // WhatsApp can take a minute to answer this for an account without a catalog.
      const answer = await Promise.race([
        sock.getCatalog({ limit, cursor: c.req.query('cursor') || undefined }),
        new Promise<null>((r) => setTimeout(() => r(null), CATALOG_TIMEOUT_MS)),
      ]);
      if (!answer)
        return c.json(
          {
            error: 'catalog_timeout',
            message:
              'WhatsApp did not answer in time. This usually means the account has no catalog.',
          },
          504,
        );
      const { products, nextPageCursor } = answer;
      return c.json({
        products: products.map((p) => ({
          productId: p.id,
          title: p.name,
          description: p.description || null,
          currency: p.currency,
          price: p.price / 1000,
          retailerId: p.retailerId ?? null,
          url: p.url ?? null,
          imageUrl:
            p.imageUrls?.requested ?? Object.values(p.imageUrls ?? {})[0] ?? null,
          availability: p.availability,
          hidden: p.isHidden ?? false,
        })),
        nextCursor: nextPageCursor ?? null,
      });
    } catch (err) {
      return c.json(
        {
          error: 'catalog_unavailable',
          message: `${(err as Error).message} (is this a WhatsApp Business account?)`,
        },
        502,
      );
    }
  });

  return router;
}
