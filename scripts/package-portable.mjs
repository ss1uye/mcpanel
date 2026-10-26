import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const releaseRoot = path.join(repoRoot, 'release');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version;
const folderName = `mcpanel-${version}-win-x64`;
const staging = path.join(releaseRoot, folderName);
const zipPath = path.join(releaseRoot, `${folderName}.zip`);

if (process.platform !== 'win32') throw new Error('便携包目前只支持 Windows x64');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`需要使用 Node 24 打包，当前为 ${process.version}`);
}

for (const required of ['apps/server/dist/index.js', 'apps/server/drizzle', 'apps/web/dist/index.html']) {
  if (!fs.existsSync(path.join(repoRoot, required))) {
    throw new Error(`缺少构建产物：${required}（请先运行 npm run build）`);
  }
}

async function copyDir(source, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.cp(source, destination, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (entry) => !entry.endsWith('.map'),
  });
}

async function copyFile(source, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(source, destination);
}

function writeText(destination, text) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, text.replace(/\r?\n/g, '\r\n'), 'utf8');
}

async function runtimeDependencies() {
  const args = ['ls', '--omit=dev', '--all', '--parseable', '--workspace=@mcpanel/server'];
  const npmCli =
    process.env.npm_execpath ??
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) throw new Error('找不到 npm-cli.js，请通过 npm run release:portable 执行');
  const output = execFileSync(process.execPath, [npmCli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const copied = new Set();
  for (const line of output.split(/\r?\n/)) {
    const absolute = line.trim();
    if (!absolute) continue;
    const relative = path.relative(repoRoot, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (relative.split(path.sep)[0] !== 'node_modules') continue;
    const normalized = relative.replaceAll('\\', '/');
    if (normalized.startsWith('node_modules/@mcpanel/')) continue;
    if (copied.has(relative)) continue;
    copied.add(relative);
    await copyDir(absolute, path.join(staging, relative));
  }
  return copied.size;
}

await fsp.rm(staging, { recursive: true, force: true });
await fsp.rm(zipPath, { force: true });
await fsp.mkdir(staging, { recursive: true });

await copyDir(path.join(repoRoot, 'apps/server/dist'), path.join(staging, 'apps/server/dist'));
await copyDir(path.join(repoRoot, 'apps/server/drizzle'), path.join(staging, 'apps/server/drizzle'));
await copyDir(path.join(repoRoot, 'apps/web/dist'), path.join(staging, 'apps/web/dist'));
await copyFile(path.join(repoRoot, 'package.json'), path.join(staging, 'package.json'));
await copyFile(path.join(repoRoot, 'apps/server/package.json'), path.join(staging, 'apps/server/package.json'));
await copyFile(path.join(repoRoot, '.env.example'), path.join(staging, '.env.example'));
await copyFile(path.join(repoRoot, 'LICENSE'), path.join(staging, 'LICENSE'));
await copyFile(path.join(repoRoot, 'scripts/reset-password.mjs'), path.join(staging, 'scripts/reset-password.mjs'));

const startScript = fs
  .readFileSync(path.join(repoRoot, 'packaging/start-panel.bat'), 'utf8')
  .replaceAll('{{VERSION}}', version);
writeText(path.join(staging, 'start-panel.bat'), startScript);
const readme = fs
  .readFileSync(path.join(repoRoot, 'packaging/README.txt'), 'utf8')
  .replaceAll('{{VERSION}}', version);
writeText(path.join(staging, 'README.txt'), readme);
await copyFile(path.join(repoRoot, 'packaging/THIRD_PARTY_NOTICES.txt'), path.join(staging, 'THIRD_PARTY_NOTICES.txt'));

await copyFile(process.execPath, path.join(staging, 'node/node.exe'));
await copyFile(path.join(repoRoot, 'packaging/licenses/node-LICENSE.txt'), path.join(staging, 'node/LICENSE'));

const dependencyCount = await runtimeDependencies();

execFileSync('tar.exe', ['-a', '-c', '-f', path.basename(zipPath), folderName], {
  cwd: releaseRoot,
  stdio: 'inherit',
});

const hash = createHash('sha256');
await new Promise((resolve, reject) => {
  const stream = fs.createReadStream(zipPath);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('end', resolve);
  stream.on('error', reject);
});
const digest = hash.digest('hex');
fs.writeFileSync(path.join(releaseRoot, 'SHA256SUMS.txt'), `${digest}  ${path.basename(zipPath)}\n`);
const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);

console.log(`Portable package: ${zipPath}`);
console.log(`Version: ${version} · runtime deps: ${dependencyCount} · size: ${sizeMb} MB`);
console.log(`SHA256: ${digest}`);
