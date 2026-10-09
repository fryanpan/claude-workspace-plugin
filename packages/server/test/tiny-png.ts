import { deflateSync } from 'node:zlib';

/**
 * A valid PNG of `width` x `height` grey pixels, built here rather than
 * copied from anywhere: signature, IHDR, one IDAT, IEND. `shade` varies the
 * bytes so two images can be told apart by content.
 */
export function tinyPng(shade = 128, width = 2, height = 2): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const rows = Buffer.alloc((width + 1) * height, shade);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0; // filter byte
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', new Uint8Array(0)),
    ]),
  );
}
