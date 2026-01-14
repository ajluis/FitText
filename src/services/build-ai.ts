/**
 * Build mode AI service
 *
 * Handles Gemini conversations for code editing via SMS.
 * Uses function calling to let Gemini read/write files.
 */
import { Content, FunctionDeclaration, Part } from '@google/genai';
import { Prisma } from '@prisma/client';
import genai, { GEMINI_MODEL } from '../lib/gemini';
import { BUILD_TOOLS, executeTool } from './build-tools';
import prisma from '../lib/db';
import { config } from '../config';
import * as fs from 'fs';
import * as path from 'path';

// Load static architecture context
let ARCHITECTURE_DOC = '';
try {
  ARCHITECTURE_DOC = fs.readFileSync(
    path.join(process.cwd(), 'docs/ARCHITECTURE.md'),
    'utf-8'
  );
} catch {
  ARCHITECTURE_DOC = 'Architecture documentation not found.';
}

const BUILD_SYSTEM_PROMPT = `You are an expert software engineer helping modify the FitText SMS fitness coaching application via text message.

## FitText Architecture
${ARCHITECTURE_DOC}

## Your Capabilities
You have tools to:
1. read_file - Read any file in src/, prisma/, or docs/
2. write_file - Write files (commits immediately to main)
3. list_files - List directory contents
4. search_code - Search for code patterns

## Guidelines
- Always read relevant files before making changes
- Follow existing code patterns and TypeScript conventions
- Keep responses SHORT (under 300 chars) - user is on SMS
- After writing a file, briefly confirm what you did
- If unsure about something, ask the user

## Safety
- You cannot access .env, node_modules, or .git
- All writes commit directly to main branch
- Be careful and deliberate with changes`;

// Convert Claude tool format to Gemini function declarations
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GEMINI_TOOLS = BUILD_TOOLS.map(tool => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.input_schema,
})) as any as FunctionDeclaration[];

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface ProcessResult {
  response: string;
  filesModified: string[];
  commitsMade: number;
}

/**
 * Process a build mode message
 */
export async function processBuildMessage(
  userId: string,
  userMessage: string
): Promise<ProcessResult> {
  // Get session
  const session = await prisma.buildSession.findUnique({
    where: { userId },
  });

  if (!session) {
    throw new Error('No active build session');
  }

  // Check tool call limit
  if (session.toolCallCount >= config.build.maxToolCalls) {
    throw new Error(`Tool call limit (${config.build.maxToolCalls}) reached. Start a new session.`);
  }

  // Load conversation history
  const history = (session.conversationHistory as unknown) as ConversationMessage[];

  // Add user message
  history.push({
    role: 'user',
    content: userMessage,
    timestamp: new Date().toISOString(),
  });

  // Build Gemini contents from history
  const contents: Content[] = history.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));

  let toolCallCount = session.toolCallCount;
  const filesModified = [...session.filesModified];
  let commitsMade = session.commitsMade;

  try {
    // Call Gemini with tools
    let response = await genai.models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction: BUILD_SYSTEM_PROMPT,
        maxOutputTokens: 4096,
        tools: [{ functionDeclarations: GEMINI_TOOLS }],
      },
    });

    // Process tool calls in a loop
    while (response.functionCalls && response.functionCalls.length > 0) {
      const functionResponses: Part[] = [];

      for (const call of response.functionCalls) {
        toolCallCount++;
        const toolName = call.name ?? 'unknown';

        try {
          const result = await executeTool(
            toolName,
            call.args as Record<string, unknown>
          );

          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: { result: result.substring(0, 5000) }, // Limit result size
            },
          });

          // Track file modifications and commits
          if (call.name === 'write_file') {
            const filePath = (call.args as { file_path: string }).file_path;
            if (!filesModified.includes(filePath)) {
              filesModified.push(filePath);
            }
            commitsMade++;
          }
        } catch (error) {
          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: { error: (error as Error).message },
            },
          });
        }
      }

      // Get the model's response parts for context
      const modelResponseParts: Part[] = [];
      if (response.text) {
        modelResponseParts.push({ text: response.text });
      }
      // Include function call parts so the model knows what it called
      for (const call of response.functionCalls) {
        modelResponseParts.push({
          functionCall: {
            name: call.name,
            args: call.args,
          },
        });
      }

      // Continue conversation with tool results
      const newContents: Content[] = [
        ...contents,
        { role: 'model', parts: modelResponseParts },
        { role: 'user', parts: functionResponses },
      ];

      response = await genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: newContents,
        config: {
          systemInstruction: BUILD_SYSTEM_PROMPT,
          maxOutputTokens: 4096,
          tools: [{ functionDeclarations: GEMINI_TOOLS }],
        },
      });
    }

    // Extract final text response
    const assistantContent = response.text ?? '';

    // Add assistant response to history
    history.push({
      role: 'assistant',
      content: assistantContent,
      timestamp: new Date().toISOString(),
    });

    // Update session
    await prisma.buildSession.update({
      where: { id: session.id },
      data: {
        conversationHistory: history as unknown as Prisma.InputJsonValue,
        toolCallCount,
        filesModified,
        commitsMade,
        lastInteraction: new Date(),
      },
    });

    return {
      response: assistantContent,
      filesModified,
      commitsMade,
    };
  } catch (error) {
    console.error('Build AI error:', error);

    // Save conversation state even on error
    await prisma.buildSession.update({
      where: { id: session.id },
      data: {
        conversationHistory: history as unknown as Prisma.InputJsonValue,
        toolCallCount,
        filesModified,
        commitsMade,
        lastInteraction: new Date(),
      },
    });

    throw error;
  }
}

/**
 * Create a new build session
 */
export async function createBuildSession(userId: string): Promise<void> {
  // Delete any existing session
  await prisma.buildSession.deleteMany({
    where: { userId },
  });

  // Create new session
  await prisma.buildSession.create({
    data: {
      userId,
      conversationHistory: [],
    },
  });
}

/**
 * End a build session and return summary
 */
export async function endBuildSession(userId: string): Promise<string> {
  const session = await prisma.buildSession.findUnique({
    where: { userId },
  });

  if (!session) {
    return 'No active build session.';
  }

  const summary = `Build session ended.
Commits: ${session.commitsMade}
Files: ${session.filesModified.length}
Tool calls: ${session.toolCallCount}`;

  await prisma.buildSession.delete({
    where: { id: session.id },
  });

  return summary;
}

/**
 * Check if user has an active build session
 */
export async function hasActiveBuildSession(userId: string): Promise<boolean> {
  const session = await prisma.buildSession.findUnique({
    where: { userId },
  });

  if (!session) return false;

  // Check for session timeout
  const timeoutMs = config.build.sessionTimeoutMinutes * 60 * 1000;
  const cutoff = new Date(Date.now() - timeoutMs);

  if (session.lastInteraction < cutoff) {
    // Session expired, clean it up
    await prisma.buildSession.delete({ where: { id: session.id } });
    return false;
  }

  return session.active;
}
