import fs from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('dist');
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
for (const file of ['index.html', 'app.js', 'styles.css']) {
  await fs.copyFile(file, path.join(output, file));
}
