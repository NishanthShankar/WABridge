import type makeWASocket from '@whiskeysockets/baileys';
import type { WAMessageKey, proto } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { createDatabase } from '../db/client.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;

/** Which chat an incoming message belongs to, before anything has looked at the message. */
export interface IncomingChat {
  sock: WASocket;
  db: Database;
  logger: Logger;
  chatJid: string;
  /** A 1:1 chat's other JID (phone or LID), when WhatsApp gave one */
  altJid: string | null;
  isGroup: boolean;
}

/** What is known about a message without reading it. */
export interface IncomingStub {
  key: WAMessageKey;
  chatJid: string;
  isGroup: boolean;
  senderPhone: string;
  senderLid: string | null;
}

/** A new message, an edit or a delete, as the server's own handling would see it. */
export interface IncomingMessage extends IncomingStub {
  msg: proto.IWebMessageInfo;
  /** The message with its wrappers (view once, ephemeral, ...) removed */
  content: proto.IMessage;
  contentType: keyof proto.IMessage | undefined;
  isEdit: boolean;
  isRevoke: boolean;
  /** Carry out the reply actions a webhook answered with (reply, react, read, ...) */
  applyReplyActions(actions: unknown): Promise<void>;
}

/**
 * An extension's claim on a chat's incoming messages. The server then delivers nothing of a
 * message, edit or delete from that chat itself: the extension does, in its own way.
 * Poll votes, event answers and reactions are still delivered by the server.
 */
export interface IncomingClaim {
  /** Extra fields on what the server still delivers from this chat (votes, answers, reactions) */
  fields?: Record<string, unknown>;
  /** Leave the sender's profile name and the group's name out of those */
  anonymous?: boolean;
  /** A message, edit or delete. The server delivers nothing of it, whatever this does. */
  take(message: IncomingMessage): Promise<void>;
  /** Something WhatsApp delivered that could not be decrypted */
  unreadable?(stub: IncomingStub): Promise<void>;
}

/**
 * Asked for every incoming message before the server handles it. Return a claim to take the
 * chat's messages, or null to leave them to the server. May wait (for example for a group
 * that is still being set up). If it throws, the message is not delivered at all: an
 * extension that guards a chat is never bypassed by its own failure.
 */
export type IncomingHook = (
  chat: IncomingChat,
) => Promise<IncomingClaim | null> | IncomingClaim | null;

const hooks: IncomingHook[] = [];

export function registerIncomingHook(hook: IncomingHook): void {
  if (!hooks.includes(hook)) hooks.push(hook);
}

/** For tests: forget every hook. */
export function clearIncomingHooks(): void {
  hooks.length = 0;
}

/** The first claim on this chat, or null. Throws when a hook does. */
export async function claimIncoming(
  chat: IncomingChat,
): Promise<IncomingClaim | null> {
  for (const hook of hooks) {
    const claim = await hook(chat);
    if (claim) return claim;
  }
  return null;
}
