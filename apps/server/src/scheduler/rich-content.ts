import {
  type AnyMessageContent,
  type WASocket,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import { assertPublicUrl } from '../net/safe-fetch.js';
import { z } from 'zod';

/**
 * Locations, contact cards, events, group invite cards and catalog products. Like polls, a
 * queued one is stored in scheduled_messages with its kind in mediaType and its fields as JSON
 * in content.
 */
export const RICH_KINDS = [
  'location',
  'contact',
  'event',
  'groupInvite',
  'product',
] as const;
export type RichKind = (typeof RICH_KINDS)[number];

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

const isoTime = z.string().datetime({ offset: true });

/** A calendar event card. People answer Going / Maybe / Can't go in WhatsApp. */
export const eventSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(2048).optional(),
    /** ISO time with offset, e.g. "2026-11-20T10:00:00+05:30" */
    startAt: isoTime,
    endAt: isoTime.optional(),
    /** Where it happens: shown on the card, opens the map */
    location: locationSchema.optional(),
    /** Add a WhatsApp call link to the event: "audio" or "video" */
    call: z.enum(['audio', 'video']).optional(),
    /** Let guests bring others */
    extraGuestsAllowed: z.boolean().optional(),
  })
  .refine((e) => !e.endAt || Date.parse(e.endAt) > Date.parse(e.startAt), {
    message: 'endAt must be after startAt',
    path: ['endAt'],
  });

/** How long an invite card stays valid: WhatsApp's own cards last three days. */
export const INVITE_CARD_DAYS = 3;

/** A tappable card inviting someone to a group this account is an admin of. */
export const groupInviteSchema = z.object({
  /** The group: its JID, e.g. "120363012345678901@g.us" */
  groupId: z.string().regex(/^\d+(-\d+)?@g\.us$/, 'Not a group id'),
  /** Shown under the card */
  text: z.string().max(1024).optional(),
});

/** A product of this Business account's catalog, shown as a card. */
export const productSchema = z.object({
  /** The product's id in the catalog (GET /api/profile/business/catalog) */
  productId: z.string().min(1).max(64),
  title: z.string().min(1).max(150),
  description: z.string().max(2048).optional(),
  /** ISO currency code, e.g. "INR" */
  currency: z.string().regex(/^[A-Za-z]{3}$/, 'Three-letter currency code'),
  /** In that currency, e.g. 499 or 499.5 */
  price: z.number().min(0).max(1e9),
  /** Public http(s) URL of the picture on the card */
  imageUrl: z.string().url().max(2048),
  /** The product's page */
  url: z.string().url().max(2048).optional(),
  /** Your own code for the product (SKU) */
  retailerId: z.string().max(100).optional(),
  body: z.string().max(1024).optional(),
  footer: z.string().max(60).optional(),
});

export type EventInput = z.infer<typeof eventSchema>;
export type GroupInviteInput = z.infer<typeof groupInviteSchema>;
export type ProductInput = z.infer<typeof productSchema>;
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

export function eventPayload(event: EventInput): AnyMessageContent {
  return {
    event: {
      name: event.name,
      ...(event.description ? { description: event.description } : {}),
      startDate: new Date(event.startAt),
      ...(event.endAt ? { endDate: new Date(event.endAt) } : {}),
      ...(event.location
        ? {
            location: {
              degreesLatitude: event.location.latitude,
              degreesLongitude: event.location.longitude,
              ...(event.location.name ? { name: event.location.name } : {}),
              ...(event.location.address
                ? { address: event.location.address }
                : {}),
            },
          }
        : {}),
      ...(event.call ? { call: event.call } : {}),
      ...(event.extraGuestsAllowed !== undefined
        ? { extraGuestsAllowed: event.extraGuestsAllowed }
        : {}),
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

/** Needs the socket: reads the group's invite code and name. */
export async function groupInvitePayload(
  sock: WASocket,
  input: GroupInviteInput,
): Promise<AnyMessageContent> {
  let code: string | undefined;
  let subject: string;
  try {
    code = await sock.groupInviteCode(input.groupId);
    subject = (await sock.groupMetadata(input.groupId)).subject;
  } catch {
    code = undefined;
    subject = '';
  }
  if (!code)
    throw new Error(
      'Cannot read the invite code of this group: this account must be an admin of it',
    );
  return {
    groupInvite: {
      inviteCode: code,
      inviteExpiration:
        Math.floor(Date.now() / 1000) + INVITE_CARD_DAYS * 86_400,
      text: input.text ?? '',
      jid: input.groupId,
      subject,
    },
  };
}

/** Needs the socket: the card names this account as the seller. */
export function productPayload(
  sock: WASocket,
  input: ProductInput,
): AnyMessageContent {
  if (!sock.user?.id) throw new Error('WhatsApp not connected');
  assertPublicUrl(input.imageUrl);
  return {
    product: {
      productImage: { url: input.imageUrl },
      productId: input.productId,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      currencyCode: input.currency.toUpperCase(),
      priceAmount1000: Math.round(input.price * 1000),
      ...(input.retailerId ? { retailerId: input.retailerId } : {}),
      ...(input.url ? { url: input.url } : {}),
      productImageCount: 1,
    },
    businessOwnerJid: jidNormalizedUser(sock.user.id),
    ...(input.body ? { body: input.body } : {}),
    ...(input.footer ? { footer: input.footer } : {}),
  };
}

/**
 * Fold a rich kind from a request into the stored form: { content, mediaType }.
 * Returns null when the request has none of them.
 */
export function foldRichContent(input: {
  location?: LocationInput;
  contact?: ContactInput;
  event?: EventInput;
  groupInvite?: GroupInviteInput;
  product?: ProductInput;
}): { content: string; mediaType: RichKind } | null {
  for (const kind of RICH_KINDS) {
    const value = input[kind];
    if (value) return { content: JSON.stringify(value), mediaType: kind };
  }
  return null;
}
