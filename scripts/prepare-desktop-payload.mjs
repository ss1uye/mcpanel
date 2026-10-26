import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('桌面版目前只支持 Windows x64');
}

const result = spawnSync(process.execPath, ['scripts/package-portable.mjs', '--no-zip'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const source = path.join(repoRoot, 'release', `mcpanel-${pkg.version}-win-x64`);
const target = path.join(repoRoot, 'apps/desktop/build/server');
await fsp.rm(target, { recursive: true, force: true });
await fsp.cp(source, target, { recursive: true, force: true, dereference: true });
await fsp.copyFile(
  path.join(repoRoot, 'packaging/icon.png'),
  path.join(repoRoot, 'apps/desktop/build/icon.png'),
);
await fsp.copyFile(
  path.join(repoRoot, 'packaging/icon.ico'),
  path.join(repoRoot, 'apps/desktop/build/icon.ico'),
);
console.log(`[desktop] server payload: ${target}`);
