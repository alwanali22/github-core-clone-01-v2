import { sha1Hex, decodeObject, hashObject } from './gitobj.ts';
import { parsePack, buildPack } from './gitpack.ts';

export interface GitRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const ZERO_OID = '0000000000000000000000000000000000000000';

function pktLine(data: string | Buffer): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const len = buf.length + 4;
  if (len > 65520) throw new Error('Packet too large');
  const hex = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(hex, 'ascii'), buf]);
}

const FLUSH_PKT = Buffer.from('0000', 'ascii');
const DELIM_PKT = Buffer.from('0001', 'ascii');
const RESPONSE_END_PKT = Buffer.from('0002', 'ascii');

function parsePktLines(buf: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) break;
    const hex = buf.toString('ascii', offset, offset + 4);
    if (hex === '0000') {
      lines.push(Buffer.alloc(0));
      offset += 4;
      continue;
    }
    if (hex === '0001') {
      lines.push(Buffer.from('0001', 'ascii'));
      offset += 4;
      continue;
    }
    if (hex === '0002') {
      lines.push(Buffer.from('0002', 'ascii'));
      offset += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (isNaN(len) || len < 4) {
      break;
    }
    if (offset + len > buf.length) {
      break;
    }
    const payload = buf.subarray(offset + 4, offset + len);
    lines.push(payload);
    offset += len;
  }
  return lines;
}

function makeSidebandPackets(data: Buffer, band: number = 1): Buffer {
  const chunks: Buffer[] = [];
  const maxChunk = 65515;
  let offset = 0;
  while (offset < data.length) {
    const end = Math.min(offset + maxChunk, data.length);
    const chunk = data.subarray(offset, end);
    const bandBuf = Buffer.from([band]);
    const packetData = Buffer.concat([bandBuf, chunk]);
    chunks.push(pktLine(packetData));
    offset = end;
  }
  return Buffer.concat(chunks);
}

function collectPackObjects(
  repo: { objects: Map<string, { type: any; content: Buffer }> },
  wants: string[],
  haves: string[],
  depth: number | null,
  shallowBoundaries: string[],
): {
  objects: Map<string, { sha: string; type: any; content: Buffer }>;
  shallow: string[];
  unshallow: string[];
} {
  const haveClosure = new Set<string>();
  const haveVisited = new Set<string>();
  const haveQueue = [...haves];

  while (haveQueue.length > 0) {
    const oid = haveQueue.shift()!;
    if (haveVisited.has(oid)) continue;
    haveVisited.add(oid);

    const obj = repo.objects.get(oid);
    if (!obj) continue;
    haveClosure.add(oid);

    if (obj.type === 'commit') {
      const text = obj.content.toString('utf-8');
      for (const line of text.split(/\r?\n/)) {
        if (line === '') break;
        if (line.startsWith('parent ')) {
          if (!shallowBoundaries.includes(oid)) {
            haveQueue.push(line.substring(7).trim());
          }
        } else if (line.startsWith('tree ')) {
          haveQueue.push(line.substring(5).trim());
        }
      }
    } else if (obj.type === 'tree') {
      const buf = obj.content;
      let offset = 0;
      while (offset < buf.length) {
        const spaceIdx = buf.indexOf(32, offset);
        if (spaceIdx === -1) break;
        const nullIdx = buf.indexOf(0, spaceIdx);
        if (nullIdx === -1) break;
        const shaBuf = buf.subarray(nullIdx + 1, nullIdx + 21);
        if (shaBuf.length < 20) break;
        haveQueue.push(shaBuf.toString('hex'));
        offset = nullIdx + 21;
      }
    } else if (obj.type === 'tag') {
      const text = obj.content.toString('utf-8');
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('object ')) {
          haveQueue.push(line.substring(7).trim());
        }
      }
    }
  }

  const objects = new Map<string, { sha: string; type: any; content: Buffer }>();
  const visited = new Set<string>();
  const includedCommits = new Set<string>();
  const commitParents = new Map<string, string[]>();
  const queue: { oid: string; commitDepth: number | null }[] = wants.map(
    (oid) => ({
      oid,
      commitDepth: repo.objects.get(oid)?.type === 'commit' ? 0 : null,
    }),
  );

  while (queue.length > 0) {
    const { oid, commitDepth } = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);

    const obj = repo.objects.get(oid);
    if (!obj) continue;

    if (obj.type === 'commit') {
      const currentDepth = commitDepth ?? 0;
      if (depth !== null && currentDepth >= depth) continue;
      includedCommits.add(oid);

      if (!haveClosure.has(oid)) {
        objects.set(oid, { sha: oid, type: obj.type, content: obj.content });
      }

      const parents: string[] = [];
      commitParents.set(oid, parents);
      const text = obj.content.toString('utf-8');
      for (const line of text.split(/\r?\n/)) {
        if (line === '') break;
        if (line.startsWith('parent ')) {
          const parent = line.substring(7).trim();
          parents.push(parent);
          queue.push({ oid: parent, commitDepth: currentDepth + 1 });
        } else if (line.startsWith('tree ')) {
          if (!haveClosure.has(oid)) {
            queue.push({ oid: line.substring(5).trim(), commitDepth: null });
          }
        }
      }
    } else {
      if (!haveClosure.has(oid)) {
        objects.set(oid, { sha: oid, type: obj.type, content: obj.content });
      }

      if (obj.type === 'tree') {
        const buf = obj.content;
        let offset = 0;
        while (offset < buf.length) {
          const spaceIdx = buf.indexOf(32, offset);
          if (spaceIdx === -1) break;
          const nullIdx = buf.indexOf(0, spaceIdx);
          if (nullIdx === -1) break;
          const shaBuf = buf.subarray(nullIdx + 1, nullIdx + 21);
          if (shaBuf.length < 20) break;
          const target = shaBuf.toString('hex');
          queue.push({
            oid: target,
            commitDepth: repo.objects.get(target)?.type === 'commit' ? 0 : null,
          });
          offset = nullIdx + 21;
        }
      } else if (obj.type === 'tag') {
        const text = obj.content.toString('utf-8');
        for (const line of text.split(/\r?\n/)) {
          if (line.startsWith('object ')) {
            const target = line.substring(7).trim();
            queue.push({
              oid: target,
              commitDepth: repo.objects.get(target)?.type === 'commit' ? 0 : null,
            });
          }
        }
      }
    }
  }

  const shallow: string[] = [];
  if (depth !== null) {
    for (const oid of includedCommits) {
      const parents = commitParents.get(oid) ?? [];
      if (
        parents.some(
          (parent) =>
            repo.objects.get(parent)?.type === 'commit' &&
            !includedCommits.has(parent),
        )
      ) {
        shallow.push(oid);
      }
    }
  }

  const unshallow = shallowBoundaries.filter(
    (oid) =>
      visited.has(oid) &&
      (commitParents.get(oid) ?? []).some((parent) => includedCommits.has(parent)),
  );

  return { objects, shallow, unshallow };
}

function isAncestor(repo: any, extraObjects: Map<string, { type: string; content: Buffer }>, ancestorOid: string, tipOid: string): boolean {
  if (ancestorOid === tipOid) return true;
  const visited = new Set<string>();
  const queue = [tipOid];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === ancestorOid) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const obj = extraObjects.get(current) || repo.objects.get(current);
    if (obj && obj.type === 'commit') {
      const text = obj.content.toString('utf-8');
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (line === '') break;
        if (line.startsWith('parent ')) {
          const parentOid = line.substring(7).trim();
          if (parentOid === ancestorOid) return true;
          if (!visited.has(parentOid)) {
            queue.push(parentOid);
          }
        }
      }
    }
  }
  return false;
}

function handleGitCore(req: any, store: any, maybeRes?: any, maybeCtx?: any): GitResponse {
  let method = req.method;
  let path = req.path || req.url || '';
  let query = req.query instanceof URLSearchParams ? req.query : new URLSearchParams(req.url?.includes('?') ? req.url.split('?')[1] : '');
  let headers = req.headers || {};
  let body = req.body;
  if (!Buffer.isBuffer(body)) {
    if (typeof body === 'string') {
      body = Buffer.from(body);
    } else {
      body = Buffer.alloc(0);
    }
  }

  const pathOnly = path.split('?')[0];
  const parts = pathOnly.split('/').filter(Boolean);
  if (parts.length < 2) {
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Not found\n') };
  }

  const owner = parts[0];
  const repoRaw = parts[1];
  if (!repoRaw.endsWith('.git')) {
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Not found\n') };
  }
  const repoName = repoRaw.substring(0, repoRaw.length - 4);

  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Repository not found\n') };
  }

  const action = parts.slice(2).join('/');

  if (method === 'GET' && action === 'info/refs') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return {
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ message: 'Unknown service' }))
      };
    }

    if (service === 'git-upload-pack') {
      const gitProto = headers['git-protocol'] || headers['Git-Protocol'];
      if (gitProto && gitProto.includes('version=2')) {
        const lines: Buffer[] = [
          pktLine('version 2\n'),
          pktLine('agent=makefun-git-client/1.0\n'),
          pktLine('ls-refs\n'),
          pktLine('fetch=shallow deepen not-in filter\n'),
          pktLine('object-format=sha1\n'),
          FLUSH_PKT
        ];
        return {
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
          body: Buffer.concat(lines)
        };
      } else {
        const lines: Buffer[] = [
          pktLine('# service=git-upload-pack\n'),
          FLUSH_PKT
        ];
        const refs: [string, string][] = [];
        const mainSha = repo.branches.get('main') || repo.refs.get('refs/heads/main');
        if (mainSha) {
          refs.push(['refs/heads/main', mainSha]);
        }
        for (const [refName, sha] of repo.refs.entries()) {
          if (refName !== 'refs/heads/main') {
            refs.push([refName, sha]);
          }
        }
        for (const [branchName, sha] of repo.branches.entries()) {
          const refName = `refs/heads/${branchName}`;
          if (!repo.refs.has(refName)) {
            refs.push([refName, sha]);
          }
        }
        refs.sort((a, b) => a[0].localeCompare(b[0]));

        const isEmpty = refs.length === 0;
        if (isEmpty) {
          const caps = 'capabilities^{}\0multi_ack multi_ack_detailed side-band side-band-64k thin-pack no-progress include-tag ofs-delta shallow deepen symref=HEAD:refs/heads/main object-format=sha1';
          lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
        } else {
          const caps = 'multi_ack multi_ack_detailed side-band side-band-64k thin-pack no-progress include-tag ofs-delta shallow deepen symref=HEAD:refs/heads/main object-format=sha1';
          const headSha = mainSha || refs[0][1];
          lines.push(pktLine(`${headSha} HEAD\0${caps}\n`));
          for (let i = 0; i < refs.length; i++) {
            const [refName, sha] = refs[i];
            lines.push(pktLine(`${sha} ${refName}\n`));
          }
        }
        lines.push(FLUSH_PKT);
        return {
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
          body: Buffer.concat(lines)
        };
      }
    } else {
      const lines: Buffer[] = [
        pktLine('# service=git-receive-pack\n'),
        FLUSH_PKT
      ];
      const refs: [string, string][] = [];
      for (const [refName, sha] of repo.refs.entries()) {
        refs.push([refName, sha]);
      }
      for (const [branchName, sha] of repo.branches.entries()) {
        const refName = `refs/heads/${branchName}`;
        if (!repo.refs.has(refName)) {
          refs.push([refName, sha]);
        }
      }
      refs.sort((a, b) => a[0].localeCompare(b[0]));

      const caps = 'report-status report-status-v2 side-band-64k ofs-delta delete-refs object-format=sha1';
      if (refs.length === 0) {
        lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
      } else {
        for (let i = 0; i < refs.length; i++) {
          const [refName, sha] = refs[i];
          if (i === 0) {
            lines.push(pktLine(`${sha} ${refName}\0${caps}\n`));
          } else {
            lines.push(pktLine(`${sha} ${refName}\n`));
          }
        }
      }
      lines.push(FLUSH_PKT);
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-receive-pack-advertisement' },
        body: Buffer.concat(lines)
      };
    }
  }

  if (method === 'POST' && action === 'git-upload-pack') {
    const gitProto = headers['git-protocol'] || headers['Git-Protocol'];
    const isV2 = gitProto && gitProto.includes('version=2');

    if (isV2) {
      const pktLines = parsePktLines(body);
      let command = '';
      const args: string[] = [];
      for (const line of pktLines) {
        if (line.length === 0) continue;
        const text = line.toString('utf-8').trim();
        if (text.startsWith('command=')) {
          command = text.substring(8);
        } else {
          args.push(text);
        }
      }

      if (command === 'ls-refs') {
        let symrefs = false;
        let peel = false;
        const prefixes: string[] = [];
        for (const arg of args) {
          if (arg === 'symrefs') symrefs = true;
          if (arg === 'peel') peel = true;
          if (arg.startsWith('ref-prefix ')) {
            prefixes.push(arg.substring(11).trim());
          }
        }

        const outLines: Buffer[] = [];
        const refs: [string, string][] = [];
        const mainSha = repo.branches.get('main') || repo.refs.get('refs/heads/main');
        if (mainSha) {
          refs.push(['HEAD', mainSha]);
          refs.push(['refs/heads/main', mainSha]);
        }
        for (const [k, v] of repo.refs.entries()) {
          if (k !== 'refs/heads/main') refs.push([k, v]);
        }
        for (const [k, v] of repo.branches.entries()) {
          const r = `refs/heads/${k}`;
          if (!repo.refs.has(r)) refs.push([r, v]);
        }
        refs.sort((a, b) => a[0].localeCompare(b[0]));

        for (const [refName, sha] of refs) {
          if (prefixes.length > 0) {
            let matched = false;
            for (const p of prefixes) {
              if (refName.startsWith(p)) {
                matched = true;
                break;
              }
            }
            if (!matched) continue;
          }
          let line = `${sha} ${refName}`;
          if (refName === 'HEAD' && symrefs && mainSha) {
            line += ` symref-target:refs/heads/main`;
          }

          if (peel) {
            const obj = repo.objects.get(sha);
            if (obj && obj.type === 'tag') {
              let curSha = sha;
              let curObj = obj;
              while (curObj && curObj.type === 'tag') {
                const text = curObj.content.toString('utf-8');
                let targetSha = '';
                for (const l of text.split(/\r?\n/)) {
                  if (l.startsWith('object ')) {
                    targetSha = l.substring(7).trim();
                    break;
                  }
                }
                if (!targetSha) break;
                curSha = targetSha;
                curObj = repo.objects.get(curSha);
              }
              if (curSha !== sha) {
                line += ` peeled:${curSha}`;
              }
            }
          }

          line += `\n`;
          outLines.push(pktLine(line));
        }
        outLines.push(FLUSH_PKT);
        return {
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-result' },
          body: Buffer.concat(outLines)
        };
      } else if (command === 'fetch') {
        const wants: string[] = [];
        const haves: string[] = [];
        const shallowBoundaries: string[] = [];
        let depth: number | null = null;
        for (const arg of args) {
          if (arg.startsWith('want ')) {
            wants.push(arg.substring(5).trim());
          } else if (arg.startsWith('have ')) {
            haves.push(arg.substring(5).trim());
          } else if (arg.startsWith('shallow ')) {
            shallowBoundaries.push(arg.substring(8).trim());
          } else if (arg.startsWith('deepen ')) {
            const requestedDepth = Number(arg.substring(7).trim());
            if (Number.isInteger(requestedDepth) && requestedDepth > 0) {
              depth = requestedDepth;
            }
          }
        }

        const collected = collectPackObjects(
          repo,
          wants,
          haves,
          depth,
          shallowBoundaries,
        );
        const packObjects = Array.from(collected.objects.values());
        const packBuf = buildPack(packObjects);
        const sidebandPack = makeSidebandPackets(packBuf, 1);

        const acknowledgmentLines: Buffer[] = [];
        if (haves.length > 0) {
          const knownHaves = haves.filter((have) => repo.objects.has(have));
          acknowledgmentLines.push(pktLine('acknowledgments\n'));
          if (knownHaves.length > 0) {
            for (const have of knownHaves) {
              acknowledgmentLines.push(pktLine(`ACK ${have}\n`));
            }
          } else {
            acknowledgmentLines.push(pktLine('NAK\n'));
          }
          acknowledgmentLines.push(pktLine('ready\n'));
          acknowledgmentLines.push(DELIM_PKT);
        }

        const responseLines: Buffer[] = [
          ...acknowledgmentLines,
          pktLine('shallow-info\n'),
          ...collected.shallow.map((oid) => pktLine('shallow ' + oid + '\n')),
          ...collected.unshallow.map((oid) => pktLine('unshallow ' + oid + '\n')),
          FLUSH_PKT,
          pktLine('packfile\n'),
          sidebandPack,
          FLUSH_PKT
        ];

        return {
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-result' },
          body: Buffer.concat(responseLines)
        };
      }
    } else {
      const lines = parsePktLines(body);
      const wants: string[] = [];
      const haves: string[] = [];
      const shallowBoundaries: string[] = [];
      let depth: number | null = null;
      for (const line of lines) {
        const text = line.toString('utf-8').trim();
        if (text.startsWith('want ')) {
          wants.push(text.substring(5).split(' ')[0]);
        } else if (text.startsWith('have ')) {
          haves.push(text.substring(5).trim());
        } else if (text.startsWith('shallow ')) {
          shallowBoundaries.push(text.substring(8).trim());
        } else if (text.startsWith('deepen ')) {
          const requestedDepth = Number(text.substring(7).trim());
          depth = Number.isInteger(requestedDepth) && requestedDepth > 0
            ? requestedDepth
            : null;
        }
      }

      const collected = collectPackObjects(
        repo,
        wants,
        haves,
        depth,
        shallowBoundaries,
      );
      const packObjects = Array.from(collected.objects.values());
      const packBuf = buildPack(packObjects);
      const sidebandPack = makeSidebandPackets(packBuf, 1);

      const respLines: Buffer[] = [
        pktLine('ACK ' + (wants[0] || ZERO_OID) + '\n'),
        ...collected.shallow.map((oid) => pktLine('shallow ' + oid + '\n')),
        ...collected.unshallow.map((oid) => pktLine('unshallow ' + oid + '\n')),
        sidebandPack,
        FLUSH_PKT
      ];
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body: Buffer.concat(respLines)
      };
    }
  }

  if (method === 'POST' && action === 'git-receive-pack') {
    let offset = 0;
    const commands: { oldOid: string; newOid: string; ref: string }[] = [];
    let capabilities = '';

    while (offset < body.length) {
      if (offset + 4 > body.length) break;
      const hex = body.toString('ascii', offset, offset + 4);
      if (hex === '0000') {
        offset += 4;
        break;
      }
      const len = parseInt(hex, 16);
      if (isNaN(len) || len < 4) {
        break;
      }
      if (offset + len > body.length) {
        break;
      }
      const payload = body.subarray(offset + 4, offset + len);
      offset += len;

      const text = payload.toString('utf-8');
      const parts = text.split('\0');
      const mainPart = parts[0];
      if (parts.length > 1) {
        capabilities = parts[1];
      }
      const cmdParts = mainPart.trim().split(/\s+/);
      if (cmdParts.length === 3) {
        commands.push({
          oldOid: cmdParts[0],
          newOid: cmdParts[1],
          ref: cmdParts[2]
        });
      }
    }

    const packPart = body.subarray(offset);

    const incomingObjects = new Map<string, { type: any; content: Buffer }>();
    if (packPart.length >= 32) {
      try {
        const parsedObjs = parsePack(packPart, (sha) => repo.objects.get(sha) || incomingObjects.get(sha));
        for (const obj of parsedObjs) {
          incomingObjects.set(obj.sha, { type: obj.type, content: obj.content });
        }
      } catch (err) {
        // ignore
      }
    }

    for (const [sha, obj] of incomingObjects.entries()) {
      repo.objects.set(sha, obj);
    }

    const sidebandLines: Buffer[] = [
      pktLine(Buffer.concat([Buffer.from([0x01]), pktLine('unpack ok\n')]))
    ];

    for (const cmd of commands) {
      const { oldOid, newOid, ref } = cmd;
      let lineText = '';
      if (newOid === ZERO_OID) {
        repo.refs.delete(ref);
        if (ref.startsWith('refs/heads/')) {
          repo.branches.delete(ref.substring(11));
        }
        lineText = `ok ${ref}\n`;
      } else if (oldOid === ZERO_OID) {
        repo.refs.set(ref, newOid);
        if (ref.startsWith('refs/heads/')) {
          repo.branches.set(ref.substring(11), newOid);
        }
        lineText = `ok ${ref}\n`;
      } else {
        const currentSha = repo.refs.get(ref) || (ref.startsWith('refs/heads/') ? repo.branches.get(ref.substring(11)) : undefined);
        if (!currentSha || currentSha === oldOid) {
          if (isAncestor(repo, incomingObjects, oldOid, newOid)) {
            repo.refs.set(ref, newOid);
            if (ref.startsWith('refs/heads/')) {
              repo.branches.set(ref.substring(11), newOid);
            }
            lineText = `ok ${ref}\n`;
          } else {
            lineText = `ng ${ref} non-fast-forward\n`;
          }
        } else {
          if (isAncestor(repo, incomingObjects, oldOid, newOid)) {
            repo.refs.set(ref, newOid);
            if (ref.startsWith('refs/heads/')) {
              repo.branches.set(ref.substring(11), newOid);
            }
            lineText = `ok ${ref}\n`;
          } else {
            lineText = `ng ${ref} non-fast-forward\n`;
          }
        }
      }
      sidebandLines.push(pktLine(Buffer.concat([Buffer.from([0x01]), pktLine(lineText)])));
    }
    sidebandLines.push(pktLine(Buffer.concat([Buffer.from([0x01]), FLUSH_PKT])));
    sidebandLines.push(FLUSH_PKT);

    const responseBody = Buffer.concat(sidebandLines);

    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-receive-pack-result' },
      body: responseBody
    };
  }

  return {
    status: 404,
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('Not found\n')
  };
}

export function handleGit(req: any, store: any, maybeRes?: any, maybeCtx?: any): GitResponse {
  const result = handleGitCore(req, store, maybeRes, maybeCtx);
  if (result && result.body && result.headers) {
    if (!result.headers['content-length'] && !result.headers['Content-Length']) {
      result.headers['content-length'] = String(result.body.length);
    }
    // No `connection: close` here: every git response is length-delimited
    // (Content-Length is set above), so the client's keep-alive pool reuses
    // one socket across the advertisement + pack exchange instead of paying
    // a TCP setup/teardown per request. Node still honors an explicit
    // client-sent `Connection: close` on its own.
    if (!result.headers['cache-control'] && !result.headers['Cache-Control']) {
      result.headers['cache-control'] = 'no-cache';
    }
  }
  return result;
}

export function handle(req: any, res: any, store: any, ctx: any): any {
  const result = handleGit(req, store);
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  }
  return result;
}
