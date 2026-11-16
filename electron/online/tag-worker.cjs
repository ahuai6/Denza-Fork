const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = fs.promises;
const { createHash } = require('node:crypto');
const { writeDownloadTags, verifyLyrics } = require('./tags.cjs');

let mmPromise = null;
function getMM() {
  if (!mmPromise) mmPromise = import('music-metadata');
  return mmPromise;
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

parentPort.on('message', async (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'shutdown') process.exit(0);
  const { id, tempPath, stagedPath, ext, track, found, mode, artwork, expectedDuration } = message;
  try {
    try {
      await fsp.copyFile(tempPath, stagedPath, fs.constants.COPYFILE_EXCL);
      const lyrics = writeDownloadTags(
        stagedPath,
        ext,
        track,
        found,
        mode,
        artwork?.length ? Buffer.from(artwork) : undefined,
      );
      const mm = await getMM();
      const checked = await mm.parseFile(stagedPath, { duration: true, skipCovers: true });
      verifyLyrics(checked, lyrics);
      if (!checked.format.duration || Math.abs(checked.format.duration - expectedDuration) > 0.05) {
        throw Error('Tag validation failed');
      }
      await fsp.unlink(tempPath);
      const sha256 = await digest(stagedPath);
      parentPort.postMessage({ id, ok: true, file: stagedPath, lyrics, sha256 });
    } catch {
      await fsp.rm(stagedPath, { force: true }).catch(() => {});
      const sha256 = await digest(tempPath);
      parentPort.postMessage({ id, ok: false, file: tempPath, sha256 });
    }
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
