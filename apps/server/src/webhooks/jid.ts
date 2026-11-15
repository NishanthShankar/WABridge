import type makeWASocket from '@whiskeysockets/baileys';

type WASocket = ReturnType<typeof makeWASocket>;

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

/** "919812345678:12@s.whatsapp.net" -> "919812345678" */
export function jidToPhone(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/**
 * Accept a phone number ("+91 98123 45678", "919812345678") or a full JID and return a JID.
 * Returns null for input that is neither.
 */
export function toJid(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.includes('@')) {
    return /^[0-9A-Za-z.:_-]+@(s\.whatsapp\.net|lid|g\.us)$/.test(trimmed)
      ? trimmed
      : null;
  }
  const digits = trimmed.replace(/[\s()+-]/g, '');
  return /^\d{6,15}$/.test(digits) ? `${digits}@s.whatsapp.net` : null;
}

/** This account's own JIDs (phone and LID form, device suffix removed). */
export function ownJids(sock: WASocket): Set<string> {
  const own = new Set<string>();
  const user = sock.user;
  if (user?.id) own.add(`${jidToPhone(user.id)}@s.whatsapp.net`);
  if (user?.lid) own.add(`${jidToPhone(user.lid)}@lid`);
  return own;
}
