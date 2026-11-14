import type { Store, Repo, Issue, Pull } from './store.ts';
import type { RestRequest, RestResponse } from './rest.ts';

type Value =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

type Selection =
  | {
      kind: 'field';
      name: string;
      alias: string;
      args: Record<string, Value>;
      selections: Selection[];
    }
  | { kind: 'fragment'; type: string; selections: Selection[] };

type TypeRef = {
  name?: string;
  item?: TypeRef;
  required: boolean;
};

type VariableDefinition = {
  name: string;
  type: TypeRef;
  defaultValue?: Value;
};

type Operation = {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: VariableDefinition[];
  selections: Selection[];
};

type Token = {
  kind: 'name' | 'string' | 'number' | 'punct' | 'eof';
  text: string;
};

type RuntimeObject = {
  type: string;
  value: unknown;
  repo?: Repo;
  idOverride?: string;
};

type Envelope = {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
};

const queryNames = new Set([
  'ViewerLogin',
  'RepositoryFields',
  'Issue_fields',
  'PullRequestAndRepositoryFields',
  'SearchType_enumValues',
  'OpenIssues',
  'IssueByNumber',
  'PullRequests',
  'PullRequestFiles',
  'PullRequestId',
  'IssuesPage',
  'ViewerInvalidField',
  'NodeRepository',
]);

const mutationNames = new Set([
  'IssueCreate',
  'IssueClose',
  'PullRequestCreate',
  'MergePullRequest',
  'AddComment',
]);

// A null field type is a scalar; other entries name the selected object type.
// Lists use the same entry as their individual elements.
const schema: Record<string, Record<string, string | null>> = {
  Query: {
    viewer: 'User',
    repository: 'Repository',
    node: 'Node',
    __type: '__Type',
  },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    id: null,
    databaseId: null,
    name: null,
    nameWithOwner: null,
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: null,
    hasIssuesEnabled: null,
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  Issue: {
    id: null,
    number: null,
    title: null,
    body: null,
    state: null,
    author: 'User',
    comments: 'IssueCommentConnection',
  },
  PullRequest: {
    id: null,
    number: null,
    headRefName: null,
    baseRefName: null,
    mergeable: null,
    state: null,
    merged: null,
    files: 'PullRequestChangedFileConnection',
  },
  User: { login: null },
  Ref: { name: null, target: 'Commit' },
  Commit: { oid: null },
  Node: { id: null },
  PageInfo: { hasNextPage: null, endCursor: null },
  IssueConnection: {
    nodes: 'Issue',
    pageInfo: 'PageInfo',
    edges: 'IssueEdge',
  },
  PullRequestConnection: {
    nodes: 'PullRequest',
    pageInfo: 'PageInfo',
    edges: 'PullRequestEdge',
  },
  PullRequestChangedFileConnection: {
    nodes: 'PullRequestChangedFile',
    pageInfo: 'PageInfo',
    edges: 'PullRequestChangedFileEdge',
  },
  IssueCommentConnection: {
    nodes: 'IssueComment',
    pageInfo: 'PageInfo',
    edges: 'IssueCommentEdge',
  },
  IssueEdge: { node: 'Issue', cursor: null },
  PullRequestEdge: { node: 'PullRequest', cursor: null },
  PullRequestChangedFileEdge: {
    node: 'PullRequestChangedFile',
    cursor: null,
  },
  IssueCommentEdge: { node: 'IssueComment', cursor: null },
  PullRequestChangedFile: { path: null, additions: null, deletions: null },
  IssueComment: { id: null, body: null },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  __Type: {
    name: null,
    kind: null,
    fields: '__Field',
    enumValues: '__EnumValue',
  },
  __Field: { name: null },
  __EnumValue: { name: null },
};

const introspectionFields: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: [
    'id', 'number', 'headRefName', 'baseRefName',
    'mergeable', 'state', 'merged', 'files',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
    'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
};

const enumValues: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function invalid(): never {
  throw new Error('Invalid GraphQL request.');
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string') return invalid();
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return invalid();
  }
  return value;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c) || c === ',' || c === '\uFEFF') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', text: '...' });
      i += 3;
      continue;
    }
    if (c === '"') {
      const start = i++;
      let ended = false;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
        } else if (source[i++] === '"') {
          ended = true;
          break;
        }
      }
      if (!ended) invalid();
      const decoded: unknown = JSON.parse(source.slice(start, i));
      tokens.push({ kind: 'string', text: string(decoded) });
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (name) {
      tokens.push({ kind: 'name', text: name[0] });
      i += name[0].length;
      continue;
    }
    const number = /^-?(?:0|[1-9][0-9]*)/.exec(source.slice(i));
    if (number) {
      tokens.push({ kind: 'number', text: number[0] });
      i += number[0].length;
      continue;
    }
    if ('!$():={}[]'.includes(c)) {
      tokens.push({ kind: 'punct', text: c });
      i++;
      continue;
    }
    invalid();
  }
  tokens.push({ kind: 'eof', text: '' });
  return tokens;
}

class Parser {
  tokens: Token[];
  position = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  peek(text: string): boolean {
    const token = this.tokens[this.position];
    return token.kind === 'punct' && token.text === text;
  }

  take(text: string): boolean {
    if (!this.peek(text)) return false;
    this.position++;
    return true;
  }

  expect(text: string): void {
    if (!this.take(text)) invalid();
  }

  name(): string {
    const token = this.tokens[this.position++];
    if (!token || token.kind !== 'name') return invalid();
    return token.text;
  }

  typeRef(): TypeRef {
    let type: TypeRef;
    if (this.take('[')) {
      const item = this.typeRef();
      this.expect(']');
      type = { item, required: false };
    } else {
      type = { name: this.name(), required: false };
    }
    type.required = this.take('!');
    return type;
  }

  value(): Value {
    if (this.take('$')) return { kind: 'variable', name: this.name() };
    if (this.take('[')) {
      const items: Value[] = [];
      while (!this.take(']')) items.push(this.value());
      return { kind: 'list', items };
    }
    if (this.take('{')) {
      const fields: Record<string, Value> = Object.create(null);
      while (!this.take('}')) {
        const name = this.name();
        this.expect(':');
        fields[name] = this.value();
      }
      return { kind: 'object', fields };
    }
    const token = this.tokens[this.position++];
    if (!token) return invalid();
    if (token.kind === 'string') {
      return { kind: 'literal', value: token.text };
    }
    if (token.kind === 'number') {
      return { kind: 'literal', value: integer(Number(token.text)) };
    }
    if (token.kind === 'name') {
      const value = token.text === 'null' ? null
        : token.text === 'true' ? true
        : token.text === 'false' ? false
        : token.text;
      return { kind: 'literal', value };
    }
    return invalid();
  }

  selectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (!this.take('}')) {
      if (this.take('...')) {
        if (this.name() !== 'on') invalid();
        const type = this.name();
        selections.push({
          kind: 'fragment',
          type,
          selections: this.selectionSet(),
        });
        continue;
      }
      const first = this.name();
      const name = this.take(':') ? this.name() : first;
      const args: Record<string, Value> = Object.create(null);
      if (this.take('(')) {
        while (!this.take(')')) {
          const key = this.name();
          this.expect(':');
          args[key] = this.value();
        }
      }
      const children = this.peek('{') ? this.selectionSet() : [];
      selections.push({
        kind: 'field',
        name,
        alias: first,
        args,
        selections: children,
      });
    }
    if (selections.length === 0) invalid();
    return selections;
  }

  document(): Operation[] {
    const operations: Operation[] = [];
    while (this.tokens[this.position].kind !== 'eof') {
      let kind: 'query' | 'mutation' = 'query';
      let name: string | null = null;
      const variables: VariableDefinition[] = [];
      if (!this.peek('{')) {
        const keyword = this.name();
        if (keyword !== 'query' && keyword !== 'mutation') invalid();
        kind = keyword;
        if (this.tokens[this.position].kind === 'name') name = this.name();
        if (this.take('(')) {
          while (!this.take(')')) {
            this.expect('$');
            const variableName = this.name();
            this.expect(':');
            const type = this.typeRef();
            const defaultValue = this.take('=') ? this.value() : undefined;
            variables.push({ name: variableName, type, defaultValue });
          }
        }
      }
      operations.push({ kind, name, variables, selections: this.selectionSet() });
    }
    if (operations.length === 0) invalid();
    return operations;
  }
}

function evaluate(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'literal':
      return value.value;
    case 'variable':
      if (!Object.hasOwn(variables, value.name)) return invalid();
      return variables[value.name];
    case 'list':
      return value.items.map(item => evaluate(item, variables));
    case 'object': {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value.fields)) {
        result[key] = evaluate(item, variables);
      }
      return result;
    }
  }
}

function validateVariable(value: unknown, type: TypeRef): void {
  if (value === undefined || value === null) {
    if (type.required) invalid();
    return;
  }
  if (type.item) {
    if (!Array.isArray(value)) invalid();
    for (const item of value) validateVariable(item, type.item);
    return;
  }
  switch (type.name) {
    case 'String':
    case 'ID':
      string(value);
      break;
    case 'Int':
      integer(value);
      break;
    case 'Boolean':
      if (typeof value !== 'boolean') invalid();
      break;
    default:
      if (type.name?.endsWith('Input') || type.name === 'IssueOrder') {
        record(value);
      } else if (type.name && enumValues[type.name]) {
        if (!enumValues[type.name].includes(string(value))) invalid();
      } else {
        invalid();
      }
  }
}

function validateSelections(type: string, selections: Selection[]): void {
  const fields = schema[type];
  if (!fields) invalid();
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      validateSelections(selection.type, selection.selections);
      continue;
    }
    if (!Object.hasOwn(fields, selection.name)) {
      throw new Error(
        `Cannot query field "${selection.name}" on type "${type}".`,
      );
    }
    const childType = fields[selection.name];
    if (childType === null) {
      if (selection.selections.length !== 0) invalid();
    } else {
      if (selection.selections.length === 0) invalid();
      validateSelections(childType, selection.selections);
    }
  }
}

function object(
  type: string,
  value: unknown,
  repo?: Repo,
  idOverride?: string,
): RuntimeObject {
  return { type, value, repo, idOverride };
}

function cursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function startIndex(after: unknown): number {
  if (after === undefined || after === null) return 0;
  const encoded = string(after);
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  const match = /^cursor:(0|[1-9][0-9]*)$/.exec(decoded);
  if (!match || Buffer.from(decoded).toString('base64url') !== encoded) invalid();
  const index = integer(Number(match[1]));
  if (index < 0 || index >= Number.MAX_SAFE_INTEGER) invalid();
  return index + 1;
}

function pageSize(value: unknown): number {
  if (value === undefined || value === null) return 10;
  const size = integer(value);
  if (size < 0) invalid();
  return size;
}

function connection(
  type: string,
  edgeType: string,
  nodes: RuntimeObject[],
  start: number,
  total: number,
): RuntimeObject {
  return object(type, {
    nodes,
    pageInfo: object('PageInfo', {
      hasNextPage: start + nodes.length < total,
      endCursor: nodes.length ? cursor(start + nodes.length - 1) : null,
    }),
    edges: nodes.map((node, index) => object(edgeType, {
      node,
      cursor: cursor(start + index),
    })),
  });
}

function repoById(store: Store, id: unknown): Repo {
  const decoded = store.fromGqlId(string(id));
  if (!decoded || decoded.kind !== 'Repository') return invalid();
  for (const repo of store.repos.values()) {
    if (repo.databaseId === decoded.databaseId) return repo;
  }
  return invalid();
}

function issueById(store: Store, id: unknown): { repo: Repo; issue: Issue } {
  const decoded = store.fromGqlId(string(id));
  if (!decoded || decoded.kind !== 'Issue') return invalid();
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (issue.databaseId === decoded.databaseId) return { repo, issue };
    }
  }
  return invalid();
}

function pullById(store: Store, id: unknown): { repo: Repo; pull: Pull } {
  const decoded = store.fromGqlId(string(id));
  if (!decoded || decoded.kind !== 'PullRequest') return invalid();
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) {
      if (pull.databaseId === decoded.databaseId) return { repo, pull };
    }
  }
  return invalid();
}

// Only files reads visit git objects. An iterative walk avoids nesting limits
// for valid, deeply nested repositories.
function flattenTree(store: Store, repo: Repo, commitSha: string): Map<string, string> {
  const result = new Map<string, string>();
  const commit = store.getObject(repo, commitSha);
  if (!commit) return result;
  if (commit.type !== 'commit') invalid();
  const match = /^tree ([0-9a-f]{40})/m.exec(commit.content.toString('utf8'));
  if (!match) return invalid();
  const pending = [{ sha: match[1], prefix: '', ancestors: new Set<string>() }];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.ancestors.has(current.sha)) invalid();
    const tree = store.getObject(repo, current.sha);
    if (!tree || tree.type !== 'tree') invalid();
    const ancestors = new Set(current.ancestors);
    ancestors.add(current.sha);
    let offset = 0;
    while (offset < tree.content.length) {
      const space = tree.content.indexOf(32, offset);
      if (space < offset) invalid();
      const zero = tree.content.indexOf(0, space + 1);
      if (zero < 0 || zero + 21 > tree.content.length) invalid();
      const mode = tree.content.toString('ascii', offset, space);
      const name = tree.content.toString('utf8', space + 1, zero);
      const sha = tree.content.subarray(zero + 1, zero + 21).toString('hex');
      const path = current.prefix + name;
      if (mode === '40000' || mode === '040000') {
        pending.push({ sha, prefix: path + '/', ancestors });
      } else {
        result.set(path, sha);
      }
      offset = zero + 21;
    }
  }
  return result;
}

function changedFiles(store: Store, repo: Repo, pull: Pull): RuntimeObject[] {
  const head = flattenTree(
    store, repo, repo.branches.get(pull.headRef) ?? pull.headSha,
  );
  const base = flattenTree(
    store, repo, repo.branches.get(pull.baseRef) ?? pull.baseSha,
  );
  const paths = new Set([...head.keys(), ...base.keys()]);
  return [...paths]
    .filter(path => head.get(path) !== base.get(path))
    .sort()
    .map(path => object('PullRequestChangedFile', {
      path, additions: 0, deletions: 0,
    }));
}

function introspect(name: string): RuntimeObject | null {
  if (Object.hasOwn(enumValues, name)) {
    return object('__Type', {
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: enumValues[name].map(value => object('__EnumValue', {
        name: value,
      })),
    });
  }
  if (!Object.hasOwn(schema, name)) return null;
  const fields = introspectionFields[name] ?? Object.keys(schema[name]);
  return object('__Type', {
    name,
    kind: name === 'Node' ? 'INTERFACE' : 'OBJECT',
    fields: fields.map(field => object('__Field', { name: field })),
    enumValues: null,
  });
}

function mutate(
  name: string,
  args: Record<string, unknown>,
  store: Store,
): RuntimeObject {
  const input = record(args.input);
  const login = store.ownerLogin ?? 'octocat';
  switch (name) {
    case 'createIssue': {
      const repo = repoById(store, input.repositoryId);
      const title = string(input.title);
      const body = input.body == null ? '' : string(input.body);
      const issue = store.createIssue(repo, { title, body, authorLogin: login });
      return object('CreateIssuePayload', {
        issue: object('Issue', issue, repo),
      });
    }
    case 'closeIssue': {
      const { repo, issue } = issueById(store, input.issueId);
      const time = store.now().iso;
      issue.state = 'closed';
      issue.closedAt = time;
      issue.updatedAt = time;
      return object('CloseIssuePayload', {
        issue: object('Issue', issue, repo),
      });
    }
    case 'createPullRequest': {
      const repo = repoById(store, input.repositoryId);
      const title = string(input.title);
      const headRef = string(input.headRefName);
      const baseRef = string(input.baseRefName);
      if (!repo.branches.has(headRef) || !repo.branches.has(baseRef)) invalid();
      const pull = store.createPull(repo, {
        title, body: '', headRef, baseRef, authorLogin: login,
      });
      return object('CreatePullRequestPayload', {
        pullRequest: object('PullRequest', pull, repo),
      });
    }
    case 'mergePullRequest': {
      const { repo, pull } = pullById(store, input.pullRequestId);
      if (input.mergeMethod != null && input.mergeMethod !== 'SQUASH') invalid();
      store.squashMerge(repo, pull, login);
      return object('MergePullRequestPayload', {
        pullRequest: object('PullRequest', pull, repo),
      });
    }
    case 'addComment': {
      const { issue } = issueById(store, input.subjectId);
      const body = input.body == null ? '' : string(input.body);
      const comment = {
        id: store.nextDatabaseId(),
        body,
        authorLogin: login,
        createdAt: store.now().iso,
      };
      issue.comments.push(comment);
      return object('AddCommentPayload', {
        commentEdge: object('IssueCommentEdge', {
          node: object('IssueComment', {
            id: store.toGqlId('Comment', comment.id),
            body: comment.body,
          }),
        }),
      });
    }
    default:
      return invalid();
  }
}

function resolve(
  parent: RuntimeObject,
  name: string,
  args: Record<string, unknown>,
  store: Store,
): unknown {
  const login = store.ownerLogin ?? 'octocat';
  if (parent.type === 'Mutation') return mutate(name, args, store);
  if (parent.type === 'Query') {
    switch (name) {
      case 'viewer':
        return object('User', { login });
      case 'repository': {
        const repo = store.getRepo(string(args.owner), string(args.name));
        return repo ? object('Repository', repo, repo) : null;
      }
      case '__type':
        return introspect(string(args.name));
      case 'node': {
        const id = string(args.id);
        const decoded = store.fromGqlId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          for (const repo of store.repos.values()) {
            if (repo.databaseId === decoded.databaseId) {
              return object('Repository', repo, repo, id);
            }
          }
          return null;
        }
        return object('Node', { id });
      }
    }
  }
  if (parent.type === 'Repository') {
    const repo = parent.value as Repo;
    switch (name) {
      case 'id':
        return parent.idOverride ?? store.toGqlId('Repository', repo.databaseId);
      case 'databaseId':
        return repo.databaseId;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner ?? login}/${repo.name}`;
      case 'owner':
        return object('User', { login: repo.owner ?? login });
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'defaultBranchRef': {
        const sha = repo.branches.get(repo.defaultBranch);
        return sha ? object('Ref', {
          name: repo.defaultBranch,
          target: object('Commit', { oid: sha }),
        }) : null;
      }
      case 'issue': {
        const issue = repo.issues.get(integer(args.number));
        return issue ? object('Issue', issue, repo) : null;
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(integer(args.number));
        return pull ? object('PullRequest', pull, repo) : null;
      }
      case 'issues': {
        let issues = [...repo.issues.values()];
        if (args.states != null) {
          const states = Array.isArray(args.states) ? args.states : [args.states];
          if (states.some(state => state !== 'OPEN' && state !== 'CLOSED')) invalid();
          issues = issues.filter(issue => states.includes(issue.state.toUpperCase()));
        }
        const order = args.orderBy == null ? {} : record(args.orderBy);
        const field = order.field ?? 'CREATED_AT';
        const direction = order.direction ?? 'DESC';
        if (!['CREATED_AT', 'UPDATED_AT', 'COMMENTS'].includes(string(field))) invalid();
        if (direction !== 'ASC' && direction !== 'DESC') invalid();
        issues.sort((a, b) => {
          let comparison: number;
          if (field === 'COMMENTS') {
            comparison = a.comments.length - b.comments.length;
          } else {
            const left = field === 'UPDATED_AT' ? a.updatedAt : a.createdAt;
            const right = field === 'UPDATED_AT' ? b.updatedAt : b.createdAt;
            comparison = left < right ? -1 : left > right ? 1 : 0;
          }
          comparison ||= a.number - b.number;
          return direction === 'ASC' ? comparison : -comparison;
        });
        const start = startIndex(args.after);
        const size = pageSize(args.first);
        const nodes = issues.slice(start, start + size)
          .map(issue => object('Issue', issue, repo));
        return connection('IssueConnection', 'IssueEdge', nodes, start, issues.length);
      }
      case 'pullRequests': {
        const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
        const nodes = pulls.slice(0, pageSize(args.first))
          .map(pull => object('PullRequest', pull, repo));
        return connection(
          'PullRequestConnection', 'PullRequestEdge', nodes, 0, pulls.length,
        );
      }
    }
  }
  if (parent.type === 'Issue') {
    const issue = parent.value as Issue;
    switch (name) {
      case 'id':
        return store.toGqlId('Issue', issue.databaseId);
      case 'state':
        return issue.state.toUpperCase();
      case 'author':
        return object('User', { login: issue.authorLogin });
      case 'comments': {
        const start = startIndex(args.after);
        const nodes = issue.comments.slice(start, start + pageSize(args.first))
          .map(comment => object('IssueComment', {
            id: store.toGqlId('Comment', comment.id),
            body: comment.body,
          }));
        return connection(
          'IssueCommentConnection', 'IssueCommentEdge',
          nodes, start, issue.comments.length,
        );
      }
      default:
        return (issue as unknown as Record<string, unknown>)[name] ?? null;
    }
  }
  if (parent.type === 'PullRequest') {
    const pull = parent.value as Pull;
    switch (name) {
      case 'id':
        return store.toGqlId('PullRequest', pull.databaseId);
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
      case 'state':
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'files': {
        if (!parent.repo) invalid();
        const files = changedFiles(store, parent.repo, pull);
        return connection(
          'PullRequestChangedFileConnection',
          'PullRequestChangedFileEdge',
          files.slice(0, pageSize(args.first)),
          0,
          files.length,
        );
      }
      default:
        return (pull as unknown as Record<string, unknown>)[name] ?? null;
    }
  }
  return record(parent.value)[name] ?? null;
}

function mergeResult(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const previous = target[key];
  if (
    Object.hasOwn(target, key)
    && previous !== null && value !== null
    && typeof previous === 'object' && typeof value === 'object'
    && !Array.isArray(previous) && !Array.isArray(value)
  ) {
    for (const [childKey, childValue] of Object.entries(value)) {
      mergeResult(previous as Record<string, unknown>, childKey, childValue);
    }
  } else {
    target[key] = value;
  }
}

function execute(
  parent: RuntimeObject,
  selections: Selection[],
  variables: Record<string, unknown>,
  store: Store,
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.type === parent.type || selection.type === 'Node') {
        const fragment = execute(parent, selection.selections, variables, store);
        for (const [key, value] of Object.entries(fragment)) {
          mergeResult(result, key, value);
        }
      }
      continue;
    }
    const args: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(selection.args)) {
      args[key] = evaluate(value, variables);
    }
    const raw = resolve(parent, selection.name, args, store);
    let value: unknown;
    if (raw == null) {
      value = null;
    } else if (!selection.selections.length) {
      value = raw;
    } else if (Array.isArray(raw)) {
      value = raw.map(item => item == null ? null : execute(
        item as RuntimeObject, selection.selections, variables, store,
      ));
    } else {
      value = execute(
        raw as RuntimeObject, selection.selections, variables, store,
      );
    }
    mergeResult(result, selection.alias, value);
  }
  return result;
}

function errorEnvelope(message: string): Envelope {
  return { data: null, errors: [{ message }] };
}

// Both dispatch paths use this same validation and per-field executor.
// The root schema identifies each selection structurally, allowing aliases,
// repeated root fields, and mixtures of the supported query fields.
function executeOperation(
  operation: Operation,
  request: Record<string, unknown>,
  store: Store,
): Envelope {
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';

  // Validate the entire selection tree before resolving nullable fields or
  // performing mutations. Unknown root fields therefore get the same precise
  // naming error as unknown nested fields.
  validateSelections(rootType, operation.selections);

  const supplied = request.variables == null ? {} : record(request.variables);
  const variables: Record<string, unknown> = Object.create(null);
  const defined = new Set<string>();
  for (const definition of operation.variables) {
    if (defined.has(definition.name)) invalid();
    defined.add(definition.name);
    let value = supplied[definition.name];
    if (!Object.hasOwn(supplied, definition.name)) {
      value = definition.defaultValue
        ? evaluate(definition.defaultValue, {})
        : undefined;
    }
    validateVariable(value, definition.type);
    variables[definition.name] = value;
  }

  return {
    data: execute(
      object(rootType, {}), operation.selections, variables, store,
    ),
  };
}

function runOperation(document: unknown, store: Store): Envelope {
  try {
    const request = record(document);
    const operations = new Parser(string(request.query)).document();
    let operation: Operation;
    if (request.operationName != null) {
      const name = string(request.operationName);
      const matches = operations.filter(item => item.name === name);
      if (matches.length !== 1) return invalid();
      operation = matches[0];
    } else {
      if (operations.length !== 1) return invalid();
      operation = operations[0];
    }

    // Preserve the fast path for all eighteen recognized operation names.
    if (operation.name !== null) {
      const names = operation.kind === 'mutation' ? mutationNames : queryNames;
      if (names.has(operation.name)) {
        return executeOperation(operation, request, store);
      }
    }

    // Structural fallback for arbitrary names and anonymous operations.
    // executeOperation validates selections against Query or Mutation, then
    // execute dispatches each actual root field through the existing resolver.
    // The operation name does not restrict which supported fields may run.
    return executeOperation(operation, request, store);
  } catch (error) {
    // Only expose our field-validation message; other failures stay generic.
    const message = error instanceof Error
      && /^Cannot query field "[^"]*" on type "[^"]*"\.$/.test(error.message)
      ? error.message
      : 'Invalid GraphQL request.';
    return errorEnvelope(message);
  }
}

export function handleGraphql(req: RestRequest, store: Store): RestResponse {
  let body: unknown;
  try {
    if (req.method !== 'POST') {
      body = errorEnvelope('Invalid GraphQL request.');
    } else if (Array.isArray(req.json)) {
      body = req.json.map(document => runOperation(document, store));
    } else {
      body = runOperation(req.json, store);
    }
  } catch {
    body = errorEnvelope('Invalid GraphQL request.');
  }
  return {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Request-Id': store.nextRequestId(),
    },
    body,
  };
}
