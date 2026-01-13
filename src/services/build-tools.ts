/**
 * Build mode tools for file operations via GitHub API
 *
 * Uses GitHub API instead of local git commands since Railway
 * deployments don't have persistent git repos.
 */
import { config } from '../config';

const GITHUB_OWNER = 'ajluis';
const GITHUB_REPO = 'FitText';
const GITHUB_BRANCH = 'main';

// Allowed directories for file operations (security)
const ALLOWED_DIRS = ['src', 'prisma', 'docs'];

// Forbidden paths
const FORBIDDEN_PATHS = ['.env', 'node_modules', '.git', 'package-lock.json'];

// Tool definitions for Claude API
export const BUILD_TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file from the repository',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file relative to project root (e.g., "src/handlers/commands.ts")',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file in the repository. This commits and pushes the change immediately.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file relative to project root',
        },
        content: {
          type: 'string',
          description: 'The complete file content to write',
        },
        commit_message: {
          type: 'string',
          description: 'Commit message describing the change',
        },
      },
      required: ['file_path', 'content', 'commit_message'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in a directory',
    input_schema: {
      type: 'object' as const,
      properties: {
        directory: {
          type: 'string',
          description: 'Directory path relative to project root (e.g., "src/handlers")',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'search_code',
    description: 'Search for a text pattern across the codebase using GitHub code search',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'The search query (text to find)',
        },
      },
      required: ['query'],
    },
  },
];

/**
 * Validate file path for security
 */
function validatePath(filePath: string): void {
  // Prevent path traversal
  if (filePath.includes('..') || filePath.startsWith('/')) {
    throw new Error('Invalid path: path traversal not allowed');
  }

  // Check allowed directories
  const firstDir = filePath.split('/')[0];
  if (!ALLOWED_DIRS.includes(firstDir)) {
    throw new Error(`Access denied: only ${ALLOWED_DIRS.join(', ')} directories are allowed`);
  }

  // Check forbidden paths
  for (const forbidden of FORBIDDEN_PATHS) {
    if (filePath.includes(forbidden)) {
      throw new Error(`Access denied: cannot access ${forbidden}`);
    }
  }
}

/**
 * Make GitHub API request
 */
async function githubApi(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = config.build.githubToken;
  if (!token) {
    throw new Error('GITHUB_TOKEN not configured');
  }

  const url = endpoint.startsWith('http')
    ? endpoint
    : `https://api.github.com${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  return response;
}

/**
 * Read a file from GitHub
 */
export async function readFile(filePath: string): Promise<string> {
  validatePath(filePath);

  const response = await githubApi(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`File not found: ${filePath}`);
    }
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = await response.json() as { content: string; encoding: string };

  if (data.encoding !== 'base64') {
    throw new Error('Unexpected file encoding');
  }

  return Buffer.from(data.content, 'base64').toString('utf-8');
}

/**
 * Write a file to GitHub (creates or updates)
 */
export async function writeFile(
  filePath: string,
  content: string,
  commitMessage: string
): Promise<string> {
  validatePath(filePath);

  // Get current file SHA if it exists (needed for updates)
  let sha: string | undefined;
  try {
    const getResponse = await githubApi(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`
    );
    if (getResponse.ok) {
      const data = await getResponse.json() as { sha: string };
      sha = data.sha;
    }
  } catch {
    // File doesn't exist, that's fine
  }

  // Create or update file
  const body: Record<string, string> = {
    message: commitMessage,
    content: Buffer.from(content).toString('base64'),
    branch: GITHUB_BRANCH,
  };

  if (sha) {
    body.sha = sha;
  }

  const response = await githubApi(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to write file: ${error}`);
  }

  const result = await response.json() as { commit: { sha: string } };
  return `Committed: ${result.commit.sha.substring(0, 7)}`;
}

/**
 * List files in a directory
 */
export async function listFiles(directory: string): Promise<string> {
  validatePath(directory);

  const response = await githubApi(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${directory}?ref=${GITHUB_BRANCH}`
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Directory not found: ${directory}`);
    }
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = await response.json() as Array<{ name: string; type: string }>;

  const lines = data.map(item => {
    const prefix = item.type === 'dir' ? '[dir] ' : '';
    return `${prefix}${item.name}`;
  });

  return lines.join('\n') || 'Empty directory';
}

/**
 * Search code in repository
 */
export async function searchCode(query: string): Promise<string> {
  const response = await githubApi(
    `/search/code?q=${encodeURIComponent(query)}+repo:${GITHUB_OWNER}/${GITHUB_REPO}`
  );

  if (!response.ok) {
    throw new Error(`Search failed: ${response.status}`);
  }

  const data = await response.json() as {
    total_count: number;
    items: Array<{ path: string; html_url: string }>;
  };

  if (data.total_count === 0) {
    return 'No matches found';
  }

  const results = data.items.slice(0, 10).map(item => item.path);
  return `Found ${data.total_count} matches:\n${results.join('\n')}`;
}

/**
 * Execute a build tool by name
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (toolName) {
    case 'read_file':
      return readFile(input.file_path as string);

    case 'write_file':
      return writeFile(
        input.file_path as string,
        input.content as string,
        input.commit_message as string
      );

    case 'list_files':
      return listFiles(input.directory as string);

    case 'search_code':
      return searchCode(input.query as string);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
