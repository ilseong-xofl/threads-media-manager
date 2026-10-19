import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { publicFiles } from './serve.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');
await mkdir(out, { recursive: true });
const hashes = [];
for (const file of publicFiles) {
  await copyFile(join(root, file), join(out, file));
  hashes.push(
    `${createHash('sha256')
      .update(await readFile(join(out, file)))
      .digest('hex')}  ${file}`,
  );
}
await writeFile(join(out, 'SHA256SUMS'), hashes.join('\n') + '\n');
process.stdout.write(
  '배포용 정적 파일 4개와 SHA256SUMS를 validation/mobile-direct/dist/에 준비했습니다. 배포는 실행하지 않았습니다.\n',
);
