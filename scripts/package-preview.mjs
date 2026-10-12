import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const files = {};
function walk(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) walk(directory + '/' + entry.name, path + '/');
    else if (entry.isFile() && /\.(html|css|mjs|js|json|svg|png|jpg|jpeg|gif|webp|ico|woff2?)$/.test(path))
      files[path] = readFileSync(directory + '/' + entry.name).toString('base64');
    else if (entry.isSymbolicLink()) throw Error('Preview symlinks are not supported');
  }
}
walk('web');
const bundle = JSON.stringify({
  head: process.env.PR_HEAD_SHA,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  files,
});
if (Buffer.byteLength(bundle) > 20_000_000) throw Error('Preview exceeds 20 MB');
writeFileSync('preview.json', bundle);
