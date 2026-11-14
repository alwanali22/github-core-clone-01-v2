import http from 'node:http';
import { createStore } from './store.ts';
import type { Store, Ctx } from './store.ts';
import { handleRest } from './rest.ts';
import type { RestRequest, RestResponse } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './gitproto.ts';
import type { GitRequest, GitResponse } from './gitproto.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

function requestHeaders(
  req: http.IncomingMessage,
): Record<string, string | undefined> {
  // The handlers read exactly three request headers (authorization, host,
  // git-protocol); copying the whole header table per request is pure
  // overhead. Pick only those, preserving the old duplicate-join behavior.
  // Node already lowercases names, so the capitalized fallbacks the handlers
  // also try are always undefined, exactly as before.
  const h = req.headers;
  const pick = (
    value: string | string[] | undefined,
  ): string | undefined =>
    Array.isArray(value) ? value.join(', ') : value;
  return {
    authorization: pick(h.authorization),
    host: pick(h.host),
    'git-protocol': pick(h['git-protocol']),
  };
}

async function readBody(
  req: http.IncomingMessage,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;

  for await (const chunk of req) {
    // Continue consuming oversized requests without retaining their contents.
    if (tooLarge) continue;

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }

    chunks.push(buffer);
  }

  if (tooLarge) return null;
  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return chunks[0];
  return Buffer.concat(chunks, size);
}

function sendJson(
  res: http.ServerResponse,
  requestId: string,
  response: RestResponse,
): void {
  const empty =
    response.status === 204 ||
    response.body === null ||
    response.body === undefined;

  // Serialize before touching the response so serialization failures can
  // still be answered with a clean 500 response.
  const text = empty ? '' : `${JSON.stringify(response.body)}\n`;
  const length = Buffer.byteLength(text);

  for (const [name, value] of Object.entries(response.headers)) {
    res.setHeader(name, value);
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-GitHub-Request-Id', requestId);
  res.removeHeader('Transfer-Encoding');
  res.setHeader('Content-Length', length);
  res.statusCode = response.status;
  res.end(text);
}

function sendGit(
  res: http.ServerResponse,
  requestId: string,
  response: GitResponse,
): void {
  for (const [name, value] of Object.entries(response.headers)) {
    res.setHeader(name, value);
  }

  res.setHeader('X-GitHub-Request-Id', requestId);

  // Git handlers normally supply this themselves; preserve their value.
  if (!res.hasHeader('Content-Length')) {
    res.setHeader('Content-Length', response.body.length);
  }

  res.statusCode = response.status;
  res.end(response.body);
}

function isGitPath(path: string): boolean {
  // Match /<owner>/<repo>.git/<endpoint>, preserving the complete path
  // for the git handler, which validates the endpoint and service.
  const ownerEnd = path.indexOf('/', 1);
  if (ownerEnd <= 1) return false;

  const repoEnd = path.indexOf('/', ownerEnd + 1);
  if (repoEnd < 0) return false;

  const owner = path.slice(1, ownerEnd);
  const repoSegment = path.slice(ownerEnd + 1, repoEnd);
  const repo = repoSegment.endsWith('.git')
    ? repoSegment.slice(0, -4)
    : '';

  return owner.length > 0 && repo.length > 0;
}

export function createApp(): http.Server {
  const ctx: Ctx = {
    token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
    trialNowMs:
      Number(process.env.MAKEFUN_TRIAL_NOW) || 1735689600000,
    seed: process.env.MAKEFUN_TRIAL_SEED ?? '',
  };
  const store: Store = createStore(ctx);

  return http.createServer((req, res) => {
    // Avoid introducing a wall-clock Date header into application replies.
    res.sendDate = false;

    const serve = async (): Promise<void> => {
      let requestId = '';

      const reply = (status: number, body: unknown): void => {
        sendJson(res, requestId, { status, headers: {}, body });
      };

      try {
        requestId = store.nextRequestId();
        res.setHeader('X-GitHub-Request-Id', requestId);

        const method = req.method ?? 'GET';
        // Fast path: GET/HEAD/DELETE with no framing headers carry no body,
        // so skip the async-iterator body read entirely. Anything framed
        // (Content-Length other than 0, or chunked) and every other method
        // still goes through readBody.
        const contentLength = req.headers['content-length'];
        const framed =
          (typeof contentLength === 'string' &&
            contentLength !== '' &&
            contentLength !== '0') ||
          req.headers['transfer-encoding'] !== undefined;
        const body =
          framed || (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE')
            ? await readBody(req)
            : Buffer.alloc(0);
        if (body === null) {
          reply(413, { message: 'Request Entity Too Large' });
          return;
        }

        const rawUrl = req.url ?? '/';
        // Split path/query without a full URL parse: the suite sends
        // origin-form targets, and URLSearchParams over the raw query string
        // parses identically to new URL().searchParams (repeated keys,
        // empty values, percent-encoding all preserved; segments() still
        // decodes path segments as before). Absolute-form targets fall back
        // to the URL parser.
        let path: string;
        let query: URLSearchParams;
        if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
          const parsed = new URL(rawUrl);
          path = parsed.pathname;
          query = parsed.searchParams;
        } else {
          const qIndex = rawUrl.indexOf('?');
          path = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
          query =
            qIndex === -1
              ? new URLSearchParams()
              : new URLSearchParams(rawUrl.slice(qIndex + 1));
        }
        const headers = requestHeaders(req);

        if (method === 'GET' && path === '/healthz') {
          reply(200, { ok: true });
          return;
        }

        if (
          ctx.token !== '' &&
          headers.authorization !== `Bearer ${ctx.token}`
        ) {
          reply(401, { message: 'Bad credentials' });
          return;
        }

        const restRoute = path.startsWith('/api/v3');
        const graphqlRoute =
          method === 'POST' && path === '/api/graphql';

        if (restRoute || graphqlRoute) {
          let json: unknown = undefined;

          if (body.length > 0) {
            try {
              json = JSON.parse(body.toString('utf8'));
            } catch {
              reply(400, { message: 'Invalid JSON' });
              return;
            }
          }

          const request: RestRequest = {
            method,
            path,
            query,
            headers,
            body,
            json,
          };

          const response = restRoute
            ? await handleRest(request, store)
            : await handleGraphql(request, store);

          sendJson(res, requestId, response);
          return;
        }

        if (
          path === '/mcp' &&
          (method === 'POST' || method === 'DELETE')
        ) {
          const request: RestRequest = {
            method,
            path,
            query,
            headers,
            body,
            // MCP owns parsing, including JSON-RPC parse-error responses.
            json: undefined,
          };

          const response = await handleMcp(request, store);
          sendJson(res, requestId, response);
          return;
        }

        if (isGitPath(path)) {
          const request: GitRequest = {
            method,
            path,
            query,
            headers,
            body,
          };

          const response = await handleGit(request, store);
          sendGit(res, requestId, response);
          return;
        }

        reply(404, { message: 'Not Found' });
      } catch {
        if (res.destroyed || res.writableEnded) return;

        if (res.headersSent) {
          // A response already on the wire cannot be replaced with JSON.
          res.destroy();
          return;
        }

        try {
          // Discard any partially applied handler headers before the 500.
          for (const name of res.getHeaderNames()) {
            res.removeHeader(name);
          }

          if (!requestId) requestId = store.nextRequestId();
          reply(500, { message: 'Internal Server Error' });
        } catch {
          // Transport failures must not become unhandled rejections.
          res.destroy();
        }
      }
    };

    void serve();
  });
}
