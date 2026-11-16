const { Readable } = require('node:stream');
const CDN = /(^|\.)(music\.126\.net|music\.163\.com|gtimg\.cn|qq\.com|kugou\.com|mzstatic\.com)$/i;

async function fetchArtwork(fetcher, input, outerSignal) {
  let url = new URL(input);
  const timeout = AbortSignal.timeout(12000);
  const signal = outerSignal ? AbortSignal.any([timeout, outerSignal]) : timeout;
  for (let hop = 0; hop < 6; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || !CDN.test(url.hostname))
      throw Error('Unsupported artwork source');
    const response = await fetcher(url.href, { credentials: 'omit', redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get('location'), url);
      continue;
    }
    if (!response.ok || !/^image\//i.test(response.headers.get('content-type') || '') || !response.body)
      throw Error('Artwork unavailable');
    const chunks = [];
    let size = 0;
    for await (const chunk of Readable.fromWeb(response.body)) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw Error('Artwork too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw Error('Too many artwork redirects');
}

function createArtworkCache({ fetcher, maxEntries = 64, maxBytes = 64 * 1024 * 1024 } = {}) {
  const entries = new Map();
  const inFlight = new Map();
  let totalBytes = 0;

  function put(url, buffer) {
    if (!buffer?.length || buffer.length > maxBytes) return;
    if (entries.has(url)) {
      totalBytes -= entries.get(url).length;
      entries.delete(url);
    }
    entries.set(url, buffer);
    totalBytes += buffer.length;
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      totalBytes -= entries.get(oldestKey).length;
      entries.delete(oldestKey);
    }
  }

  async function get(url, signal) {
    if (!url) return null;
    signal?.throwIfAborted();
    if (entries.has(url)) {
      const hit = entries.get(url);
      entries.delete(url);
      entries.set(url, hit);
      return hit;
    }
    if (!inFlight.has(url)) {
      const task = fetchArtwork(fetcher, url)
        .then((buf) => {
          put(url, buf);
          return buf;
        })
        .finally(() => {
          inFlight.delete(url);
        });
      inFlight.set(url, task);
    }
    const pending = inFlight.get(url);
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(Error('Cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (buf) => {
          signal.removeEventListener('abort', onAbort);
          resolve(buf);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  return {
    get,
    clear: () => {
      entries.clear();
      totalBytes = 0;
    },
    size: () => entries.size,
  };
}

module.exports = { fetchArtwork, createArtworkCache };
