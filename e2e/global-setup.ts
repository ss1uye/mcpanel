import fs from 'node:fs/promises';
import path from 'node:path';
import { INSTANCE_ROOT } from './helpers';

export default async function globalSetup(): Promise<void> {
  await fs.rm(path.resolve('e2e/.tmp'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

  await fs.mkdir(path.join(INSTANCE_ROOT, 'world'), { recursive: true });
  await fs.mkdir(path.join(INSTANCE_ROOT, 'mods'), { recursive: true });
  await fs.writeFile(path.join(INSTANCE_ROOT, 'world', 'level.dat'), 'e2e-level');
  await fs.writeFile(path.join(INSTANCE_ROOT, 'mods', 'sample.jar'), 'jar');
  await fs.writeFile(path.join(INSTANCE_ROOT, 'eula.txt'), 'eula=true\n');
  await fs.writeFile(
    path.join(INSTANCE_ROOT, 'server.properties'),
    'level-name=world\nserver-port=25620\nenable-rcon=false\nonline-mode=true\nmotd=e2e\n',
  );
  const fixture = path.resolve('apps/server/test/fixtures/fake-server.mjs');
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(INSTANCE_ROOT, 'start.bat'), `@echo off\r\nnode "${fixture}" %*\r\n`);
  } else {
    await fs.writeFile(
      path.join(INSTANCE_ROOT, 'start.sh'),
      `#!/bin/sh\nexec node "${fixture}" "$@"\n`,
      { mode: 0o755 },
    );
  }
}
