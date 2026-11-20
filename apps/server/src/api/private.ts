import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono/types';
import { type AppContext, getContext, setContext } from '../context.js';
import { diskDbOf } from '../db/private.js';
import {
  PrivateUnavailableError,
  isDiskWriteRefused,
  privateContext,
} from '../db/private.js';
import { contacts } from '../db/schema.js';
import {
  type NoStoreRule,
  hasNoStoreRules,
  noStoreRuleFor,
} from '../messages/no-store.js';
import { STARTED_AT } from '../webhooks/boot.js';
import { toJid } from '../webhooks/jid.js';

const HEADER = 'x-private';

const TARGET_KEYS = ['chatId', 'phone', 'groupId', 'to', 'jid'] as const;

/**
 * Does this request send into a chat the server keeps nothing of (messages/no-store.ts)?
 * Looks at the usual target fields of the body, and of each entry of a bulk request.
 * Returns the rule that says so. If a contact cannot be looked up, the answer is yes.
 */
function noStoreTarget(
  ctx: AppContext,
  body: Record<string, unknown>,
  path: string,
): NoStoreRule | null {
  const entries = [
    body,
    ...(Array.isArray(body.messages)
      ? (body.messages as unknown[]).filter(
          (m): m is Record<string, unknown> => !!m && typeof m === 'object',
        )
      : []),
  ];
  for (const entry of entries) {
    const jids: string[] = [];
    try {
      for (const key of TARGET_KEYS) {
        const value = entry[key];
        const jid = typeof value === 'string' ? toJid(value) : null;
        if (jid) jids.push(jid);
      }
      if (typeof entry.contactId === 'string') {
        const contact = diskDbOf(ctx.db)
          .select({ phone: contacts.phone })
          .from(contacts)
          .where(eq(contacts.id, entry.contactId))
          .get();
        const jid = contact ? toJid(contact.phone) : null;
        if (jid) jids.push(jid);
      }
    } catch {
      return UNKNOWN_TARGET;
    }
    const rule = noStoreRuleFor(ctx.db, jids, path);
    if (rule) return rule;
  }
  return null;
}

/** Where a request goes could not be worked out: handled as if nothing may be kept. */
const UNKNOWN_TARGET: NoStoreRule = {
  reason: 'unknown-target',
  applies: () => true,
};

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
    let forced: NoStoreRule | null = null;
    if (
      c.req.method !== 'GET' &&
      c.req.method !== 'HEAD' &&
      (c.req.header('content-type') ?? '').includes('application/json')
    ) {
      // Hono keeps the parsed body, so the route's own validator reads it again for free
      const body = (await c.req.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (body && typeof body === 'object') {
        wanted = wanted || body.private === true;
        // Whatever is sent into a chat the server keeps nothing of is private, asked for or
        // not: a forgotten flag must not leave its text on this server's disk
        if (!wanted && hasNoStoreRules()) {
          forced = noStoreTarget(getContext(c), body, c.req.path);
          wanted = !!forced;
        }
      }
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
          message: forced
            ? (forced.messages?.notPrivate ??
              'This request has to store data on the server, and nothing sent into this chat is ever stored. It cannot be done for this chat.')
            : 'This request has to store data on the server, so it cannot be private. Send it without private.',
        },
        409,
      );
      return;
    }
    if (forced) c.res.headers.set('X-Private-Reason', forced.reason);
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
