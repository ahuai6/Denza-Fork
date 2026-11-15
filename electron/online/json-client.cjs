async function readJSON(fetcher, url, options = {}) {
  const response = await fetcher(url, {
    ...options,
    credentials: 'omit',
    signal: AbortSignal.any([AbortSignal.timeout(20000), ...(options.signal ? [options.signal] : [])]),
  });
  if (!response.ok) throw Error('Music service HTTP ' + response.status);
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) throw Error('Music response too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Error('Music service returned invalid JSON');
  }
}
module.exports = { readJSON };
