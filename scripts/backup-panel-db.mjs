import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function main() {
  const envFile = path.join(repoRoot, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const dataDir = path.resolve(repoRoot, process.env.DATA_DIR ?? 'data');
  const dbPath = path.join(dataDir, 'panel.db');
  if (!fs.existsSync(dbPath)) throw new Error(`找不到数据库：${dbPath}`);

  const compact = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const defaultTarget = path.join(dataDir, 'backups-panel', `panel-${compact.slice(0, 8)}-${compact.slice(8)}.db`);
  const target = path.resolve(process.argv[2] ?? defaultTarget);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const db = new Database(dbPath);
  try {
    await db.backup(target);
  } finally {
    db.close();
  }
  console.log(`面板数据库快照：${target}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
