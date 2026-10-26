import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pngToIco from 'png-to-ico';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const size = 512;
const png = new PNG({ width: size, height: size });
const data = png.data;

const setPixel = (x, y, r, g, b, a = 255) => {
  const index = (y * size + x) * 4;
  data[index] = r;
  data[index + 1] = g;
  data[index + 2] = b;
  data[index + 3] = a;
};

const inRoundedRect = (x, y, left, top, width, height, radius) => {
  if (x < left || x >= left + width || y < top || y >= top + height) return false;
  const cx = Math.min(Math.max(x, left + radius), left + width - 1 - radius);
  const cy = Math.min(Math.max(y, top + radius), top + height - 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
};

const fillRounded = (left, top, width, height, radius, color) => {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      if (inRoundedRect(x, y, left, top, width, height, radius)) setPixel(x, y, ...color);
    }
  }
};

fillRounded(24, 24, 464, 464, 96, [20, 26, 23, 255]);
const blockSize = 104;
const gap = 24;
const grid = blockSize * 3 + gap * 2;
const start = Math.floor((size - grid) / 2);
for (let row = 0; row < 3; row += 1) {
  for (let column = 0; column < 3; column += 1) {
    const color = row === 1 && column === 1 ? [88, 224, 138, 255] : [46, 204, 113, 255];
    fillRounded(
      start + column * (blockSize + gap),
      start + row * (blockSize + gap),
      blockSize,
      blockSize,
      18,
      color,
    );
  }
}

fs.writeFileSync(path.join(repoRoot, 'packaging/icon.png'), PNG.sync.write(png));
fs.writeFileSync(
  path.join(repoRoot, 'packaging/icon.ico'),
  await pngToIco(fs.readFileSync(path.join(repoRoot, 'packaging/icon.png'))),
);
console.log('packaging/icon.png and icon.ico written');
