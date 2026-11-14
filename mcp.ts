import type { Store, Repo, Issue, Pull } from './store.ts';
import type { RestRequest, RestResponse } from './rest.ts';

const SERVER_INFO = Object.freeze({
  name: 'github-core-clone',
  version: '1.0.0',
});

const SUPPORTED_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
        owner: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

// Responses expose these schemas directly. Freeze the entire static tree so a
// direct caller cannot accidentally change the tool list for future requests.
function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    freezeTree(child);
  }
  Object.freeze(value);
}

freezeTree(TOOLS);

type JsonObject = Record<string, unknown>;
type Tool = (typeof TOOLS)[number];

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function response(body: unknown, status = 200): RestResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body,
  };
}

function rpcError(
  id: unknown,
  code: number,
  message: string,
  status = 200,
): RestResponse {
  return response(
    {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    },
    status,
  );
}

function toolSuccess(value: unknown): JsonObject {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolFailure(message: string): JsonObject {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function repoObject(repo: Repo, store: Store) {
  const owner = repo.owner ?? store.ownerLogin ?? 'octocat';
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner,
  };
}

function issueObject(issue: Issue) {
  return {
    id: issue.databaseId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullObject(pull: Pull) {
  return {
    id: pull.databaseId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
  };
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'integer') {
    return typeof value === 'number' && Number.isInteger(value);
  }
  return typeof value === type;
}

function validateArguments(
  tool: Tool,
  args: JsonObject,
): string | null {
  const properties: Readonly<Record<string, { readonly type: string }>> =
    tool.inputSchema.properties;

  for (const name of tool.inputSchema.required) {
    const value = args[name];
    if (
      !hasOwn(args, name) ||
      !matchesType(value, properties[name].type) ||
      (properties[name].type === 'string' &&
        typeof value === 'string' &&
        value.trim().length === 0)
    ) {
      return `Missing required argument: ${name}`;
    }
  }

  for (const [name, schema] of Object.entries(properties)) {
    if (hasOwn(args, name) && !matchesType(args[name], schema.type)) {
      return `Invalid argument: ${name}`;
    }
  }

  return null;
}

// Called only after validation against the corresponding fixed tool schema.
function executeTool(
  name: Tool['name'],
  args: JsonObject,
  store: Store,
): JsonObject {
  if (name === 'create_repo') {
    const repoName = args.name as string;
    const repo =
      store.findRepoByName(repoName) ??
      store.createRepo(repoName, {
        private: (args.private as boolean | undefined) ?? false,
        description: (args.description as string | undefined) ?? '',
      });

    if (typeof args.owner === 'string' && args.owner.length > 0) {
      repo.owner = args.owner;
      store.ownerLogin = args.owner;
    }

    return toolSuccess(repoObject(repo, store));
  }

  const owner = args.owner as string;
  const repo = store.getRepo(owner, args.repo as string);
  if (repo === null) {
    return toolFailure('Repository not found');
  }

  switch (name) {
    case 'get_repo':
      return toolSuccess(repoObject(repo, store));

    case 'create_issue': {
      const issue = store.createIssue(repo, {
        title: args.title as string,
        body: (args.body as string | undefined) ?? '',
        authorLogin: owner,
      });
      return toolSuccess(issueObject(issue));
    }

    case 'list_issues': {
      const issues = Array.from(repo.issues.values())
        .filter((issue) => {
          if (args.state === 'open' || args.state === 'closed') {
            return issue.state === args.state;
          }
          return true;
        })
        .sort((left, right) => left.number - right.number)
        .map(issueObject);
      return toolSuccess(issues);
    }

    case 'create_pull_request': {
      const pull = store.createPull(repo, {
        title: args.title as string,
        body: (args.body as string | undefined) ?? '',
        headRef: args.head as string,
        baseRef: args.base as string,
        authorLogin: owner,
      });
      return toolSuccess(pullObject(pull));
    }

    case 'merge_pull_request': {
      const number = args.pull_number as number;
      if (!Number.isInteger(number) || number <= 0) {
        return toolFailure('pull_number must be a positive integer');
      }

      const pull = repo.pulls.get(number);
      if (pull === undefined) {
        return toolFailure('Pull request not found');
      }

      if (!pull.merged) {
        store.squashMerge(repo, pull, owner);
      }

      return toolSuccess(pullObject(pull));
    }
  }
}

export function handleMcp(
  req: RestRequest,
  store: Store,
): RestResponse {
  // These locals belong only to this invocation, including exception paths.
  let id: unknown = null;
  let notification = false;
  let executingTool = false;

  const result = (value: unknown): RestResponse => {
    if (notification) {
      return response(null, 202);
    }
    return response({ jsonrpc: '2.0', id, result: value });
  };

  const error = (code: number, message: string): RestResponse => {
    if (notification) {
      return response(null, 202);
    }
    return rpcError(id, code, message);
  };

  try {
    if (req.method === 'DELETE') {
      return response({});
    }

    let body: unknown = req.json;
    if (body === undefined) {
      try {
        body = JSON.parse(req.body.toString('utf-8'));
      } catch {
        return rpcError(null, -32700, 'Parse error', 400);
      }
    }

    if (!isObject(body)) {
      return rpcError(null, -32600, 'Invalid Request');
    }

    const hasId = hasOwn(body, 'id');
    id = hasId ? body.id : null;

    // An object without a method is an invalid request, rather than a
    // notification, even when its id is absent.
    if (typeof body.method !== 'string') {
      return rpcError(id, -32600, 'Invalid Request');
    }

    notification = !hasId;

    switch (body.method) {
      case 'server/discover':
        return result({
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          _meta: {
            'io.modelcontextprotocol/serverInfo': SERVER_INFO,
          },
        });

      case 'initialize': {
        if (!isObject(body.params)) {
          return error(-32602, 'Invalid params');
        }

        const version = body.params.protocolVersion;
        if (
          typeof version !== 'string' ||
          !SUPPORTED_VERSIONS.some((supported) => supported === version)
        ) {
          return error(-32602, 'Unsupported protocol version');
        }

        return result({
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      }

      case 'notifications/initialized':
        return result({});

      case 'tools/list':
        return result({ tools: TOOLS });

      case 'tools/call': {
        if (!isObject(body.params)) {
          return error(-32602, 'Invalid params');
        }

        const params = body.params;
        const tool = TOOLS.find((entry) => entry.name === params.name);
        if (tool === undefined) {
          return error(-32602, 'Unknown tool');
        }

        const args = hasOwn(params, 'arguments') ? params.arguments : {};
        if (!isObject(args)) {
          return error(-32602, 'Invalid tool arguments');
        }

        const validationError = validateArguments(tool, args);
        if (validationError !== null) {
          return result(toolFailure(validationError));
        }

        executingTool = true;
        return result(executeTool(tool.name, args, store));
      }

      default:
        return error(-32601, 'Method not found');
    }
  } catch {
    // Store failures are tool errors, not HTTP failures. Do not expose raw
    // exception messages, internal objects, or implementation details.
    if (executingTool) {
      return result(toolFailure('Tool execution failed'));
    }
    return error(-32603, 'Internal error');
  }
}
