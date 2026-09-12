import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = new DatabaseSync(join(root, 'data', 'oracle.db'));
const stamp = new Date().toISOString().slice(0, 10);
const dstPath = join(root, 'data', `backup-${stamp}.db`);
const dst = new DatabaseSync(dstPath);
src.backup(dst);
dst.close();
src.close();
console.log(`backup ok: ${dstPath}`);
