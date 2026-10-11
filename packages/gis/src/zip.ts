/**
 * Just enough ZIP for shapefiles, which travel as .zip archives: reading stored and
 * deflated entries (inflated with the platform's DecompressionStream) and writing
 * stored entries. No encryption, no ZIP64, no multi-disk archives.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class ZipError extends Error {
  override name = 'ZipError';
}

/** The archive's files by name (folders dropped). */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record is in the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('This is not a ZIP archive.');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new ZipError('The ZIP directory is damaged.');
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (v.getUint32(local, true) !== 0x04034b50) throw new ZipError(`The entry ${name} is damaged.`);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, data.slice());
    else if (method === 8) out.set(name, await inflateRaw(data));
    else throw new ZipError(`${name} uses a compression method this reader does not support.`);
  }
  return out;
}

/** A ZIP archive of the files, stored without compression. */
export function writeZip(files: [string, Uint8Array][]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const dir = new Uint8Array(46 + n.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, data.length, true);
    dv.setUint32(24, data.length, true);
    dv.setUint16(28, n.length, true);
    dv.setUint32(42, offset, true);
    dir.set(n, 46);
    parts.push(local, data);
    central.push(dir);
    offset += local.length + data.length;
  }
  const dirSize = central.reduce((a, d) => a + d.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const b of all) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}
