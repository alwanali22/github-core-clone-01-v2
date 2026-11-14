import crypto from 'node:crypto';
import zlib from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const deflateCache = new Map<string, Buffer>();

export function sha1Hex(data: Buffer): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

export function encodeObject(type: ObjectType, content: Buffer): Buffer {
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new RangeError(`Unknown object type: ${type}`);
  }
  if (!Buffer.isBuffer(content)) {
    throw new TypeError('Content must be a Buffer');
  }
  const header = `${type} ${content.length}\0`;
  return Buffer.concat([Buffer.from(header, 'utf8'), content]);
}

export function decodeObject(raw: Buffer): { type: ObjectType; content: Buffer } {
  const nullIndex = raw.indexOf(0);
  if (nullIndex === -1) {
    throw new Error('Malformed object: missing null byte in header');
  }
  const headerStr = raw.toString('utf8', 0, nullIndex);
  const spaceIndex = headerStr.indexOf(' ');
  if (spaceIndex === -1) {
    throw new Error('Malformed object: missing space in header');
  }
  const typeStr = headerStr.slice(0, spaceIndex);
  if (typeStr !== 'commit' && typeStr !== 'tree' && typeStr !== 'blob' && typeStr !== 'tag') {
    throw new Error(`Malformed object: invalid type '${typeStr}'`);
  }
  const type = typeStr as ObjectType;
  const sizeStr = headerStr.slice(spaceIndex + 1);
  if (!/^\d+$/.test(sizeStr)) {
    throw new Error(`Malformed object: invalid size '${sizeStr}'`);
  }
  const size = Number(sizeStr);
  const content = raw.subarray(nullIndex + 1);
  if (content.length !== size) {
    throw new Error(`Malformed object: size mismatch (header says ${size}, actual is ${content.length})`);
  }
  return { type, content };
}

export function deflatedFor(sha: string, type: ObjectType, content: Buffer): Buffer {
  let cached = deflateCache.get(sha);
  if (cached) {
    return cached;
  }
  const raw = encodeObject(type, content);
  const stored = zlib.deflateSync(raw, { level: 6 });
  deflateCache.set(sha, stored);
  return stored;
}

export function clearDeflateCache(): void {
  deflateCache.clear();
}

export function hashObject(type: ObjectType, content: Buffer): { sha: string; stored: Buffer } {
  const raw = encodeObject(type, content);
  const sha = sha1Hex(raw);
  const stored = deflatedFor(sha, type, content);
  return { sha, stored };
}

export function inflateObject(stored: Buffer): { type: ObjectType; content: Buffer } {
  const raw = zlib.inflateSync(stored);
  return decodeObject(raw);
}
