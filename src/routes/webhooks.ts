import { Router, Request, Response } from 'express';
import { parseInboundWebhook } from '../services/sendblue';
import { handleInboundMessage } from '../handlers';

const router = Router();

/**
 * Sendblue inbound webhook
 * POST /webhook/sendblue/inbound
 */
router.post('/sendblue/inbound', async (req: Request, res: Response) => {
  try {
    // Parse webhook payload
    const webhook = parseInboundWebhook(req.body);

    if (!webhook) {
      console.error('Invalid webhook payload:', req.body);
      res.status(400).json({ error: 'Invalid webhook payload' });
      return;
    }

    // Skip outbound messages (we only care about inbound)
    if (webhook.is_outbound) {
      res.status(200).json({ status: 'skipped', reason: 'outbound message' });
      return;
    }

    // Skip empty messages
    if (!webhook.content && !webhook.media_url) {
      res.status(200).json({ status: 'skipped', reason: 'empty message' });
      return;
    }

    console.log(`Received message from ${webhook.from_number}: ${webhook.content?.substring(0, 50)}`);

    // Process the message asynchronously
    // We respond immediately to avoid webhook timeout
    res.status(200).json({ status: 'received' });

    // Handle the message
    await handleInboundMessage(
      webhook.from_number,
      webhook.content || '',
      webhook.media_url
    );
  } catch (error) {
    console.error('Webhook processing error:', error);
    // Still return 200 to avoid Sendblue retries
    res.status(200).json({ status: 'error', message: 'Internal processing error' });
  }
});

/**
 * Health check for the webhook
 * GET /webhook/health
 */
router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Sendblue status webhook (for delivery receipts)
 * POST /webhook/sendblue/status
 */
router.post('/sendblue/status', async (req: Request, res: Response) => {
  try {
    const { message_handle, status, error_message } = req.body;

    if (status === 'FAILED' && error_message) {
      console.error(`Message delivery failed: ${message_handle} - ${error_message}`);
    }

    res.status(200).json({ status: 'received' });
  } catch (error) {
    console.error('Status webhook error:', error);
    res.status(200).json({ status: 'error' });
  }
});

export default router;
