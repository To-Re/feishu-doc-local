// Original geometric fixture for 本地飞书文档. No imported artwork or fonts.
// Check the committed image without writing it:
//   node scripts/generate-example-colors.mjs --check
// Recreate it in a new file (an existing destination is never overwritten):
//   node scripts/generate-example-colors.mjs --output /tmp/colors.png
import { readFile, writeFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const width = 720, height = 180;
const raw = Buffer.alloc((width * 3 + 1) * height);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    let color = [250, 251, 253];
    if (y >= 16 && y < 164) {
      if (x >= 12 && x < 228) color = [225, 234, 254];
      else if (x >= 252 && x < 468) color = [229, 242, 236];
      else if (x >= 492 && x < 708) color = [251, 236, 211];
    }
    raw.set(color, y * (width * 3 + 1) + 1 + x * 3);
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length, 0);
  result.write(type, 4, 'ascii');
  bytes.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
header[8] = 8; header[9] = 2; // RGB8, standard compression/filter, no interlace.
const image = Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--check') {
  const original = await readFile(new URL('../examples/assets/colors.png', import.meta.url));
  if (!original.subarray(0, 8).equals(signature)) throw new Error('Invalid PNG signature');
  const data = [];
  let hasHeader = false, hasEnd = false;
  for (let offset = 8; offset < original.length;) {
    if (offset + 12 > original.length) throw new Error('Truncated PNG chunk');
    const size = original.readUInt32BE(offset), end = offset + size + 12;
    if (end > original.length) throw new Error('Truncated PNG content');
    const type = original.toString('ascii', offset + 4, offset + 8);
    const bytes = original.subarray(offset + 8, end - 4);
    if (original.readUInt32BE(end - 4) !== crc32(original.subarray(offset + 4, end - 4))) throw new Error('Invalid PNG checksum');
    if (type === 'IHDR') {
      if (hasHeader || !bytes.equals(header)) throw new Error('Unexpected PNG dimensions or format');
      hasHeader = true;
    } else if (type === 'IDAT') data.push(bytes);
    else if (type === 'IEND') {
      if (size || end !== original.length) throw new Error('Unexpected PNG end');
      hasEnd = true;
    } else throw new Error(`Unexpected PNG chunk: ${type}`);
    offset = end;
  }
  // Different zlib versions may compress the same pixels differently.
  if (!hasHeader || !hasEnd || !inflateSync(Buffer.concat(data)).equals(raw)) throw new Error('Fixture pixels differ from the original geometric source');
  console.log(`Verified 720 × 180 original color fixture; SHA-256 ${createHash('sha256').update(original).digest('hex')}`);
} else if (args.length === 2 && args[0] === '--output' && args[1]) {
  await writeFile(args[1], image, { flag: 'wx' });
  console.log(`Created original color fixture; SHA-256 ${createHash('sha256').update(image).digest('hex')}`);
} else {
  throw new Error('Use --check or --output <new-file-path>');
}
