import { eq } from 'drizzle-orm';
import type makeWASocket from '@whiskeysockets/baileys';
import { scheduledMessages } from '../db/schema.js';
import type { createDatabase } from '../db/client.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;
type BroadcastFn = (message: object) => void;

/**
 * Set up the Baileys delivery status listener.
 *
 * Listens on sock.ev 'messages.update' for delivery acknowledgements.
 * Maps Baileys status codes to our simplified model:
 *
 * - Status 3 (DELIVERY_ACK): update scheduledMessages -> status='delivered'
 * - Other statuses are ignored (SERVER_ACK=2 is already tracked as 'sent',
 *   READ=4 and PLAYED=5 are out of scope for this phase)
 *
 * NOTE: Delivery status from Baileys v7 RC is best-effort.
 * The 'sent' status (from successful sendMessage) is the reliable one.
 * 'delivered' is bonus information that may not arrive for all messages.
 *
 * This listener is designed to be called on every successful connection
 * via ConnectionManager.onConnected(), so it re-attaches on reconnections.
 */
export function setupDeliveryListener(
  sock: WASocket,
  db: Database,
  broadcast: BroadcastFn,
): void {
  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      if (!update.status || !key.id) continue;

      // Only handle DELIVERY_ACK (status 3)
      // WAProto.WebMessageInfo.Status: ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5
      if (update.status === 3) {
        try {
          const now = new Date();

          const msg = db
            .update(scheduledMessages)
            .set({
              status: 'delivered',
              deliveredAt: now,
              updatedAt: now,
            })
            .where(eq(scheduledMessages.whatsappMessageId, key.id))
            .returning()
            .get();

          if (msg) {
            broadcast({
              type: 'message:status',
              data: {
                messageId: msg.id,
                status: 'delivered',
                at: now.toISOString(),
              },
            });
          }
        } catch {
          // Best-effort status update -- don't crash on delivery tracking errors
        }
      }
    }
  });
}
