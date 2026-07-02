/**
 * Worker boot: BullMQ consumers for render / delivery / iris / housekeeping.
 * Queue durability across restarts is provided by Redis-backed BullMQ.
 */
import { Worker } from 'bullmq';
import { createLogger, loadEnv, redisConnectionOptions, QUEUE_NAMES, getQueue } from '@vibe1099/core';
import { getPool, runMigrations } from '@vibe1099/db';
import { handleRenderJob } from './jobs/render.js';
import { handleDeliveryJob } from './jobs/delivery.js';
import { handleIrisPoll, handleIrisTransmit } from './jobs/iris.js';
import { handleHousekeepingJob } from './jobs/housekeeping.js';

const log = createLogger('worker:boot');

async function main(): Promise<void> {
  const env = loadEnv();
  await runMigrations(getPool(env.DATABASE_URL), (m) => log.info(m)); // safe with api via advisory lock

  const connection = redisConnectionOptions(env.REDIS_URL);

  const workers = [
    new Worker(QUEUE_NAMES.render, handleRenderJob, { connection, concurrency: 4 }),
    new Worker(QUEUE_NAMES.delivery, handleDeliveryJob, { connection, concurrency: 8 }),
    new Worker(
      QUEUE_NAMES.iris,
      async (job) => {
        if (job.name === 'transmit') return handleIrisTransmit(job);
        if (job.name === 'poll') return handleIrisPoll(job);
        log.warn({ name: job.name }, 'unknown iris job');
      },
      { connection, concurrency: 2 },
    ),
    new Worker(QUEUE_NAMES.housekeeping, handleHousekeepingJob, { connection, concurrency: 1 }),
  ];

  for (const w of workers) {
    w.on('failed', (job, err) => log.error({ queue: w.name, job: job?.id, err: err.message }, 'job failed'));
    w.on('completed', (job) => log.debug({ queue: w.name, job: job.id }, 'job completed'));
  }

  // hourly housekeeping tick (repeatable)
  await getQueue(QUEUE_NAMES.housekeeping).add(
    'tick',
    {},
    { repeat: { pattern: '0 * * * *' }, jobId: 'housekeeping-hourly' },
  );

  log.info('vibe1099-worker consuming: render, delivery, iris, housekeeping');

  const shutdown = async () => {
    log.info('shutting down workers');
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.fatal(String(err instanceof Error ? err.stack : err));
  process.exit(1);
});
