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
    // so completed AND failed delivery jobs are dropped immediately.
    const sensitive = name === QUEUE_NAMES.delivery;
    q = new Queue(name, {
      connection: redisConnectionOptions(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: sensitive ? true : { count: 1000 },
        removeOnFail: sensitive ? true : { count: 5000 },
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
}
