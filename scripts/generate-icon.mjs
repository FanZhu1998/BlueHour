import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'build');

function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ (0xedb88320 & -(checksum & 1));
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const kind = Buffer.from(type);
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length, 0);
  kind.copy(result, 4);
  bytes.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([kind, bytes])), result.length - 4);
  return result;
}

function colorAt(x, y) {
  const cornerX = Math.max(42 - x, x - 214, 0);
  const cornerY = Math.max(42 - y, y - 214, 0);
  if (cornerX * cornerX + cornerY * cornerY > 42 * 42) return [0, 0, 0, 0];
  const radius = Math.hypot(x - 128, y - 128);
  if (radius > 93 && radius < 96) return [49, 75, 92, 255];
  if (radius <= 76) {
    if (Math.hypot(x - 152, y - 108) > 78) return [168, 211, 225, 255];
    if (radius > 73) return [76, 119, 147, 255];
    return [21, 44, 64, 255];
  }
  return [7, 16, 24, 255];
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  // Small supersampling keeps the glyph clean down to a 16-pixel taskbar icon.
  for (let y = 0; y < size; y++) {
    const offset = y * (size * 4 + 1);
    for (let x = 0; x < size; x++) {
      const total = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const color = colorAt(
            ((x + (sx + 0.5) / 4) * 256) / size,
            ((y + (sy + 0.5) / 4) * 256) / size,
          );
          for (let channel = 0; channel < 4; channel++) total[channel] += color[channel];
        }
      for (let channel = 0; channel < 4; channel++)
        raw[offset + 1 + x * 4 + channel] = Math.round(total[channel] / 16);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function generateIcon() {
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (let index = 0; index < sizes.length; index++) {
    const at = 6 + index * 16;
    header[at] = sizes[index] === 256 ? 0 : sizes[index];
    header[at + 1] = header[at];
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(images[index].length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += images[index].length;
  }
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'icon.ico'), Buffer.concat([header, ...images]));
  await writeFile(path.join(output, 'icon.png'), images.at(-1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await generateIcon();
