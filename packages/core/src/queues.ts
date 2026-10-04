/**
 * BullMQ queue registry (Phase 1). Producers live in api; consumers in worker.
 */
import { Queue } from 'bullmq';
import { redisConnectionOptions } from './redis.js';

export const QUEUE_NAMES = {
  render: 'render', // PDF batch render jobs (chunked)
  delivery: 'delivery', // email/SMS sends
  iris: 'iris', // transmit + ack polling
  w9: 'w9', // W-9 reminders/expiry sweeps
  housekeeping: 'housekeeping', // token expiry, stale W-9 detection, retention
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    // The delivery queue's job payloads carry tokenized magic links (and the raw
    // password-reset token). Those must NOT linger in Redis after the send, where
    // anyone with Redis/BullMQ-dashboard access could harvest live credentials —
    // completed delivery jobs are dropped immediately. FAILED delivery jobs are
    // kept (the worker scrubs their secrets on the terminal attempt) so an SMTP
    // outage leaves a visible, countable trace instead of silently eating a
    // campaign; their backoff is long enough to ride out a short outage.
    const sensitive = name === QUEUE_NAMES.delivery;
    q = new Queue(name, {
      connection: redisConnectionOptions(),
      defaultJobOptions: sensitive
        ? {
            attempts: 6,
            backoff: { type: 'exponential', delay: 30_000 }, // 30s … 16m ≈ 30 min of retries
            removeOnComplete: true,
            removeOnFail: { count: 500 },
          }
        : {
            attempts: 5,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: { count: 1000 },
            removeOnFail: { count: 5000 },
          },
    });
    queues.set(name, q);
  }
  return q;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}

// --- job payload types ------------------------------------------------------

export interface RenderBatchJob {
  kind: 'paper_batch';
  paperBatchId: string;
  firmId: string;
  chunkIndex: number;
  chunkCount: number;
  formRecordIds: string[];
}

export interface RenderSingleJob {
  kind: 'single_form';
  formRecordId: string;
  firmId: string;
  variant: 'portal' | 'copy2';
}

export interface DeliveryJob {
  kind: 'form_notification' | 'w9_request' | 'w9_reminder' | 'client_invite' | 'staff_alert' | 'password_reset' | 'portal_code';
  channel: 'email' | 'sms';
  firmId: string;
  to: string;
  templateKey: string;
  vars: Record<string, string>;
  deliveryId?: string;
  w9RequestId?: string;
  /** set by the worker on terminal failure: secrets removed, job kept only as a visible failure record */
  scrubbed?: boolean;
}

export interface IrisTransmitJob {
  kind: 'transmit';
  transmissionId: string;
  firmId: string;
}

export interface IrisPollJob {
  kind: 'poll';
  transmissionId: string;
  firmId: string;
  attempt: number;
  /** status() calls that threw back-to-back (provider outage / breaker open); reset on any answer */
  consecutiveErrors?: number;
}
