import fs from 'node:fs/promises';
import path from 'node:path';

for (const target of ['data-e2e', 'e2e/.tmp', 'test-results']) {
  await fs.rm(path.resolve(target), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
