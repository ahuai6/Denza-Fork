const { Readable } = require('node:stream');
const CDN = /(^|\.)(music\.126\.net|music\.163\.com|gtimg\.cn|qq\.com|kugou\.com|mzstatic\.com)$/i;
async function fetchArtwork(fetcher, input) {
  let url = new URL(input);
  const signal = AbortSignal.timeout(12000);
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
module.exports = { fetchArtwork };
