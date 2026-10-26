import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const source = path.resolve('release/desktop/win-unpacked');
const exeName = 'MC Panel.exe';
if (!fs.existsSync(path.join(source, exeName))) {
  console.error(`缺少 ${path.join(source, exeName)}，请先运行 npm run desktop:package`);
  process.exit(1);
}

// Copy outside the repository so the packaged server cannot fall back to the
// workspace node_modules and hide a missing payload.
const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcpanel-desktop-run-'));
const appDir = path.join(temp, 'win-unpacked');
try {
  await fsp.cp(source, appDir, { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(appDir, exeName), ['--smoke-test', '--smoke-exit'], {
    stdio: 'inherit',
    env,
  });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      console.error('desktop smoke timed out');
      resolve(1);
    }, 180_000);
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode ?? 1);
    });
  });
  process.exitCode = code;
} finally {
  await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);
}
