import { spawn } from 'node:child_process';

const children = [
  spawn('npm', ['run', 'dev', '-w', '@mcpanel/server'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn('npm', ['run', 'dev', '-w', '@mcpanel/web'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
