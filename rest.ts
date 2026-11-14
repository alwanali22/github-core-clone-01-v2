import type { Store, Repo } from './store.ts';
import { hashObject } from './gitobj.ts';

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
  json: unknown;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

type TreeEntry = {
  mode: string;
  name: string;
  sha: string;
  dir: boolean;
};

type FlatFile = {
  mode: string;
  sha: string;
};

function response(
  store: Store,
  status: number,
  body?: unknown,
  extra?: Record<string, string>,
): RestResponse {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': store.nextRequestId(),
    ...extra,
  };
  return { status, headers, body };
}

function error(store: Store, status: number, message: string): RestResponse {
  return response(store, status, { message });
}

function queryValue(req: RestRequest, name: string): string | undefined {
  return req.query.get(name) ?? undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function cleanPath(path: string): string {
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

function segments(path: string): string[] {
  return cleanPath(path).split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

function authOk(req: RestRequest, store: Store): boolean {
  if (!store.ctx.token) return true;
  const value = req.headers.authorization ?? req.headers.Authorization;
  return value === `Bearer ${store.ctx.token}`;
}

function ownerLogin(store: Store): string {
  return store.ownerLogin ?? 'octocat';
}

function repoBody(repo: Repo, store: Store): Record<string, unknown> {
  const owner = repo.owner ?? ownerLogin(store);
  return {
    id: repo.databaseId,
    databaseId: repo.databaseId,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${owner}/${repo.name}`,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
  };
}

function parseCommit(
  repo: Repo,
  sha: string,
): { tree: string; parents: string[]; message: string } | null {
  const object = repo.objects.get(sha.toLowerCase());
  if (!object || object.type !== 'commit') return null;
  const text = object.content.toString('utf8');
  const tree = text.match(/^tree ([0-9a-f]{40})/m)?.[1];
  if (!tree) return null;
  const parents: string[] = [];
  const parentPattern = /^parent ([0-9a-f]{40})/gm;
  let match: RegExpExecArray | null;
  while ((match = parentPattern.exec(text)) !== null) parents.push(match[1]);
  const split = text.indexOf('\n\n');
  let message = split === -1 ? '' : text.slice(split + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  return { tree, parents, message };
}

function parseTree(content: Buffer): TreeEntry[] {
  const result: TreeEntry[] = [];
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(32, offset);
    if (space < 0) break;
    const mode = content.toString('utf8', offset, space);
    const nul = content.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > content.length) break;
    const name = content.toString('utf8', space + 1, nul);
    const sha = content.subarray(nul + 1, nul + 21).toString('hex');
    result.push({ mode, name, sha, dir: mode === '40000' });
    offset = nul + 21;
  }
  return result;
}

function flattenTree(
  repo: Repo,
  treeSha: string,
  prefix = '',
  out = new Map<string, FlatFile>(),
): Map<string, FlatFile> {
  const object = repo.objects.get(treeSha.toLowerCase());
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.content)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.dir) flattenTree(repo, entry.sha, path, out);
    else out.set(path, { mode: entry.mode, sha: entry.sha });
  }
  return out;
}

function treeAt(repo: Repo, commitSha: string | undefined): Map<string, FlatFile> {
  if (!commitSha) return new Map();
  const commit = parseCommit(repo, commitSha);
  return commit ? flattenTree(repo, commit.tree) : new Map();
}

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.branches.get(branch) ?? repo.refs.get(`refs/heads/${branch}`);
}

function contentsTip(repo: Repo, ref: string): string | undefined {
  const branch = branchTip(repo, ref);
  if (branch) return branch;
  const sha = ref.toLowerCase();
  return repo.objects.get(sha)?.type === 'commit' ? sha : undefined;
}

function blobBytes(repo: Repo, sha: string): Buffer | undefined {
  const object = repo.objects.get(sha.toLowerCase());
  return object?.type === 'blob' ? object.content : undefined;
}

function contentEntry(repo: Repo, ref: string, path: string): FlatFile | undefined {
  return treeAt(repo, contentsTip(repo, ref)).get(path);
}

function issueBody(
  issue: Store extends never ? never : any,
  repo: Repo,
  store: Store,
): Record<string, unknown> {
  return {
    number: issue.number,
    id: issue.databaseId,
    databaseId: issue.databaseId,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name: string) => repo.labels.get(name) ?? {
      name,
      color: 'ededed',
      description: '',
    }),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    user: { login: issue.authorLogin || ownerLogin(store) },
  };
}

function pullBody(pull: any, repo: Repo, store: Store): Record<string, unknown> {
  return {
    number: pull.number,
    id: pull.databaseId,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner ?? ownerLogin(store)}:${pull.headRef}`,
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner ?? ownerLogin(store)}:${pull.baseRef}`,
    },
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function findMergeBase(repo: Repo, first: string, second: string): string | undefined {
  const seen = new Set<string>();
  const walk = (sha: string | undefined, target: Set<string>): void => {
    if (!sha || target.has(sha)) return;
    target.add(sha);
    const commit = parseCommit(repo, sha);
    if (commit) for (const parent of commit.parents) walk(parent, target);
  };
  walk(first, seen);
  const queue: string[] = second ? [second] : [];
  const visited = new Set<string>();
  while (queue.length) {
    const sha = queue.shift()!;
    if (visited.has(sha)) continue;
    visited.add(sha);
    if (seen.has(sha)) return sha;
    const commit = parseCommit(repo, sha);
    if (commit) queue.push(...commit.parents);
  }
  return undefined;
}

function conflicted(repo: Repo, pull: any): boolean {
  const head = branchTip(repo, pull.headRef) ?? pull.headSha;
  const base = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const mergeBase = findMergeBase(repo, head, base);
  if (!mergeBase) return false;
  const ancestor = treeAt(repo, mergeBase);
  const headTree = treeAt(repo, head);
  const baseTree = treeAt(repo, base);
  const paths = new Set<string>([
    ...ancestor.keys(),
    ...headTree.keys(),
    ...baseTree.keys(),
  ]);
  for (const path of paths) {
    const a = ancestor.get(path)?.sha;
    const h = headTree.get(path)?.sha;
    const b = baseTree.get(path)?.sha;
    if (h !== a && b !== a && h !== b) return true;
  }
  return false;
}

function deletePath(
  repo: Repo,
  branch: string,
  path: string,
  message: string,
  author: string,
  store: Store,
): string {
  const tip = branchTip(repo, branch);
  const commit = parseCommit(repo, tip ?? '');
  const tree = treeAt(repo, tip);
  tree.delete(path);

  const makeTree = (prefix: string): string => {
    const children = new Map<string, { mode: string; sha: string; dir: boolean }>();
    for (const [filePath, value] of tree) {
      if (prefix && !filePath.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? filePath.slice(prefix.length + 1) : filePath;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        children.set(rest, { mode: value.mode, sha: value.sha, dir: false });
      } else {
        const name = rest.slice(0, slash);
        if (!children.has(name)) {
          children.set(name, {
            mode: '40000',
            sha: makeTree(prefix ? `${prefix}/${name}` : name),
            dir: true,
          });
        }
      }
    }
    const entries = [...children.entries()]
      .filter(([, value]) => value.sha)
      .sort((a, b) => {
        const ak = a[1].dir ? `${a[0]}/` : a[0];
        const bk = b[1].dir ? `${b[0]}/` : b[0];
        return ak < bk ? -1 : ak > bk ? 1 : 0;
      });
    const buffers: Buffer[] = [];
    for (const [name, value] of entries) {
      buffers.push(
        Buffer.from(`${value.mode} ${name}\0`),
        Buffer.from(value.sha, 'hex'),
      );
    }
    return buffers.length
      ? store.putObject(repo, 'tree', Buffer.concat(buffers))
      : '';
  };

  const treeSha = makeTree('') || store.putObject(repo, 'tree', Buffer.alloc(0));
  const now = store.now();
  const lines = [`tree ${treeSha}`];
  if (tip && commit) for (const parent of [tip]) lines.push(`parent ${parent}`);
  lines.push(
    `author ${author} <${author}@users.noreply.github.com> ${now.unix} +0000`,
    `committer ${author} <${author}@users.noreply.github.com> ${now.unix} +0000`,
    '',
    message.endsWith('\n') ? message : `${message}\n`,
  );
  const sha = store.putObject(repo, 'commit', Buffer.from(lines.join('\n')));
  repo.branches.set(branch, sha);
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updatedAt = now.iso;
  repo.pushedAt = now.iso;
  return sha;
}

export function handleRest(req: RestRequest, store: Store): RestResponse {
  const raw = cleanPath(req.path);
  if (!raw.startsWith('/api/v3')) return error(store, 404, 'Not found');
  if (!authOk(req, store)) return error(store, 401, 'Bad credentials');

  const route = raw.slice('/api/v3'.length);
  if (req.method === 'GET' && route === '/') {
    return response(
      store,
      200,
      { current_user_url: '/api/v3/user' },
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
  }
  if (req.method === 'GET' && route === '/meta') {
    return response(store, 200, { installed_version: '1.0.0' });
  }

  if (req.method === 'POST' && route === '/user/repos') {
    const body = req.json as any;
    if (!body || typeof body.name !== 'string') {
      return error(store, 400, 'Invalid request body');
    }
    if (store.findRepoByName(body.name)) {
      return error(store, 422, 'Repository already exists');
    }
    const repo = store.createRepo(body.name, {
      private: body.private,
      description: body.description,
      defaultBranch: body.default_branch,
    });
    return response(store, 201, repoBody(repo, store));
  }

  if (req.method === 'GET' && route === '/user/repos') {
    const all = [...store.repos.values()].filter(
      (repo) => !store.ownerLogin || repo.owner === store.ownerLogin,
    );
    const perPage = positiveInteger(queryValue(req, 'per_page'), 30);
    const page = positiveInteger(queryValue(req, 'page'), 1);
    const pages = Math.max(1, Math.ceil(all.length / perPage));
    const start = (page - 1) * perPage;
    const body = all.slice(start, start + perPage).map((repo) => repoBody(repo, store));
    const origin = `http://${req.headers.host || 'localhost'}`;
    const links = [
      `${origin}/api/v3/user/repos?per_page=${perPage}&page=1; rel="first"`,
      `${origin}/api/v3/user/repos?per_page=${perPage}&page=${pages}; rel="last"`,
    ];
    if (page < pages) {
      links.unshift(
        `${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}; rel="next"`,
      );
    }
    return response(store, 200, body, {
      Link: links.map((x) => `<${x.replace('; rel=', '>; rel=')}`).join(', '),
    });
  }

  const parts = segments(route);
  if (parts[0] !== 'repos' || parts.length < 2) {
    return error(store, 404, 'Not found');
  }
  const owner = parts[1];
  const name = parts[2];
  if (!name) return error(store, 404, 'Not found');
  const repo = store.getRepo(owner, name);
  if (!repo) return error(store, 404, 'Not found');

  if (parts.length === 3) {
    if (req.method === 'GET') return response(store, 200, repoBody(repo, store));
    if (req.method === 'PATCH') {
      const body = req.json as any;
      if (body && typeof body.description === 'string') {
        repo.description = body.description;
      }
      repo.updatedAt = store.now().iso;
      return response(store, 200, repoBody(repo, store));
    }
    if (req.method === 'DELETE') {
      store.repos.delete(repo.name);
      return response(store, 204);
    }
  }

  const sub = parts[3];

  if (sub === 'branches' && req.method === 'GET') {
    const refs = new Map<string, string>();
    for (const [branch, sha] of repo.branches) refs.set(branch, sha);
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) refs.set(ref.slice(11), sha);
    }
    return response(
      store,
      200,
      [...refs].map(([branch, sha]) => ({ name: branch, commit: { sha } })),
    );
  }

  if (sub === 'commits' && req.method === 'GET') {
    const branch = queryValue(req, 'sha') ?? repo.defaultBranch;
    let sha = branchTip(repo, branch)
      ?? (repo.objects.has(branch) ? branch : undefined);
    const result: unknown[] = [];
    const seen = new Set<string>();
    while (sha && !seen.has(sha)) {
      seen.add(sha);
      const commit = parseCommit(repo, sha);
      if (!commit) break;
      result.push({ sha, commit: { message: commit.message } });
      sha = commit.parents[0];
    }
    return response(store, 200, result);
  }

  if (sub === 'git' && parts[4] === 'refs' && req.method === 'POST') {
    const body = req.json as any;
    const ref = body?.ref;
    const sha = body?.sha;
    if (typeof ref !== 'string' || typeof sha !== 'string') {
      return error(store, 422, 'Invalid ref');
    }
    if (!repo.objects.has(sha.toLowerCase())) {
      return error(store, 404, 'Object not found');
    }
    if (repo.refs.has(ref)) {
      return error(store, 422, 'Reference already exists');
    }
    repo.refs.set(ref, sha);
    if (ref.startsWith('refs/heads/')) repo.branches.set(ref.slice(11), sha);
    return response(store, 201, { ref, object: { sha } });
  }

  if (sub === 'contents') {
    const path = parts.slice(4).join('/');
    const branch = queryValue(req, 'ref') ?? repo.defaultBranch;
    if (!path) return error(store, 404, 'Content not found');

    if (req.method === 'GET') {
      const entry = contentEntry(repo, branch, path);
      if (entry) {
        const bytes = blobBytes(repo, entry.sha) ?? Buffer.alloc(0);
        return response(store, 200, {
          type: 'file',
          encoding: 'base64',
          content: bytes.toString('base64'),
          sha: entry.sha,
          size: bytes.length,
        });
      }
      const prefix = `${path}/`;
      const tree = treeAt(repo, contentsTip(repo, branch));
      const children = new Map<string, FlatFile>();
      for (const [filePath, value] of tree) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf('/');
        const child = slash === -1 ? rest : rest.slice(0, slash);
        if (!children.has(child)) children.set(child, value);
      }
      if (!children.size) return error(store, 404, 'Content not found');
      return response(store, 200, [...children].map(([child, value]) => ({
        type: tree.has(`${prefix}${child}`) ? 'file' : 'dir',
        name: child,
        path: `${path}/${child}`,
        sha: value.sha,
      })));
    }

    if (req.method === 'PUT') {
      const body = req.json as any;
      if (
        !body
        || typeof body.content !== 'string'
        || typeof body.message !== 'string'
      ) {
        return error(store, 400, 'Invalid request body');
      }
      const targetBranch = typeof body.branch === 'string'
        ? body.branch
        : repo.defaultBranch;
      const current = contentEntry(repo, targetBranch, path);
      if (
        current
        && (
          typeof body.sha !== 'string'
          || body.sha.toLowerCase() !== current.sha.toLowerCase()
        )
      ) {
        return error(store, 409, 'Content sha does not match');
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(body.content, 'base64');
      } catch {
        return error(store, 400, 'Invalid content');
      }
      const commitSha = store.commitFile(
        repo,
        targetBranch,
        path,
        bytes,
        body.message,
        ownerLogin(store),
      );
      const blobSha = hashObject('blob', bytes).sha.toLowerCase();
      return response(store, current ? 200 : 201, {
        content: {
          name: path.split('/').pop(),
          path,
          sha: blobSha,
          encoding: 'base64',
        },
        commit: { sha: commitSha },
      });
    }

    if (req.method === 'DELETE') {
      const body = req.json as any;
      const current = contentEntry(repo, branch, path);
      if (!current) return error(store, 404, 'Content not found');
      if (
        typeof body?.sha !== 'string'
        || body.sha.toLowerCase() !== current.sha.toLowerCase()
      ) {
        return error(store, 409, 'Content sha does not match');
      }
      const commitSha = deletePath(
        repo,
        branch,
        path,
        body.message ?? 'Delete file',
        ownerLogin(store),
        store,
      );
      return response(store, 200, { commit: { sha: commitSha } });
    }
  }

  if (sub === 'labels' && req.method === 'POST') {
    const body = req.json as any;
    if (!body || typeof body.name !== 'string') {
      return error(store, 422, 'Invalid label');
    }
    return response(store, 201, store.createLabel(repo, {
      name: body.name,
      color: body.color,
      description: body.description,
    }));
  }

  if (sub === 'issues') {
    const number = parts[4] ? Number(parts[4]) : undefined;
    const issue = number ? repo.issues.get(number) : undefined;

    if (req.method === 'POST' && parts.length === 4) {
      const body = req.json as any;
      const labels = Array.isArray(body?.labels) ? body.labels : [];
      if (labels.some((label: string) => !repo.labels.has(label))) {
        return error(store, 422, 'Label does not exist');
      }
      const created = store.createIssue(repo, {
        title: body?.title ?? '',
        body: body?.body ?? '',
        labels,
        authorLogin: ownerLogin(store),
      });
      return response(store, 201, issueBody(created, repo, store));
    }

    if (number && parts[5] === 'comments') {
      if (!issue) return error(store, 404, 'Issue not found');
      if (req.method === 'POST') {
        const body = req.json as any;
        const comment = {
          id: store.nextDatabaseId(),
          body: body?.body ?? '',
          authorLogin: ownerLogin(store),
          createdAt: store.now().iso,
        };
        issue.comments.push(comment);
        return response(store, 201, { id: comment.id, body: comment.body });
      }
      if (req.method === 'GET') {
        return response(
          store,
          200,
          issue.comments.map((comment: any) => ({
            id: comment.id,
            body: comment.body,
          })),
        );
      }
    }

    if (number && parts.length === 5) {
      if (!issue) return error(store, 404, 'Issue not found');
      if (req.method === 'GET') {
        return response(store, 200, issueBody(issue, repo, store));
      }
      if (req.method === 'PATCH') {
        const body = req.json as any;
        if (body?.state === 'closed' || body?.state === 'open') {
          issue.state = body.state;
          issue.closedAt = body.state === 'closed' ? store.now().iso : null;
          issue.updatedAt = issue.closedAt ?? store.now().iso;
        }
        return response(store, 200, issueBody(issue, repo, store));
      }
    }

    if (req.method === 'GET' && parts.length === 4) {
      let issues = [...repo.issues.values()];
      const state = queryValue(req, 'state') ?? 'open';
      if (state !== 'all') {
        issues = issues.filter((item) => item.state === state);
      }
      issues.sort((a, b) => a.number - b.number);
      if (queryValue(req, 'direction') === 'desc') issues.reverse();
      const perPage = positiveInteger(queryValue(req, 'per_page'), 30);
      return response(
        store,
        200,
        issues.slice(0, perPage).map((item) => issueBody(item, repo, store)),
      );
    }
  }

  if (sub === 'pulls') {
    const number = parts[4] ? Number(parts[4]) : undefined;
    const pull = number ? repo.pulls.get(number) : undefined;

    if (req.method === 'POST' && parts.length === 4) {
      const body = req.json as any;
      const created = store.createPull(repo, {
        title: body?.title ?? '',
        body: body?.body ?? '',
        headRef: body?.head ?? '',
        baseRef: body?.base ?? repo.defaultBranch,
        authorLogin: ownerLogin(store),
      });
      return response(store, 201, pullBody(created, repo, store));
    }

    if (number && parts[5] === 'files' && req.method === 'GET') {
      if (!pull) return error(store, 404, 'Pull request not found');
      const base = treeAt(repo, branchTip(repo, pull.baseRef) ?? pull.baseSha);
      const head = treeAt(repo, branchTip(repo, pull.headRef) ?? pull.headSha);
      const paths = new Set([...base.keys(), ...head.keys()]);
      const files: unknown[] = [];
      for (const path of paths) {
        const before = base.get(path)?.sha;
        const after = head.get(path)?.sha;
        if (before === after) continue;
        const oldBytes = before
          ? blobBytes(repo, before) ?? Buffer.alloc(0)
          : Buffer.alloc(0);
        const newBytes = after
          ? blobBytes(repo, after) ?? Buffer.alloc(0)
          : Buffer.alloc(0);
        const additions = newBytes.length
          ? newBytes.toString('utf8').split('\n').length
          : 0;
        const deletions = oldBytes.length
          ? oldBytes.toString('utf8').split('\n').length
          : 0;
        files.push({
          filename: path,
          status: !before ? 'added' : !after ? 'removed' : 'modified',
          additions,
          deletions,
          changes: additions + deletions,
        });
      }
      return response(store, 200, files);
    }

    if (number && parts[5] === 'merge' && req.method === 'PUT') {
      if (!pull) return error(store, 404, 'Pull request not found');
      if (conflicted(repo, pull)) {
        return error(store, 405, 'Pull request cannot be merged');
      }
      const sha = store.squashMerge(repo, pull, ownerLogin(store));
      return response(store, 200, {
        sha,
        merged: true,
        message: 'Pull request successfully merged',
      });
    }

    if (number && parts.length === 5) {
      if (!pull) return error(store, 404, 'Pull request not found');
      if (req.method === 'GET') {
        return response(store, 200, pullBody(pull, repo, store));
      }
    }

    if (req.method === 'GET' && parts.length === 4) {
      const state = queryValue(req, 'state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') {
        pulls = pulls.filter((item) => item.state === state);
      }
      const perPage = positiveInteger(queryValue(req, 'per_page'), 30);
      return response(
        store,
        200,
        pulls.slice(0, perPage).map((item) => pullBody(item, repo, store)),
      );
    }
  }

  return error(store, 404, 'Not found');
}
