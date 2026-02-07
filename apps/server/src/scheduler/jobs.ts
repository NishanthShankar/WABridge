import type { Queue } from 'bullmq';

/**
 * Schedule a one-time message send job with a delay.
 *
 * @param queue - BullMQ Queue instance
 * @param messageId - scheduledMessages.id (SQLite record)
 * @param delay - Milliseconds until the job should fire (0 = immediate)
 * @param tenantId - Optional tenant ID (empty string in single-tenant mode)
 */
export async function scheduleOneTimeJob(
  queue: Queue,
  messageId: string,
  delay: number,
  tenantId: string = '',
): Promise<void> {
  await queue.add(
    'send',
    { scheduledMessageId: messageId, tenantId },
    {
      delay: Math.max(0, delay),
      jobId: `msg-${messageId}`,
    },
  );
}

/**
 * Cancel (remove) a scheduled job from the queue.
 *
 * Safe to call even if the job has already been processed.
 *
 * @param queue - BullMQ Queue instance
 * @param messageId - scheduledMessages.id
 */
export async function cancelJob(
  queue: Queue,
  messageId: string,
): Promise<void> {
  const job = await queue.getJob(`msg-${messageId}`);
  if (job) {
    await job.remove();
  }
}

/**
 * Reschedule a job: cancel existing and add new with updated delay.
 *
 * @param queue - BullMQ Queue instance
 * @param messageId - scheduledMessages.id
 * @param newDelay - New delay in milliseconds
 * @param tenantId - Optional tenant ID (empty string in single-tenant mode)
 */
export async function rescheduleJob(
  queue: Queue,
  messageId: string,
  newDelay: number,
  tenantId: string = '',
): Promise<void> {
  await cancelJob(queue, messageId);
  await scheduleOneTimeJob(queue, messageId, newDelay, tenantId);
}
