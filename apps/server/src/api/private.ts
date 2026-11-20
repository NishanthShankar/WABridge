import type { MiddlewareHandler } from 'hono/types';
import { getContext, setContext } from '../context.js';
import {
  PrivateUnavailableError,
  isDiskWriteRefused,
  privateContext,
} from '../db/private.js';
import { STARTED_AT } from '../webhooks/boot.js';

const HEADER = 'x-private';

function truthy(value: string | undefined): boolean {
  return !!value && /^(1|true|yes)$/i.test(value.trim());
}

/**
 * Private mode, chosen by the client per request and by nothing else: no server setting.
 *
 * A request is private when it carries the header `X-Private: true`, or a JSON body whose top
 * level has `"private": true`. It then runs against the account's private database (see
 * db/private.ts): what it sends is kept in memory only, and nothing reaches the disk.
 *
 * Works for every /api route, including extensions, because it swaps the context the route
 * reads rather than changing the route. A route that has to store something on disk (create a
 * webhook, a template, a recurring rule) answers 409 not_available_private.
 *
 * Mount after the middleware that sets the AppContext.
 */
export function privateMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    let wanted = truthy(c.req.header(HEADER));
    if (
      !wanted &&
      c.req.method !== 'GET' &&
      c.req.method !== 'HEAD' &&
      (c.req.header('content-type') ?? '').includes('application/json')
    ) {
      // Hono keeps the parsed body, so the route's own validator reads it again for free
      const body = (await c.req.json().catch(() => null)) as {
        private?: unknown;
      } | null;
      wanted = !!body && typeof body === 'object' && body.private === true;
    }
    if (!wanted) return next();

    try {
      setContext(c, privateContext(getContext(c)));
    } catch (err) {
      if (err instanceof PrivateUnavailableError)
        return c.json(
          {
            error: 'private_unavailable',
            message: 'Private mode is not available on this server',
          },
          501,
        );
      throw err;
    }

    await next();

    // A route that tried to store something on disk: SQLite refused. Say so plainly, whether
    // the route let the error through or turned it into its own 500.
    let refused = !!c.error && isDiskWriteRefused(c.error);
    if (!refused && c.res.status >= 500) {
      const text = await c.res
        .clone()
        .text()
        .catch(() => '');
      refused = /readonly database/i.test(text);
    }
    if (refused) {
      c.res = undefined;
      c.res = c.json(
        {
          error: 'not_available_private',
          message:
            'This request has to store data on the server, so it cannot be private. Send it without private.',
        },
        409,
      );
      return;
    }
    // A private GET for something this server no longer holds: say that plainly, so the
    // client can tell "lost in a restart, or dropped after a day" from "still queued".
    if (c.req.method === 'GET' && c.res.status === 404) {
      c.res = undefined;
      c.res = c.json(
        {
          error: 'unknown_private',
          message:
            'Nothing private with this id is held in memory. Private items are gone after a restart, and a finished message is dropped after 24 hours.',
          startedAt: STARTED_AT.toISOString(),
        },
        404,
      );
    }
    c.res.headers.set('X-Private', 'true');
  };
}
