import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const root = process.cwd();
fs.mkdirSync(path.join(root, 'logs'), { recursive: true });

const log = (line) => {
  fs.appendFileSync(path.join(root, 'logs', 'latest.log'), `${line}\n`);
  console.log(line);
};

const crash = process.argv.includes('--crash');
const exitAfter = Number(process.argv.find((arg) => arg.startsWith('--exit-after='))?.split('=')[1] ?? 0);

log('[Server thread/INFO]: Starting minecraft server version 1.21.1');

if (process.argv.includes('--gbk')) {
  const iconv = (await import('iconv-lite')).default;
  process.stdout.write(iconv.encode('[Server thread/INFO]: 中文日志测试\n', 'gbk'));
}

setTimeout(() => log('[Server thread/INFO]: Done (2.1s)! For help, type "help"'), 200);

if (crash) {
  setTimeout(() => {
    log('[Server thread/ERROR]: Failed to load eula.txt');
    process.exit(1);
  }, 300);
}

if (exitAfter > 0) {
  setTimeout(() => process.exit(0), exitAfter);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  log(`[Server thread/INFO]: received ${line}`);
  if (line === 'stop' && !process.argv.includes('--ignore-stop')) {
    log('[Server thread/INFO]: Stopping server');
    setTimeout(() => process.exit(0), 100);
  }
});
