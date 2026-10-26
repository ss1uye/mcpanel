import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const files = [
  ...fs
    .readdirSync('release')
    .filter((name) => name.endsWith('.zip'))
    .map((name) => path.join('release', name)),
  ...fs
    .readdirSync('release/desktop')
    .filter((name) => name.endsWith('.exe'))
    .map((name) => path.join('release/desktop', name)),
];

const lines = [];
for (const file of files) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  lines.push(`${hash.digest('hex')}  ${path.basename(file)}`);
}
fs.writeFileSync('release/SHA256SUMS.txt', `${lines.join('\n')}\n`);
console.log(`Wrote release/SHA256SUMS.txt (${lines.length} files)`);
