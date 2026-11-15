// Read-only inventory: dependency updates remain explicit, reviewable commits.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
export function fingerprint(directory) {
  const files = (path) =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      ['node_modules', '.git'].includes(entry.name)
        ? []
        : entry.isDirectory()
          ? files(join(path, entry.name))
          : entry.isFile()
            ? [join(path, entry.name)]
            : [],
    );
  const hash = createHash('sha256');
  const entries = files(directory).map((file) => ({ file, key: relative(directory, file).split(sep).join('/') }));
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { file, key } of entries) hash.update(key).update('\0').update(readFileSync(file)).update('\0');
  return hash.digest('hex');
}
async function main() {
  const manifest = read('docs/online-dependencies.json');
  if (process.argv.includes('--fingerprint')) {
    console.log(fingerprint(join(ROOT, 'vendor/kugou')));
    return;
  }
  const pkg = read('package.json'),
    lock = read('package-lock.json');
  const check = process.argv.includes('--check');
  let failed = false;
  const rows = await Promise.all(
    manifest.dependencies.map(async (entry) => {
      if (entry.kind === 'source') {
        const actual = fingerprint(join(ROOT, entry.path));
        if (actual !== entry.sha256) failed = true;
        return {
          id: entry.id,
          source: entry.source,
          commit: entry.commit,
          status: actual === entry.sha256 ? 'source snapshot verified' : 'source snapshot mismatch',
        };
      }
      if (entry.kind === 'protocol')
        return { id: entry.id, source: entry.source, status: 'unversioned protocol; adapter checks required' };
      const pinned = pkg.dependencies[entry.id];
      const key = entry.kind === 'vendor' ? entry.path : 'node_modules/' + entry.id;
      const locked = lock.packages[key]?.version;
      let installed = 'not installed';
      try {
        installed = read((entry.kind === 'vendor' ? entry.path : 'node_modules/' + entry.id) + '/package.json').version;
      } catch {
        /* Report missing install, without mutating it. */
      }
      let status =
        pinned &&
        locked === installed &&
        (entry.kind === 'vendor' ? pinned === 'file:' + entry.path : pinned === locked)
          ? 'pinned'
          : 'version mismatch';
      if (entry.kind === 'vendor' && fingerprint(join(ROOT, entry.path)) !== entry.sha256)
        status = 'vendor tree mismatch';
      if (status !== 'pinned') failed = true;
      let latest;
      if (check && entry.kind === 'npm') {
        try {
          const { stdout } = await promisify(execFile)(
            process.env.npm_execpath ? process.execPath : 'npm',
            [
              ...(process.env.npm_execpath ? [process.env.npm_execpath] : []),
              'view',
              entry.id,
              'version',
              '--json',
              '--fetch-retries=0',
            ],
            { timeout: 20000, maxBuffer: 65536 },
          );
          latest = JSON.parse(stdout);
        } catch {
          latest = 'lookup failed';
          failed = true;
        }
      }
      return { id: entry.id, pinned, locked, installed, ...(latest ? { latest } : {}), status, source: entry.source };
    }),
  );
  console.log(JSON.stringify(rows, null, 2));
  if (failed) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
