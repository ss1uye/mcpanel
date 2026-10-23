import { spawn } from 'node:child_process';

const devEnv = { ...process.env, NODE_ENV: 'development' };
const shell = process.platform === 'win32';

const children = [
  spawn('npm', ['run', 'dev', '-w', '@mcpanel/server'], { stdio: 'inherit', shell, env: devEnv }),
  spawn('npm', ['run', 'dev', '-w', '@mcpanel/web'], { stdio: 'inherit', shell, env: devEnv }),
];

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

for (const child of children) {
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.exitCode = code;
      stop();
    }
  });
}
