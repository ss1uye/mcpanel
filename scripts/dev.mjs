import { spawn } from 'node:child_process';

const devEnv = { ...process.env, NODE_ENV: 'development' };
const shell = process.platform === 'win32';

const children = [
  spawn('npm', ['run', 'dev', '-w', '@mcpanel/server'], { stdio: 'inherit', shell, env: devEnv }),
  spawn('npm', ['run', 'dev', '-w', '@mcpanel/web'], { stdio: 'inherit', shell, env: devEnv }),
];

const stop = (code = 0) => {
  for (const child of children) child.kill();
  process.exit(code);
};

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

for (const child of children) {
  child.on('exit', (code) => {
    if (code) stop(code);
  });
}
