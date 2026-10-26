import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version;
const folderName = `mcpanel-${version}-win-x64`;
const zipPath = path.join(repoRoot, 'release', `${folderName}.zip`);
const smokeRoot = path.join(repoRoot, 'release', 'smoke');

if (process.platform !== 'win32') throw new Error('便携包冒烟目前只支持 Windows');
if (!fs.existsSync(zipPath)) throw new Error(`找不到便携包：${zipPath}（请先运行 npm run release:portable）`);

await fsp.rm(smokeRoot, { recursive: true, force: true });
await fsp.mkdir(smokeRoot, { recursive: true });
execFileSync('tar.exe', ['-xf', path.basename(zipPath), '-C', 'smoke'], {
  cwd: path.dirname(zipPath),
  stdio: 'inherit',
});

const appDir = path.join(smokeRoot, folderName);
if (!fs.existsSync(path.join(appDir, 'node', 'node.exe'))) throw new Error('便携包缺少 node/node.exe');

const port = 32000 + Math.floor(Math.random() * 1000);
const env = {
  ...process.env,
  NODE_ENV: 'production',
  PANEL_HOST: '127.0.0.1',
  PANEL_PORT: String(port),
  DATA_DIR: './data-smoke',
  COOKIE_SECURE: 'false',
  TRUST_PROXY: 'false',
  LOG_LEVEL: 'warn',
};
fs.writeFileSync(
  path.join(appDir, '.env'),
  `NODE_ENV=production\nPANEL_HOST=127.0.0.1\nPANEL_PORT=${port}\nDATA_DIR=./data-smoke\nCOOKIE_SECURE=false\nTRUST_PROXY=false\nLOG_LEVEL=warn\n`,
);

const output = [];
const child = spawn(path.join(appDir, 'node', 'node.exe'), ['apps/server/dist/index.js'], {
  cwd: appDir,
  env: { ...env, NODE_ENV: 'production' },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const capture = (chunk) => {
  output.push(chunk.toString());
  if (output.length > 60) output.shift();
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);

function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
}

async function waitForHealth() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`面板提前退出：${child.exitCode}\n${output.join('')}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.ok === true && body.version === version) return;
      }
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`等待 /api/health 超时\n${output.join('')}`);
}

try {
  await waitForHealth();
  const page = await fetch(`http://127.0.0.1:${port}/`);
  const html = await page.text();
  if (!page.ok || !html.includes('MC Panel')) throw new Error('首页 HTML 校验失败');

  const dataDir = path.join(appDir, 'data-smoke');
  for (const file of ['panel.db', 'secret.key']) {
    if (!fs.existsSync(path.join(dataDir, file))) throw new Error(`数据文件未创建：${file}`);
  }
  console.log(`Portable smoke OK: v${version}, port ${port}`);
  console.log(`Data files: ${dataDir}`);
} finally {
  stop();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // already gone
      }
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await fsp.rm(smokeRoot, { recursive: true, force: true });
}
