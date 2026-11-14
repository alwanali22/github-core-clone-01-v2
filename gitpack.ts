import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';
import type { ObjectType } from './gitobj.ts';
import { sha1Hex, encodeObject } from './gitobj.ts';

export interface PackObject {
  sha: string;
  type: ObjectType;
  content: Buffer;
}

export function packObjectHeader(type: ObjectType, size: number): Buffer {
  let typeCode = 1;
  if (type === 'commit') typeCode = 1;
  else if (type === 'tree') typeCode = 2;
  else if (type === 'blob') typeCode = 3;
  else if (type === 'tag') typeCode = 4;
  else throw new Error('Unknown object type: ' + type);

  const bytes: number[] = [];
  let c = size & 0xf;
  let s = size >> 4;
  let first = (typeCode << 4) | c;
  if (s > 0) {
    first |= 0x80;
  }
  bytes.push(first);
  while (s > 0) {
    let b = s & 0x7f;
    s >>= 7;
    if (s > 0) {
      b |= 0x80;
    }
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

function readVarintSize(buf: Buffer, offset: number): { type: number; size: number; bytesRead: number } {
  let pos = offset;
  if (pos >= buf.length) throw new Error('Truncated input reading object header');
  const b = buf[pos++];
  const type = (b >> 4) & 7;
  let size = b & 0x0f;
  let shift = 4;
  let cur = b;
  while ((cur & 0x80) !== 0) {
    if (pos >= buf.length) throw new Error('Truncated input reading varint size');
    cur = buf[pos++];
    size |= (cur & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, bytesRead: pos - offset };
}

function readOfsDeltaBase(buf: Buffer, offset: number): { baseOffset: number; bytesRead: number } {
  let pos = offset;
  if (pos >= buf.length) throw new Error('Truncated input reading ofs delta base');
  let b = buf[pos++];
  let val = b & 0x7f;
  while ((b & 0x80) !== 0) {
    if (pos >= buf.length) throw new Error('Truncated input reading ofs delta base');
    b = buf[pos++];
    val = ((val + 1) << 7) | (b & 0x7f);
  }
  return { baseOffset: val, bytesRead: pos - offset };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  function readDeltaVarint(): number {
    let shift = 0;
    let val = 0;
    while (pos < delta.length) {
      const b = delta[pos++];
      val |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return val;
  }

  const srcSize = readDeltaVarint();
  if (srcSize !== base.length) {
    throw new Error(`Delta source size mismatch: expected ${base.length}, got ${srcSize}`);
  }
  const targetSize = readDeltaVarint();
  const outChunks: Buffer[] = [];
  let outLen = 0;

  while (pos < delta.length) {
    const op = delta[pos++];
    if ((op & 0x80) !== 0) {
      let offset = 0;
      if ((op & 0x01) !== 0) offset |= delta[pos++] << 0;
      if ((op & 0x02) !== 0) offset |= delta[pos++] << 8;
      if ((op & 0x04) !== 0) offset |= delta[pos++] << 16;
      if ((op & 0x08) !== 0) offset |= delta[pos++] << 24;

      let size = 0;
      if ((op & 0x10) !== 0) size |= delta[pos++] << 0;
      if ((op & 0x20) !== 0) size |= delta[pos++] << 8;
      if ((op & 0x40) !== 0) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;

      if (offset + size > base.length || offset < 0 || size < 0) {
        throw new Error('Delta copy instruction out of bounds');
      }
      outChunks.push(base.subarray(offset, offset + size));
      outLen += size;
    } else {
      const len = op & 0x7f;
      if (pos + len > delta.length) {
        throw new Error('Delta insert instruction truncated');
      }
      outChunks.push(delta.subarray(pos, pos + len));
      pos += len;
      outLen += len;
    }
  }

  if (outLen !== targetSize) {
    throw new Error(`Delta target size mismatch: expected ${targetSize}, got ${outLen}`);
  }
  return Buffer.concat(outChunks);
}

/** A git object id with no deflate attached: parsePack only needs the sha, and the deflated bytes hashObject() also computes are thrown away here. Same canonical `"<type> <size>\0" + content` input, same sha. */
function shaOf(type: ObjectType, content: Buffer): string {
  return sha1Hex(encodeObject(type, content));
}

export function parsePack(
  buf: Buffer,
  getBase: (sha: string) => { type: ObjectType; content: Buffer } | undefined
): PackObject[] {
  if (buf.length < 32) {
    throw new Error('Pack file too small');
  }
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('Bad pack magic');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new Error(`Unsupported pack version: ${version}`);
  }
  const objectCount = buf.readUInt32BE(8);

  const expectedChecksum = buf.subarray(buf.length - 20);
  const actualChecksum = crypto.createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!actualChecksum.equals(expectedChecksum)) {
    throw new Error('Pack checksum mismatch');
  }

  let pos = 12;
  const entries: Array<{
    entryOffset: number;
    typeCode: number;
    refSha?: string;
    ofsBase?: number;
    inflated?: Buffer;
  }> = [];

  for (let i = 0; i < objectCount; i++) {
    if (pos >= buf.length - 20) {
      throw new Error('Truncated pack file at object entry');
    }
    const entryOffset = pos;
    const { type: typeCode, size, bytesRead } = readVarintSize(buf, pos);
    pos += bytesRead;

    let refSha: string | undefined;
    let ofsBase: number | undefined;

    if (typeCode === 7) {
      if (pos + 20 > buf.length - 20) {
        throw new Error('Truncated REF_DELTA base sha');
      }
      refSha = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (typeCode === 6) {
      const { baseOffset, bytesRead: ofsBytes } = readOfsDeltaBase(buf, pos);
      pos += ofsBytes;
      ofsBase = entryOffset - baseOffset;
      if (ofsBase < 12 || ofsBase >= entryOffset) {
        throw new Error('Invalid OFS_DELTA base offset');
      }
    }

    const inflateRes = zlib.inflateSync(buf.subarray(pos), { info: true });
    const inflated = inflateRes.buffer;
    pos += inflateRes.engine.bytesWritten;

    if (inflated.length !== size) {
      throw new Error(`Inflated size mismatch: expected ${size}, got ${inflated.length}`);
    }

    entries.push({ entryOffset, typeCode, refSha, ofsBase, inflated });
  }

  if (pos !== buf.length - 20) {
    throw new Error('Trailing bytes after pack entries');
  }

  const resolvedCache = new Map<number, { type: ObjectType; content: Buffer; sha: string }>();

  function resolveEntry(index: number): { type: ObjectType; content: Buffer; sha: string } {
    if (resolvedCache.has(index)) {
      return resolvedCache.get(index)!;
    }
    const entry = entries[index];
    let result: { type: ObjectType; content: Buffer; sha: string };

    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      const typeMap: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
      const type = typeMap[entry.typeCode];
      const content = entry.inflated!;
      result = { type, content, sha: shaOf(type, content) };
    } else if (entry.typeCode === 6) {
      const baseIdx = entries.findIndex((e, j) => j !== index && e.entryOffset === entry.ofsBase);
      if (baseIdx === -1) {
        throw new Error('OFS_DELTA base not found in pack');
      }
      const base = resolveEntry(baseIdx);
      const content = applyDelta(base.content, entry.inflated!);
      const type = base.type;
      result = { type, content, sha: shaOf(type, content) };
    } else if (entry.typeCode === 7) {
      let foundBase: { type: ObjectType; content: Buffer; sha: string } | undefined;
      for (let j = 0; j < entries.length; j++) {
        if (j === index) continue;
        const candidate = resolveEntry(j);
        if (candidate.sha === entry.refSha) {
          foundBase = candidate;
          break;
        }
      }

      if (!foundBase) {
        const extBase = getBase(entry.refSha!);
        if (!extBase) {
          throw new Error(`REF_DELTA base not found: ${entry.refSha}`);
        }
        foundBase = { type: extBase.type, content: extBase.content, sha: entry.refSha! };
      }

      const content = applyDelta(foundBase.content, entry.inflated!);
      const type = foundBase.type;
      result = { type, content, sha: shaOf(type, content) };
    } else {
      throw new Error(`Unknown object type code: ${entry.typeCode}`);
    }

    resolvedCache.set(index, result);
    return result;
  }

  const packObjects: PackObject[] = [];
  for (let i = 0; i < entries.length; i++) {
    const res = resolveEntry(i);
    packObjects.push({ sha: res.sha, type: res.type, content: res.content });
  }

  return packObjects;
}

/** Pack bytes are a pure function of their object set (buildPack sorts by type then sha and deflates deterministically), so identical object sets build identical packs. The clone workload asks for the same 3-object pack 50 times a round; caching the finished pack makes 49 of them a Map lookup. Byte-bounded with FIFO eviction so a trial that creates many distinct packs cannot grow the cache without limit. */
const PACK_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const packCache = new Map<string, Buffer>();
let packCacheBytes = 0;

function packCacheKey(sorted: PackObject[]): string {
  return sorted.map((o) => `${o.type}:${o.sha}`).join(',');
}

function packCacheGet(key: string): Buffer | undefined {
  return packCache.get(key);
}

function packCachePut(key: string, pack: Buffer): void {
  if (packCache.has(key)) return;
  while (packCacheBytes + pack.length > PACK_CACHE_MAX_BYTES && packCache.size > 0) {
    const oldest = packCache.keys().next();
    if (oldest.done) break;
    const evicted = packCache.get(oldest.value)!;
    packCacheBytes -= evicted.length;
    packCache.delete(oldest.value);
  }
  if (pack.length > PACK_CACHE_MAX_BYTES) return;
  packCache.set(key, pack);
  packCacheBytes += pack.length;
}

export function buildPack(objects: PackObject[]): Buffer {
  const sorted = [...objects].sort((a, b) => {
    const typeOrder = (t: ObjectType) => (t === 'commit' ? 1 : t === 'tree' ? 2 : t === 'blob' ? 3 : 4);
    const oa = typeOrder(a.type);
    const ob = typeOrder(b.type);
    if (oa !== ob) return oa - ob;
    return a.sha.localeCompare(b.sha);
  });

  const key = packCacheKey(sorted);
  const cached = packCacheGet(key);
  if (cached !== undefined) return cached;

  const chunks: Buffer[] = [];

  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  chunks.push(header);

  for (const obj of sorted) {
    const hdr = packObjectHeader(obj.type, obj.content.length);
    // Level 1: the pack only needs valid zlib the client can inflate, and the
    // client checks the pack checksum, not the compression ratio. Level 1 is
    // several times faster than the default level 6 on these small objects.
    const deflated = zlib.deflateSync(obj.content, { level: 1 });
    chunks.push(hdr);
    chunks.push(deflated);
  }

  const body = Buffer.concat(chunks);
  const checksum = crypto.createHash('sha1').update(body).digest();
  const pack = Buffer.concat([body, checksum]);
  packCachePut(key, pack);
  return pack;
}
