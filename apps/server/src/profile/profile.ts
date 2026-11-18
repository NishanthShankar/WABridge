import type makeWASocket from '@whiskeysockets/baileys';
import { z } from 'zod';
import { jidToPhone } from '../webhooks/jid.js';

type WASocket = ReturnType<typeof makeWASocket>;

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 24 hour clock');
const httpUrl = (field: string) =>
  z
    .string()
    .url()
    .max(2048)
    .refine((u) => /^https?:\/\//i.test(u), {
      message: `${field} must be http or https`,
    });

/**
 * Opening hours. A day left out is shown as closed. open/close are local times in timezone;
 * mode "open24h" or "appointmentOnly" instead of open/close.
 */
const hoursSchema = z.object({
  timezone: z.string().min(1).max(64),
  days: z
    .array(
      z.union([
        z.object({ day: z.enum(DAYS), open: hhmm, close: hhmm }),
        z.object({
          day: z.enum(DAYS),
          mode: z.enum(['open24h', 'appointmentOnly']),
        }),
      ]),
    )
    .max(7)
    .refine((d) => new Set(d.map((x) => x.day)).size === d.length, {
      message: 'Each day at most once',
    }),
});

/** PATCH /api/profile/business. Fields left out stay as they are. WhatsApp cannot clear a field. */
export const businessProfileSchema = z
  .object({
    description: z.string().min(1).max(512).optional(),
    address: z.string().min(1).max(256).optional(),
    email: z.string().email().max(128).optional(),
    websites: z.array(httpUrl('websites')).min(1).max(2).optional(),
    hours: hoursSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Give description, address, email, websites or hours',
  });

/** PATCH /api/profile: the account's own name and about text */
export const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(25).optional(),
    about: z.string().max(139).optional(),
  })
  .refine((v) => v.name !== undefined || v.about !== undefined, {
    message: 'Give name, about or both',
  });

export const imageUrlSchema = z.object({ imageUrl: httpUrl('imageUrl') });

export type BusinessProfileInput = z.infer<typeof businessProfileSchema>;

const minutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return String(h * 60 + m);
};
const fromMinutes = (v?: string | number) => {
  const n = Number(v);
  return v === undefined || Number.isNaN(n)
    ? null
    : `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
};

/** Our hours -> Baileys' business_hours shape. */
export function toWhatsAppHours(hours: z.infer<typeof hoursSchema>) {
  return {
    timezone: hours.timezone,
    days: hours.days.map((d) =>
      'open' in d
        ? {
            day: d.day,
            mode: 'specific_hours' as const,
            openTimeInMinutes: minutes(d.open),
            closeTimeInMinutes: minutes(d.close),
          }
        : {
            day: d.day,
            mode:
              d.mode === 'open24h'
                ? ('open_24h' as const)
                : ('appointment_only' as const),
          },
    ),
  };
}

type RawProfile = Awaited<ReturnType<WASocket['getBusinessProfile']>>;

/** WhatsApp's business profile, in the same shape PATCH takes. null for a non-business account. */
export function readableBusinessProfile(raw: RawProfile) {
  if (!raw) return null;
  const config = (raw.business_hours?.business_config ??
    []) as unknown as Array<Record<string, string | number | undefined>>;
  return {
    description: raw.description || null,
    address: raw.address ?? null,
    email: raw.email ?? null,
    websites: raw.website ?? [],
    category: raw.category ?? null,
    hours: raw.business_hours?.timezone
      ? {
          timezone: raw.business_hours.timezone,
          days: config.map((c) =>
            c.mode === 'specific_hours'
              ? {
                  day: c.day_of_week,
                  open: fromMinutes(c.open_time),
                  close: fromMinutes(c.close_time),
                }
              : {
                  day: c.day_of_week,
                  mode: c.mode === 'open_24h' ? 'open24h' : 'appointmentOnly',
                },
          ),
        }
      : null,
  };
}

/** GET /api/profile: who this account is to the people it writes to. */
export async function readProfile(sock: WASocket) {
  const me = sock.user;
  if (!me?.id) return null;
  const jid = `${jidToPhone(me.id)}@s.whatsapp.net`;
  const [status, pictureUrl, business] = await Promise.all([
    sock
      .fetchStatus(jid)
      .then(
        (r) =>
          (r?.[0] as { status?: { status?: string } } | undefined)?.status
            ?.status ?? null,
      )
      .catch(() => null),
    sock.profilePictureUrl(jid, 'image').catch(() => null),
    sock.getBusinessProfile(jid).catch(() => undefined),
  ]);
  return {
    phone: jidToPhone(me.id),
    name: me.name ?? me.verifiedName ?? null,
    about: status,
    pictureUrl: pictureUrl ?? null,
    isBusiness: !!business,
    business: readableBusinessProfile(business),
  };
}
