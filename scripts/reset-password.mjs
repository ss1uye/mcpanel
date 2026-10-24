import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import Database from 'better-sqlite3';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export async function resetPassword(dbPath, username, password) {
  if (password.length < 12) throw new Error('密码至少 12 个字符');
  if (password.length > 128) throw new Error('密码最多 128 个字符');
  const db = new Database(dbPath);
  try {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!user) throw new Error(`用户不存在：${username}`);
    const hash = await argon2.hash(password, HASH_OPTIONS);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, Date.now(), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  } finally {
    db.close();
  }
}

async function main() {
  const dataDir = path.resolve(repoRoot, process.env.DATA_DIR ?? 'data');
  const dbPath = path.join(dataDir, 'panel.db');
  if (!fs.existsSync(dbPath)) throw new Error(`找不到数据库：${dbPath}`);
  const username = process.argv[2] ?? 'admin';
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const password = await rl.question('新密码（至少 12 个字符）：');
    const confirm = await rl.question('再输入一次：');
    if (password !== confirm) throw new Error('两次输入的密码不一致');
    await resetPassword(dbPath, username, password);
    console.log(`已重置 ${username} 的密码，所有会话已失效。`);
  } finally {
    rl.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
