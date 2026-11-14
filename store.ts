import { hashObject, sha1Hex } from './gitobj.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface Ctx {
  token: string;
  trialNowMs: number;
  seed: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  authorLogin: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  databaseId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface Pull {
  number: number;
  databaseId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  name: string;
  owner: string | null;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  counter: number;
  databaseId: number;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  branches: Map<string, string>;
  refs: Map<string, string>;
  objects: Map<string, { type: ObjectType; content: Buffer }>;
}

export interface Store {
  ctx: Ctx;
  repos: Map<string, Repo>;
  ownerLogin: string | null;
  nextDbId: number;
  reqCounter: number;
  clockBaseMs: number;
  clockTicks: number;
  now(): { iso: string; unix: number };
  nextRequestId(): string;
  nextDatabaseId(): number;
  createRepo(name: string, opts: { private?: boolean; description?: string; defaultBranch?: string }): Repo;
  getRepo(owner: string, name: string): Repo | null;
  findRepoByName(name: string): Repo | undefined;
  nextNumber(repo: Repo): number;
  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[]; authorLogin: string }): Issue;
  createPull(repo: Repo, input: { title: string; body?: string; headRef: string; baseRef: string; authorLogin: string }): Pull;
  createLabel(repo: Repo, input: { name: string; color?: string; description?: string }): Label;
  putObject(repo: Repo, type: ObjectType, content: Buffer): string;
  getObject(repo: Repo, sha: string): { type: ObjectType; content: Buffer } | undefined;
  commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string, authorLogin: string): string;
  squashMerge(repo: Repo, pull: Pull, authorLogin: string): string;
  toGqlId(kind: string, databaseId: number): string;
  fromGqlId(id: string): { kind: string; databaseId: number } | null;
}

function compareTreeEntryNames(aName: string, aIsDir: boolean, bName: string, bIsDir: boolean): number {
  const aKey = aIsDir ? aName + '/' : aName;
  const bKey = bIsDir ? bName + '/' : bName;
  if (aKey < bKey) return -1;
  if (aKey > bKey) return 1;
  return 0;
}

function parseTreeObject(content: Buffer): Map<string, { mode: string; sha: string; isDir: boolean }> {
  const map = new Map<string, { mode: string; sha: string; isDir: boolean }>();
  let offset = 0;
  while (offset < content.length) {
    const spaceIdx = content.indexOf(32, offset);
    if (spaceIdx === -1) break;
    const mode = content.toString('utf8', offset, spaceIdx);
    const nullIdx = content.indexOf(0, spaceIdx + 1);
    if (nullIdx === -1) break;
    const name = content.toString('utf8', spaceIdx + 1, nullIdx);
    const shaBuf = content.subarray(nullIdx + 1, nullIdx + 21);
    const sha = shaBuf.toString('hex');
    const isDir = mode === '40000';
    map.set(name, { mode, sha, isDir });
    offset = nullIdx + 21;
  }
  return map;
}

function encodeTreeObject(entries: Array<{ mode: string; name: string; sha: string; isDir: boolean }>): Buffer {
  entries.sort((a, b) => compareTreeEntryNames(a.name, a.isDir, b.name, b.isDir));
  const buffers: Buffer[] = [];
  for (const entry of entries) {
    const modeNameBuf = Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8');
    const shaBuf = Buffer.from(entry.sha, 'hex');
    buffers.push(modeNameBuf, shaBuf);
  }
  return Buffer.concat(buffers);
}

function updateTreeWithFile(
  repo: Repo,
  treeSha: string | undefined,
  segments: string[],
  blobSha: string
): string {
  const name = segments[0];
  const entriesMap = treeSha ? parseTreeObject(repo.objects.get(treeSha)!.content) : new Map();

  if (segments.length === 1) {
    entriesMap.set(name, { mode: '100644', sha: blobSha, isDir: false });
  } else {
    const existing = entriesMap.get(name);
    const subTreeSha = existing && existing.isDir ? existing.sha : undefined;
    const newSubTreeSha = updateTreeWithFile(repo, subTreeSha, segments.slice(1), blobSha);
    entriesMap.set(name, { mode: '40000', sha: newSubTreeSha, isDir: true });
  }

  const entries: Array<{ mode: string; name: string; sha: string; isDir: boolean }> = [];
  for (const [n, val] of entriesMap.entries()) {
    entries.push({ name: n, ...val });
  }
  const treeBuf = encodeTreeObject(entries);
  return putObjectToRepo(repo, 'tree', treeBuf);
}

function putObjectToRepo(repo: Repo, type: ObjectType, content: Buffer): string {
  const { sha } = hashObject(type, content);
  repo.objects.set(sha.toLowerCase(), { type, content });
  return sha;
}

export function createStore(ctx: Ctx): Store {
  const trialNowMs = ctx.trialNowMs || 1735689600000;
  return {
    ctx,
    repos: new Map<string, Repo>(),
    ownerLogin: null,
    nextDbId: 0,
    reqCounter: 0,
    clockBaseMs: trialNowMs,
    clockTicks: 0,
    now() {
      const ms = this.clockBaseMs + this.clockTicks * 1000;
      this.clockTicks++;
      return { iso: new Date(ms).toISOString(), unix: Math.floor(ms / 1000) };
    },
    nextRequestId() {
      return `req-${++this.reqCounter}`;
    },
    nextDatabaseId() {
      return ++this.nextDbId;
    },
    createRepo(name: string, opts: { private?: boolean; description?: string; defaultBranch?: string }): Repo {
      const defaultBranch = opts.defaultBranch ?? 'main';
      const time = this.now().iso;
      const repo: Repo = {
        name,
        owner: this.ownerLogin,
        private: opts.private ?? true,
        description: opts.description ?? '',
        defaultBranch,
        createdAt: time,
        updatedAt: time,
        pushedAt: time,
        counter: 0,
        databaseId: this.nextDatabaseId(),
        labels: new Map(),
        issues: new Map(),
        pulls: new Map(),
        branches: new Map(),
        refs: new Map(),
        objects: new Map(),
      };
      this.repos.set(name, repo);
      return repo;
    },
    getRepo(owner: string, name: string): Repo | null {
      const repo = this.repos.get(name);
      if (!repo) return null;
      if (repo.owner === null) {
        repo.owner = owner;
        this.ownerLogin = owner;
        return repo;
      }
      if (repo.owner === owner) {
        return repo;
      }
      return null;
    },
    findRepoByName(name: string): Repo | undefined {
      return this.repos.get(name);
    },
    nextNumber(repo: Repo): number {
      return ++repo.counter;
    },
    createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[]; authorLogin: string }): Issue {
      const number = this.nextNumber(repo);
      const databaseId = this.nextDatabaseId();
      const time = this.now().iso;
      const issue: Issue = {
        number,
        databaseId,
        title: input.title,
        body: input.body ?? '',
        state: 'open',
        labels: input.labels ?? [],
        authorLogin: input.authorLogin,
        createdAt: time,
        updatedAt: time,
        closedAt: null,
        comments: [],
      };
      repo.issues.set(number, issue);
      return issue;
    },
    createPull(repo: Repo, input: { title: string; body?: string; headRef: string; baseRef: string; authorLogin: string }): Pull {
      const number = this.nextNumber(repo);
      const databaseId = this.nextDatabaseId();
      const time = this.now().iso;
      const headSha = repo.branches.get(input.headRef) ?? '0'.repeat(40);
      const baseSha = repo.branches.get(input.baseRef) ?? '0'.repeat(40);
      const pull: Pull = {
        number,
        databaseId,
        title: input.title,
        body: input.body ?? '',
        state: 'open',
        merged: false,
        mergeable: true,
        headRef: input.headRef,
        headSha,
        baseRef: input.baseRef,
        baseSha,
        authorLogin: input.authorLogin,
        createdAt: time,
        updatedAt: time,
        mergedAt: null,
        mergeCommitSha: null,
      };
      repo.pulls.set(number, pull);
      return pull;
    },
    createLabel(repo: Repo, input: { name: string; color?: string; description?: string }): Label {
      const label: Label = {
        name: input.name,
        color: input.color ?? 'ededed',
        description: input.description ?? '',
      };
      repo.labels.set(input.name, label);
      return label;
    },
    putObject(repo: Repo, type: ObjectType, content: Buffer): string {
      return putObjectToRepo(repo, type, content);
    },
    getObject(repo: Repo, sha: string): { type: ObjectType; content: Buffer } | undefined {
      return repo.objects.get(sha.toLowerCase());
    },
    commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string, authorLogin: string): string {
      const blobSha = this.putObject(repo, 'blob', content);
      const headCommitSha = repo.branches.get(branch);
      let treeSha: string | undefined = undefined;
      const parents: string[] = [];

      if (headCommitSha) {
        parents.push(headCommitSha);
        const commitObj = repo.objects.get(headCommitSha);
        if (commitObj) {
          const commitStr = commitObj.content.toString('utf8');
          const match = commitStr.match(/^tree\s+([0-9a-f]{40})/m);
          if (match) {
            treeSha = match[1];
          }
        }
      }

      const segments = path.split('/').filter(Boolean);
      const newTreeSha = updateTreeWithFile(repo, treeSha, segments, blobSha);

      const t = this.now();
      const commitLines: string[] = [
        `tree ${newTreeSha}`,
      ];
      for (const p of parents) {
        commitLines.push(`parent ${p}`);
      }
      commitLines.push(`author ${authorLogin} <${authorLogin}@users.noreply.github.com> ${t.unix} +0000`);
      commitLines.push(`committer ${authorLogin} <${authorLogin}@users.noreply.github.com> ${t.unix} +0000`);
      commitLines.push('');
      commitLines.push(message.endsWith('\n') ? message : message + '\n');

      const commitContent = Buffer.from(commitLines.join('\n'), 'utf8');
      const commitSha = this.putObject(repo, 'commit', commitContent);

      repo.branches.set(branch, commitSha);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      repo.updatedAt = t.iso;
      repo.pushedAt = t.iso;

      return commitSha;
    },
    squashMerge(repo: Repo, pull: Pull, authorLogin: string): string {
      const headSha = repo.branches.get(pull.headRef) ?? pull.headSha;
      const headObj = repo.objects.get(headSha);
      let treeSha = '0'.repeat(40);
      if (headObj) {
        const match = headObj.content.toString('utf8').match(/^tree\s+([0-9a-f]{40})/m);
        if (match) treeSha = match[1];
      }

      const baseSha = repo.branches.get(pull.baseRef) ?? pull.baseSha;
      const parents: string[] = [];
      if (baseSha && repo.objects.has(baseSha)) {
        parents.push(baseSha);
      }

      const t = this.now();
      const commitLines: string[] = [
        `tree ${treeSha}`,
      ];
      for (const p of parents) {
        commitLines.push(`parent ${p}`);
      }
      commitLines.push(`author ${authorLogin} <${authorLogin}@users.noreply.github.com> ${t.unix} +0000`);
      commitLines.push(`committer ${authorLogin} <${authorLogin}@users.noreply.github.com> ${t.unix} +0000`);
      commitLines.push('');
      commitLines.push(`Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`);

      const commitContent = Buffer.from(commitLines.join('\n'), 'utf8');
      const mergeCommitSha = this.putObject(repo, 'commit', commitContent);

      repo.branches.set(pull.baseRef, mergeCommitSha);
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommitSha);

      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = t.iso;
      pull.mergeCommitSha = mergeCommitSha;
      pull.updatedAt = t.iso;
      repo.updatedAt = t.iso;

      return mergeCommitSha;
    },
    toGqlId(kind: string, databaseId: number): string {
      return Buffer.from(`${kind}:${databaseId}`).toString('base64url');
    },
    fromGqlId(id: string): { kind: string; databaseId: number } | null {
      try {
        const decoded = Buffer.from(id, 'base64url').toString('utf8');
        const parts = decoded.split(':');
        if (parts.length !== 2) return null;
        const databaseId = Number(parts[1]);
        if (isNaN(databaseId)) return null;
        return { kind: parts[0], databaseId };
      } catch {
        return null;
      }
    },
  };
}
