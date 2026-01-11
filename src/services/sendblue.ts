import { config, SENDBLUE_RATE_LIMIT_MS } from '../config';

const SENDBLUE_API_URL = 'https://api.sendblue.co/api/send-message';

// Track last message time per user for rate limiting
const lastMessageTime = new Map<string, number>();

interface SendMessageOptions {
  number: string;
  content: string;
  sendStyle?: 'default' | 'invisible';
  mediaUrl?: string;
}

interface SendMessageResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send an SMS message via Sendblue
 */
export async function sendMessage(options: SendMessageOptions): Promise<SendMessageResponse> {
  const { number, content, sendStyle = 'default', mediaUrl } = options;

  // Rate limiting - ensure we don't send more than 1 msg/sec per user
  const lastTime = lastMessageTime.get(number) || 0;
  const now = Date.now();
  const timeSinceLastMessage = now - lastTime;

  if (timeSinceLastMessage < SENDBLUE_RATE_LIMIT_MS) {
    const waitTime = SENDBLUE_RATE_LIMIT_MS - timeSinceLastMessage;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  try {
    const body: Record<string, string> = {
      number,
      content,
      send_style: sendStyle,
    };

    if (mediaUrl) {
      body.media_url = mediaUrl;
    }

    const response = await fetch(SENDBLUE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'sb-api-key-id': config.sendblue.apiKey,
        'sb-api-secret-key': config.sendblue.apiSecret,
      },
      body: JSON.stringify(body),
    });

    lastMessageTime.set(number, Date.now());

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Sendblue API error:', response.status, errorText);
      return {
        success: false,
        error: `API error: ${response.status}`,
      };
    }

    const data = await response.json() as { message_id?: string };
    return {
      success: true,
      messageId: data.message_id,
    };
  } catch (error) {
    console.error('Sendblue send error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Send a message and handle errors gracefully
 */
export async function sendSMS(phone: string, message: string): Promise<boolean> {
  const result = await sendMessage({ number: phone, content: message });

  if (!result.success) {
    console.error(`Failed to send SMS to ${phone}:`, result.error);
  }

  return result.success;
}

/**
 * Send multiple messages in sequence (for longer content that needs to be split)
 */
export async function sendMultipleMessages(phone: string, messages: string[]): Promise<boolean> {
  for (const message of messages) {
    const success = await sendSMS(phone, message);
    if (!success) return false;
  }
  return true;
}

/**
 * Split a long message into SMS-friendly chunks
 * SMS limit is technically 160 chars, but modern phones combine them
 * We'll aim for ~300 chars per message for readability
 */
export function splitMessage(content: string, maxLength = 300): string[] {
  if (content.length <= maxLength) {
    return [content];
  }

  const messages: string[] = [];
  const lines = content.split('\n');
  let currentMessage = '';

  for (const line of lines) {
    if (currentMessage.length + line.length + 1 > maxLength) {
      if (currentMessage) {
        messages.push(currentMessage.trim());
      }
      currentMessage = line;
    } else {
      currentMessage += (currentMessage ? '\n' : '') + line;
    }
  }

  if (currentMessage) {
    messages.push(currentMessage.trim());
  }

  return messages;
}

// Webhook payload types
export interface SendblueInboundWebhook {
  accountEmail: string;
  content: string;
  media_url?: string;
  is_outbound: boolean;
  status: string;
  error_code?: string;
  error_message?: string;
  message_handle: string;
  date_sent: string;
  date_updated: string;
  from_number: string;
  number: string;
  to_number: string;
  was_downgraded: boolean;
  plan: string;
}

/**
 * Parse and validate inbound webhook from Sendblue
 */
export function parseInboundWebhook(body: unknown): SendblueInboundWebhook | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const webhook = body as Record<string, unknown>;

  // Required fields
  if (typeof webhook.from_number !== 'string' || typeof webhook.content !== 'string') {
    return null;
  }

  return {
    accountEmail: String(webhook.accountEmail || ''),
    content: String(webhook.content || ''),
    media_url: webhook.media_url ? String(webhook.media_url) : undefined,
    is_outbound: Boolean(webhook.is_outbound),
    status: String(webhook.status || ''),
    error_code: webhook.error_code ? String(webhook.error_code) : undefined,
    error_message: webhook.error_message ? String(webhook.error_message) : undefined,
    message_handle: String(webhook.message_handle || ''),
    date_sent: String(webhook.date_sent || ''),
    date_updated: String(webhook.date_updated || ''),
    from_number: String(webhook.from_number),
    number: String(webhook.number || webhook.from_number),
    to_number: String(webhook.to_number || ''),
    was_downgraded: Boolean(webhook.was_downgraded),
    plan: String(webhook.plan || ''),
  };
}
