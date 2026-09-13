import { cp, copyFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function copyDistributionNotices(directories) {
  for (const directory of directories) {
    const destination = resolve(root, directory);
    if (!(await stat(destination)).isDirectory()) throw new Error(`Build output is missing: ${directory}`);
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      await copyFile(resolve(root, file), resolve(destination, file));
    }
    await cp(resolve(root, 'licenses'), resolve(destination, 'licenses'), { recursive: true });
  }
  console.log('Copied project and third-party license notices into local build output.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  await copyDistributionNotices(process.argv.length>2?process.argv.slice(2):['dist', 'dist/client']);
