/**
 * Build mode handler
 *
 * Allows admin users to edit code via SMS using Claude.
 */
import { User } from '@prisma/client';
import { sendSMS } from '../services/sendblue';
import {
  processBuildMessage,
  createBuildSession,
  endBuildSession,
  hasActiveBuildSession,
} from '../services/build-ai';
import { config } from '../config';

/**
 * Check if a phone number is authorized for build mode
 */
export function isAuthorizedForBuild(phone: string): boolean {
  return config.build.adminPhones.includes(phone);
}

/**
 * Check if user is in build mode
 */
export async function isInBuildMode(userId: string): Promise<boolean> {
  return hasActiveBuildSession(userId);
}

/**
 * Handle /build command - enter build mode
 */
export async function handleBuildCommand(user: User): Promise<void> {
  // Check authorization
  if (!isAuthorizedForBuild(user.phone)) {
    await sendSMS(user.phone, "Sorry, you don't have access to build mode.");
    return;
  }

  // Check for existing session
  const hasSession = await hasActiveBuildSession(user.id);
  if (hasSession) {
    await sendSMS(
      user.phone,
      "You're already in build mode. Describe what to change, or /exit when done."
    );
    return;
  }

  // Create new session
  await createBuildSession(user.id);

  await sendSMS(
    user.phone,
    `Build mode active. I can read/edit code and push to main.

What would you like to change?

/exit when done.`
  );
}

/**
 * Handle /exit or /done command - end build mode
 */
export async function handleBuildExit(user: User): Promise<void> {
  const summary = await endBuildSession(user.id);
  await sendSMS(user.phone, summary);
}

/**
 * Process a message while in build mode
 */
export async function processBuildModeMessage(
  user: User,
  message: string
): Promise<void> {
  const lower = message.toLowerCase().trim();

  // Check for exit commands
  if (lower === '/exit' || lower === '/done' || lower === 'exit' || lower === 'done') {
    await handleBuildExit(user);
    return;
  }

  try {
    const result = await processBuildMessage(user.id, message);

    // Split long responses for SMS
    const response = result.response;
    if (response.length > 300) {
      const parts = splitMessage(response, 280);
      for (const part of parts) {
        await sendSMS(user.phone, part);
      }
    } else {
      await sendSMS(user.phone, response);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await sendSMS(
      user.phone,
      `Error: ${errorMsg.substring(0, 200)}\n\nTry again or /exit.`
    );
  }
}

/**
 * Split long messages for SMS
 */
function splitMessage(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) return [content];

  const messages: string[] = [];
  const lines = content.split('\n');
  let current = '';

  for (const line of lines) {
    if (current.length + line.length + 1 > maxLength) {
      if (current) messages.push(current.trim());
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }

  if (current) messages.push(current.trim());
  return messages;
}
