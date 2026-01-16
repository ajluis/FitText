/**
 * Message batching service
 *
 * Implements 2-second debounce mechanism for incoming messages.
 * When a message arrives, we wait 2 seconds before processing.
 * If another message arrives during that window, we batch them together
 * and reset the timer.
 */
import { Queue, Worker, Job } from 'bullmq';
import redis from '../lib/redis';
import { handleInboundMessage } from '../handlers';
import { config } from '../config';
import logger from '../lib/logger';

const BATCH_DELAY_MS = 2000; // 2 seconds
const BATCH_TTL_SECONDS = 600; // 10 minutes safety TTL

// Parse Redis URL for BullMQ connection
// BullMQ requires explicit connection options, not just a URL string
const redisUrl = new URL(config.redis.url);
const redisConnection = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port || '6379', 10),
  password: redisUrl.password || undefined,
  username: redisUrl.username || undefined,
  // Enable TLS if the URL uses rediss:// protocol
  tls: redisUrl.protocol === 'rediss:' ? {} : undefined,
  maxRetriesPerRequest: null, // Required for BullMQ
};

interface BatchJobData {
  phone: string;
  batchKey: string;
}

interface BatchedMessage {
  content: string;
  mediaUrl: string | null;
  receivedAt: string;
}

// Create queue for message batching
const batchQueue = new Queue<BatchJobData>('message-batching', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

/**
 * Add a message to the batch for a given phone number.
 * If there's already a pending batch, append to it and reset the timer.
 */
export async function addMessageToBatch(
  phone: string,
  content: string,
  mediaUrl: string | null
): Promise<void> {
  const batchKey = `batch:pending:${phone}`;
  const jobId = `batch-${phone}`;

  const message: BatchedMessage = {
    content,
    mediaUrl,
    receivedAt: new Date().toISOString(),
  };

  // 1. Append message to Redis list
  await redis.rpush(`${batchKey}:messages`, JSON.stringify(message));
  await redis.expire(`${batchKey}:messages`, BATCH_TTL_SECONDS);

  logger.debug(
    { event: 'batch_message_added', phone: phone.slice(-4), hasMedia: !!mediaUrl },
    `Added message to batch for ***${phone.slice(-4)}`
  );

  // 2. Cancel existing delayed job (if any)
  const existingJob = await batchQueue.getJob(jobId);
  if (existingJob) {
    const state = await existingJob.getState();
    // Only remove if it's still delayed (not yet processing)
    if (state === 'delayed' || state === 'waiting') {
      await existingJob.remove();
      logger.debug(
        { event: 'batch_job_cancelled', phone: phone.slice(-4) },
        `Cancelled existing batch job for ***${phone.slice(-4)}`
      );
    }
  }

  // 3. Schedule new job with fresh 2-second delay
  await batchQueue.add('process-batch', { phone, batchKey }, {
    delay: BATCH_DELAY_MS,
    jobId,
  });

  logger.debug(
    { event: 'batch_job_scheduled', phone: phone.slice(-4), delayMs: BATCH_DELAY_MS },
    `Scheduled batch processing in ${BATCH_DELAY_MS}ms for ***${phone.slice(-4)}`
  );
}

/**
 * Process a batch of messages after the delay expires
 */
async function processBatch(job: Job<BatchJobData>): Promise<void> {
  const { phone, batchKey } = job.data;
  const messagesKey = `${batchKey}:messages`;

  // Atomically fetch and clear the batch
  const rawMessages = await redis.lrange(messagesKey, 0, -1);
  await redis.del(messagesKey);

  if (rawMessages.length === 0) {
    logger.warn(
      { event: 'batch_empty', phone: phone.slice(-4), batchKey },
      `Batch was empty for ***${phone.slice(-4)} (may have been processed already)`
    );
    return;
  }

  const messages: BatchedMessage[] = rawMessages.map((m) => JSON.parse(m));

  logger.info(
    { event: 'batch_processing', phone: phone.slice(-4), messageCount: messages.length },
    `Processing batch of ${messages.length} message(s) for ***${phone.slice(-4)}`
  );

  // Combine text content (join with newlines)
  const combinedContent = messages
    .map((m) => m.content)
    .filter((c) => c && c.trim())
    .join('\n');

  // Collect all media URLs (use first one for now, could extend later)
  const allMediaUrls = messages
    .map((m) => m.mediaUrl)
    .filter((url): url is string => url !== null);

  // Use first media URL (most common case: user sends one photo)
  // Future enhancement: could process multiple photos
  const mediaUrl = allMediaUrls.length > 0 ? allMediaUrls[0] : undefined;

  // Log combined message info
  const preview = combinedContent.substring(0, 50) || '[media only]';
  logger.info(
    {
      event: 'batch_combined',
      phone: phone.slice(-4),
      originalCount: messages.length,
      combinedLength: combinedContent.length,
      mediaCount: allMediaUrls.length,
      preview,
    },
    `Combined ${messages.length} messages: "${preview}"`
  );

  // Process as single message
  await handleInboundMessage(phone, combinedContent, mediaUrl);
}

// Create worker to process batched messages
let batchWorker: Worker<BatchJobData> | null = null;

/**
 * Start the batch worker
 */
export function startBatchWorker(): void {
  if (batchWorker) {
    logger.warn({ event: 'batch_worker_exists' }, 'Batch worker already running');
    return;
  }

  batchWorker = new Worker<BatchJobData>('message-batching', processBatch, {
    connection: redisConnection,
    concurrency: 5, // Process up to 5 batches concurrently
  });

  batchWorker.on('completed', (job) => {
    logger.debug(
      { event: 'batch_job_completed', jobId: job.id, phone: job.data.phone.slice(-4) },
      `Batch job completed for ***${job.data.phone.slice(-4)}`
    );
  });

  batchWorker.on('failed', (job, err) => {
    logger.error(
      { event: 'batch_job_failed', jobId: job?.id, error: err.message },
      `Batch job failed: ${err.message}`
    );
  });

  batchWorker.on('error', (err) => {
    logger.error(
      { event: 'batch_worker_error', error: err.message },
      `Batch worker error: ${err.message}`
    );
  });

  logger.info({ event: 'batch_worker_started' }, 'Message batch worker started');
}

/**
 * Stop the batch worker (for graceful shutdown)
 */
export async function stopBatchWorker(): Promise<void> {
  if (batchWorker) {
    await batchWorker.close();
    batchWorker = null;
    logger.info({ event: 'batch_worker_stopped' }, 'Message batch worker stopped');
  }
}

export default {
  addMessageToBatch,
  startBatchWorker,
  stopBatchWorker,
};
