const { writeDownloadTags, verifyLyrics, nativeTtml } = require('./online/tags.cjs');
const { fetchAudio } = require('./online/http-files.cjs');
const { validateFormat } = require('./online/audio-validation.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const safeName = (s) =>
  String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 110) || 'song';
function audioExtension(b) {
  if (b.subarray(0, 4).toString() === 'fLaC') return 'flac';
  if (b[0] === 255 && (b[1] & 246) === 240) return 'aac';
  if (b.subarray(0, 3).toString() === 'ID3' || (b[0] === 255 && (b[1] & 224) === 224)) return 'mp3';
  if (b.subarray(4, 8).toString() === 'ftyp') return 'm4a';
  if (b.subarray(0, 4).toString() === 'OggS') return 'ogg';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WAVE') return 'wav';
  throw Error('The response is not supported audio');
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
// An exclusive link exposes the complete staged file without overwriting a song or exposing a partial copy.
async function commit(temp, folder, name, ext, intent = async () => {}) {
  for (let n = 0; n < 10000; n++) {
    const file = path.join(folder, `${safeName(name)}${n ? ` (${n})` : ''}.${ext}`);
    try {
      await intent(file);
      await fs.promises.link(temp, file);
      await fs.promises.unlink(temp).catch(() => {});
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw Error('Cannot reserve a file name');
}
class Downloads {
  constructor(store, platforms, library, publish, fetcher = fetchAudio, artworkFetcher = fetch) {
    Object.assign(this, { store, platforms, library, publish, fetcher, artworkFetcher });
    this.running = new Map();
    this.tasks = new Set();
    this.closed = false;
    for (const j of store.data.jobs)
      if (['queued', 'resolving', 'downloading', 'saving'].includes(j.status)) j.status = 'paused';
  }
  view() {
    return this.store.data.jobs.map(({ file, pending, folder, ...view }) => view);
  }

  async add(tracks, quality) {
    if (!this.store.data.folder) throw Error('Choose a download folder first');
    if (!['standard', 'high', 'lossless', 'hires'].includes(quality) || !tracks.length || tracks.length > 100)
      throw Error('Invalid download selection');
    if (this.store.data.jobs.length + tracks.length > 1000) throw Error('Remove completed tasks first');
    for (const track of tracks) {
      if (
        this.store.data.jobs.some(
          (j) =>
            j.track.platform === track.platform &&
            j.track.id === track.id &&
            !['completed', 'failed', 'cancelled'].includes(j.status),
        )
      )
        continue;
      this.store.data.jobs.push({
        id: randomUUID(),
        track,
        quality,
        lyricsMode: this.store.data.preferences?.lyricsMode || 'both',
        folder: this.store.data.folder,
        status: 'queued',
        received: 0,
        total: 0,
      });
    }
    await this.store.save();
    this.publish();
    this.pump();
    return this.view();
  }
  async action(id, action) {
    const j = this.store.data.jobs.find((x) => x.id === id);
    if (!j || j.status === 'saving') throw Error('Task unavailable while saving');
    if (action === 'pause' || action === 'cancel') {
      j.status = action === 'pause' ? 'paused' : 'cancelled';
      this.running.get(id)?.abort();
    } else if (action === 'retry' && !this.running.has(id)) {
      j.status = 'queued';
      j.error = '';
      j.received = 0;
    } else if (action === 'remove' && !this.running.has(id))
      this.store.data.jobs = this.store.data.jobs.filter((x) => x !== j);
    else throw Error('Task is still running');
    await this.store.save();
    this.publish();
    this.pump();
    return this.view();
  }
  pump() {
    if (this.closed) return;
    while (this.running.size < 2) {
      const job = this.store.data.jobs.find((j) => j.status === 'queued' && !this.running.has(j.id));
      if (!job) break;
      const controller = new AbortController();
      this.running.set(job.id, controller);
      const task = this.run(job, controller).finally(async () => {
        this.running.delete(job.id);
        this.tasks.delete(task);
        await this.store.save();
        this.publish();
        this.pump();
      });
      this.tasks.add(task);
      task.catch(() => {});
    }
  }
  async run(job, controller) {
    let temp;
    let idle;
    try {
      if (job.pending && fs.existsSync(job.pending.file)) {
        const pending = job.pending;
        delete job.pending;
        if ((await digest(pending.file)) !== pending.sha256)
          throw Error('The interrupted download file changed; retry to download a new copy');
        job.file = pending.file;
      }
      // A committed file survives an interrupted import; retry imports it rather than downloading again.
      if (job.file && fs.existsSync(job.file)) {
        job.status = 'saving';
        await this.library.importDownload(job.file, job.track);
        job.status = 'completed';
        return;
      }
      job.status = 'resolving';
      delete job.fallbackReason;
      delete job.metadataWarning;
      delete job.lyrics;
      this.publish();
      let ext, meta, mm;
      const tiers = ['hires', 'lossless', 'high', 'standard'];
      const attempts = tiers.slice(tiers.indexOf(job.quality)).map((quality) => ({ quality, alternate: false }));
      for (const attempt of attempts) {
        const { quality, alternate } = attempt;
        let canFallback = false;
        try {
          job.resolvedQuality = quality;
          const {
            url,
            headers,
            source,
            transport,
            expectedFormat,
            qualityByFormat,
            canFallback: retrySource,
            headerTimeoutMs = 25000,
          } = await this.platforms.resolve(job.track, quality, controller.signal, alternate);
          canFallback = retrySource;
          job.source = source || job.track.platform;
          const headerTimer = setTimeout(() => controller.abort(), Math.min(180000, Math.max(1000, headerTimeoutMs)));
          let r;
          try {
            r = await this.fetcher(url, { signal: controller.signal, transport, headers });
          } finally {
            clearTimeout(headerTimer);
          }
          if (!r.ok || !r.body) throw Error('Audio server HTTP ' + r.status);
          const limit = 2 * 1024 ** 3;
          job.total = Number(r.headers.get('content-length')) || 0;
          if (job.total > limit) {
            await r.body.cancel();
            throw Error('File exceeds 2 GB');
          }
          await fs.promises.mkdir(job.folder, { recursive: true });
          temp = path.join(job.folder, `.denza-${job.id}.part`);
          let head = Buffer.alloc(0),
            last = 0;
          job.status = 'downloading';
          job.received = 0;
          this.publish();
          const touch = () => {
            clearTimeout(idle);
            idle = setTimeout(() => controller.abort(), 45000);
          };
          touch();
          const meter = new Transform({
            transform: (chunk, _encoding, next) => {
              touch();
              job.received += chunk.length;
              if (job.received > limit) return next(Error('File exceeds 2 GB'));
              if (head.length < 512) head = Buffer.concat([head, chunk]).subarray(0, 512);
              if (Date.now() - last > 350) {
                last = Date.now();
                this.publish();
              }
              next(null, chunk);
            },
          });
          await pipeline(Readable.fromWeb(r.body), meter, fs.createWriteStream(temp, { flags: 'wx' }), {
            signal: controller.signal,
          });
          clearTimeout(idle);
          if (job.total && job.received !== job.total) throw Error('Incomplete audio transfer');
          ext = audioExtension(head);
          mm = await import('music-metadata');
          meta = await mm.parseFile(temp, { duration: true, skipCovers: true });
          validateFormat(expectedFormat, ext, meta, job.track.duration);
          if (!meta.format.duration || (job.track.duration > 60 && meta.format.duration + 15 < job.track.duration))
            throw Error('Audio is incomplete or a preview');
          const lossless = /FLAC|ALAC|PCM|WAVE/i.test(meta.format.codec || ext);
          const actual = lossless
            ? (meta.format.sampleRate || 0) > 48000 || (meta.format.bitsPerSample || 0) > 16
              ? 'hires'
              : 'lossless'
            : (meta.format.bitrate || 0) >= 240000
              ? 'high'
              : 'standard';
          // AM tiers name formats (MP3/AAC/FLAC/ALAC), validated above, rather than sample rates.
          if (!qualityByFormat && tiers.indexOf(actual) > tiers.indexOf(quality)) {
            throw Error('The returned audio has a lower measured quality');
          }
          break;
        } catch (error) {
          clearTimeout(idle);
          if (temp) await fs.promises.rm(temp, { force: true }).catch(() => {});
          temp = null;
          if (controller.signal.aborted) throw error;
          if (canFallback && !alternate) {
            attempts.splice(attempts.indexOf(attempt) + 1, 0, { quality, alternate: true });
          } else {
            if (quality === 'standard') throw error;
            job.fallbackReason = 'The selected quality is unavailable; trying the next tier';
          }
          job.received = 0;
          job.total = 0;
          job.status = 'resolving';
          this.publish();
        }
      }
      job.info = {
        codec: meta.format.codec || ext,
        sampleRate: meta.format.sampleRate || 0,
        bits: meta.format.bitsPerSample || 0,
        bitrate: meta.format.bitrate || 0,
      };
      controller.signal.throwIfAborted();
      job.status = 'saving';
      this.publish();
      const tagged = temp + '.' + ext;
      await fs.promises.rename(temp, tagged);
      temp = tagged;
      let staged;
      try {
        let found, artwork;
        const mode = job.lyricsMode || 'both';
        if (mode !== 'none') {
          try {
            found = await this.platforms.lyrics(
              job.track,
              AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
            );
          } catch {
            job.metadataWarning = 'Lyrics could not be fetched; audio has been retained';
          }
        }
        if (mode !== 'none' && !found) {
          const embedded = nativeTtml(meta.native) || meta.common.lyrics?.[0]?.text;
          if (embedded) {
            found = { original: embedded, source: 'embedded' };
            delete job.metadataWarning;
          }
        }
        if (job.track.artworkUrl) {
          try {
            const response = await this.artworkFetcher(job.track.artworkUrl, {
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
              credentials: 'omit',
            });
            if (!response.ok || !response.body) throw Error('Artwork unavailable');
            const chunks = [];
            let size = 0;
            for await (const chunk of Readable.fromWeb(response.body)) {
              size += chunk.length;
              if (size > 8 * 1024 * 1024) throw Error('Artwork too large');
              chunks.push(chunk);
            }
            artwork = Buffer.concat(chunks);
          } catch {
            /* Cover errors must not discard audio or lyric tags. */
          }
        }
        staged = path.join(job.folder, `.denza-${job.id}.tags.${ext}`);
        await fs.promises.copyFile(temp, staged, fs.constants.COPYFILE_EXCL);
        job.lyrics = writeDownloadTags(staged, ext, job.track, found, mode, artwork);
        const checked = await mm.parseFile(staged, { duration: true, skipCovers: true });
        verifyLyrics(checked, job.lyrics);
        if (!checked.format.duration || Math.abs(checked.format.duration - meta.format.duration) > 0.05)
          throw Error('Tag validation failed');
        await fs.promises.unlink(temp);
        temp = staged;
        staged = null;
      } catch {
        job.lyrics = { mode: job.lyricsMode || 'both', fields: [], status: 'unavailable' };
        job.metadataWarning = 'Audio saved; metadata validation or writing failed';
      } finally {
        if (staged) await fs.promises.rm(staged, { force: true }).catch(() => {});
      }
      const sha256 = await digest(temp);
      job.file = await commit(temp, job.folder, `${job.track.artist} - ${job.track.title}`, ext, async (file) => {
        job.pending = { file, sha256 };
        await this.store.save();
      });
      delete job.pending;
      temp = null;
      await this.store.save();
      await this.library.importDownload(job.file, job.track);
      job.status = 'completed';
    } catch (e) {
      if (!['paused', 'cancelled'].includes(job.status)) {
        job.status = 'failed';
        job.error = controller.signal.aborted ? 'Download timed out' : String(e.message || e).slice(0, 250);
      }
    } finally {
      clearTimeout(idle);
      if (temp) await fs.promises.rm(temp, { force: true }).catch(() => {});
    }
  }
  async close() {
    this.closed = true;
    for (const [id, c] of this.running) {
      const j = this.store.data.jobs.find((x) => x.id === id);
      if (j.status !== 'saving') {
        j.status = 'paused';
        c.abort();
      }
    }
    await Promise.allSettled([...this.tasks]);
    await this.store.save();
  }
}
module.exports = { Downloads, audioExtension, commit };
