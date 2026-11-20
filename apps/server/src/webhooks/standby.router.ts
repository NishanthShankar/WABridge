import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../context.js';
import { accountPhoneOf, isStandby, setStandby } from './account.js';

/**
 * /api/standby: put this number on standby, or make it live again.
 *
 * - GET /  { standby, accountPhone }
 * - PUT /  { "standby": true | false }
 *
 * On standby the number stays connected and in its groups but sends no webhooks.
 */
export function createStandbyRouter() {
  const router = new Hono();

  router.get('/', (c) => {
    const { db } = getContext(c);
    return c.json({ standby: isStandby(db), accountPhone: accountPhoneOf(db) });
  });

  router.put(
    '/',
    zValidator('json', z.object({ standby: z.boolean() })),
    (c) => {
      const { db } = getContext(c);
      setStandby(db, c.req.valid('json').standby);
      return c.json({
        standby: isStandby(db),
        accountPhone: accountPhoneOf(db),
      });
    },
  );

  return router;
}
