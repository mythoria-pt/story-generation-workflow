import { copyFile, glob, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

for await (const asset of glob('**/*.{json,html,icc,mp3}', { cwd: 'src' })) {
  const destination = join('dist', asset);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join('src', asset), destination);
}
