import type { AnyMessageContent } from '@whiskeysockets/baileys';
import { z } from 'zod';

/**
 * Locations and contact cards. Like polls, a queued one is stored in scheduled_messages with
 * mediaType 'location' or 'contact' and its fields as JSON in content.
 */

export const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Shown in bold above the map, e.g. the clinic's name */
  name: z.string().min(1).max(256).optional(),
  /** Shown under the name */
  address: z.string().min(1).max(512).optional(),
});

const contactCardSchema = z.object({
  name: z.string().min(1).max(128),
  /** WhatsApp number with country code: "+91 98123 45678" or "919812345678" */
  phone: z.string().min(6).max(32),
  org: z.string().min(1).max(128).optional(),
  email: z.string().email().max(128).optional(),
});

/** One card, or up to 10 sent together as one message */
export const contactSchema = z.union([
  contactCardSchema,
  z.array(contactCardSchema).min(1).max(10),
]);

export type LocationInput = z.infer<typeof locationSchema>;
export type ContactCard = z.infer<typeof contactCardSchema>;
export type ContactInput = z.infer<typeof contactSchema>;

/** Strip what would break a vCard line. */
const clean = (s: string) => s.replace(/[\r\n;]/g, ' ').trim();

export function buildVcard(card: ContactCard): string {
  const digits = card.phone.replace(/\D/g, '');
  const name = clean(card.name);
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${name}`,
    `N:;${name};;;`,
    ...(card.org ? [`ORG:${clean(card.org)};`] : []),
    `TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`,
    ...(card.email ? [`EMAIL:${clean(card.email)}`] : []),
    'END:VCARD',
  ].join('\n');
}

export function locationPayload(loc: LocationInput): AnyMessageContent {
  return {
    location: {
      degreesLatitude: loc.latitude,
      degreesLongitude: loc.longitude,
      ...(loc.name ? { name: loc.name } : {}),
      ...(loc.address ? { address: loc.address } : {}),
    },
  };
}

export function contactPayload(input: ContactInput): AnyMessageContent {
  const cards = Array.isArray(input) ? input : [input];
  return {
    contacts: {
      displayName:
        cards.length === 1 ? cards[0].name : `${cards.length} contacts`,
      contacts: cards.map((card) => ({ vcard: buildVcard(card) })),
    },
  };
}

/**
 * Fold location / contact from a request into the stored form: { content, mediaType }.
 * Returns null when the request has neither.
 */
export function foldRichContent(input: {
  location?: LocationInput;
  contact?: ContactInput;
}): { content: string; mediaType: 'location' | 'contact' } | null {
  if (input.location)
    return { content: JSON.stringify(input.location), mediaType: 'location' };
  if (input.contact)
    return { content: JSON.stringify(input.contact), mediaType: 'contact' };
  return null;
}
