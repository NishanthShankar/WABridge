import type { AnyMessageContent } from '@whiskeysockets/baileys';
import { assertPublicUrl } from '../net/safe-fetch.js';
import { contactPayload, locationPayload } from './rich-content.js';

/**
 * Media sent from a URL. sticker: a WebP image. videoNote: a short square video shown as a
 * round video message. Neither has a caption, so content is ignored for them, as for audio.
 */
export const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker', 'videoNote'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/**
 * Build the Baileys message for a text or a media URL. content becomes the caption for
 * image, video and document; audio has no caption in WhatsApp, so content is ignored there.
 */
export function buildMessagePayload(
  content: string,
  mediaUrl?: string | null,
  mediaType?: string | null,
): AnyMessageContent {
  // Stored like polls: the fields are JSON in content, there is no URL.
  if (mediaType === 'location') return locationPayload(JSON.parse(content));
  if (mediaType === 'contact') return contactPayload(JSON.parse(content));

  if (!mediaUrl || !mediaType) {
    return { text: content };
  }
  // Baileys reads a non-http "url" as a local file path; only public http(s) URLs get through.
  assertPublicUrl(mediaUrl);

  switch (mediaType) {
    case 'image':
      return { image: { url: mediaUrl }, caption: content };
    case 'video':
      return { video: { url: mediaUrl }, caption: content };
    case 'audio':
      return { audio: { url: mediaUrl }, mimetype: 'audio/mp4' };
    case 'sticker':
      return { sticker: { url: mediaUrl } };
    case 'videoNote':
      return { video: { url: mediaUrl }, ptv: true };
    case 'document': {
      const fileName = decodeURIComponent(
        mediaUrl.split('/').pop()?.split('?')[0] ?? 'file',
      );
      return {
        document: { url: mediaUrl },
        caption: content,
        fileName,
        mimetype: 'application/octet-stream',
      };
    }
    default:
      return { text: content };
  }
}
