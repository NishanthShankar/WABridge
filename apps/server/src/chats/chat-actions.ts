import type makeWASocket from '@whiskeysockets/baileys';
import type { ChatModification } from '@whiskeysockets/baileys';
import { z } from 'zod';
import { lastMessageIn } from '../messages/recent-messages.js';
import { isGroupJid } from '../webhooks/jid.js';

type WASocket = ReturnType<typeof makeWASocket>;

/** WhatsApp's disappearing-message timers, in seconds. */
export const DISAPPEARING = {
  off: 0,
  '24h': 86_400,
  '7d': 604_800,
  '90d': 7_776_000,
} as const;
export type Disappearing = keyof typeof DISAPPEARING;
const disappearingEnum = z.enum(
  Object.keys(DISAPPEARING) as [Disappearing, ...Disappearing[]],
);

/** How long to mute: WhatsApp offers 8 hours, 1 week or always. false unmutes. */
export const MUTE = {
  '8h': 8 * 3_600_000,
  '1w': 7 * 86_400_000,
  always: -1,
} as const;
type Mute = keyof typeof MUTE;

/**
 * PATCH /api/chats/:id. Each field given is applied; the rest stay as they are. These change
 * how the chat looks on this account's phone (and linked devices). Only disappearing is seen
 * by the other side.
 */
export const chatActionsSchema = z
  .object({
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    muted: z
      .union([z.enum(Object.keys(MUTE) as [Mute, ...Mute[]]), z.literal(false)])
      .optional(),
    /** true: clear the unread badge. false: mark as unread. No read receipt is sent. */
    read: z.boolean().optional(),
    /** Turn on a disappearing-messages timer for this chat or group (group: admin, if restricted) */
    disappearing: disappearingEnum.optional(),
    /**
     * WhatsApp's "advanced chat privacy": while on, people in the chat can't export it or
     * auto-save its media. Seen by the other side.
     */
    limitSharing: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message:
      'Give pinned, archived, muted, read, disappearing or limitSharing',
  });

/** POST /api/chats/:id/phone-number */
export const phoneNumberSchema = z.object({
  /** share: show this account's number to the chat. request: ask the chat for theirs. */
  action: z.enum(['share', 'request']),
});

export const defaultDisappearingSchema = z.object({
  disappearing: disappearingEnum,
});

export type ChatActions = z.infer<typeof chatActionsSchema>;
type Step = keyof ChatActions;

/** Apply each requested change; the ones WhatsApp refused come back in failed. */
export async function applyChatActions(
  sock: WASocket,
  jid: string,
  candidates: string[],
  wanted: ChatActions,
) {
  // Archive and mark-read name the last message of the chat, as the phone does.
  const last = lastMessageIn(sock, candidates);
  const lastMessages = last
    ? [{ key: last.key, messageTimestamp: last.messageTimestamp }]
    : [];
  const modify = (mod: ChatModification) => () => sock.chatModify(mod, jid);

  const steps: Array<[Step, () => Promise<unknown>]> = [];
  if (wanted.pinned !== undefined)
    steps.push(['pinned', modify({ pin: wanted.pinned })]);
  if (wanted.archived !== undefined)
    steps.push([
      'archived',
      modify({ archive: wanted.archived, lastMessages }),
    ]);
  if (wanted.muted !== undefined) {
    const m = wanted.muted;
    steps.push([
      'muted',
      modify({
        mute:
          m === false
            ? null
            : m === 'always'
              ? MUTE.always
              : Date.now() + MUTE[m],
      }),
    ]);
  }
  if (wanted.read !== undefined)
    steps.push(['read', modify({ markRead: wanted.read, lastMessages })]);
  if (wanted.disappearing !== undefined) {
    const seconds = DISAPPEARING[wanted.disappearing];
    steps.push([
      'disappearing',
      isGroupJid(jid)
        ? () => sock.groupToggleEphemeral(jid, seconds)
        : () =>
            sock.sendMessage(jid, {
              disappearingMessagesInChat: seconds || false,
            }),
    ]);
  }

  if (wanted.limitSharing !== undefined) {
    const on = wanted.limitSharing;
    steps.push([
      'limitSharing',
      () => sock.sendMessage(jid, { limitSharing: on }),
    ]);
  }

  const applied: Step[] = [];
  const failed: Array<{ action: Step; error: string }> = [];
  for (const [action, run] of steps) {
    try {
      await run();
      applied.push(action);
    } catch (err) {
      failed.push({ action, error: (err as Error).message });
    }
  }
  return { applied, failed };
}
