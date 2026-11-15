const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');

// Anonymous file transport. No platform cookies, bearer headers or credentials are forwarded to a file service.
function httpFile(url, { signal } = {}, redirects = 0) {
  signal?.throwIfAborted();
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
    return Promise.reject(Error('Invalid audio service URL'));
  return new Promise((resolve, reject) => {
    const req = (target.protocol === 'https:' ? https : http).get(
      target,
      {
        headers: { 'User-Agent': 'Denza-Fork/3.2.9-denza.1', Accept: 'audio/*,application/octet-stream,*/*' },
      },
      (response) => {
        const status = response.statusCode || 502;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          if (redirects >= 5) return reject(Error('Too many audio service redirects'));
          let next;
          try {
            next = new URL(response.headers.location, target);
          } catch {
            response.destroy();
            reject(Error('Invalid audio service redirect'));
            return;
          }
          if (target.protocol === 'https:' && next.protocol !== 'https:')
            return reject(Error('Insecure audio service redirect'));
          resolve(httpFile(next.href, { signal }, redirects + 1));
          return;
        }
        try {
          const headers = new Headers();
          for (const key of ['content-type', 'content-length'])
            if (response.headers[key]) headers.set(key, response.headers[key]);
          if (status < 200 || status >= 300) {
            response.resume();
            resolve(new Response(null, { status, headers }));
          } else resolve(new Response(Readable.toWeb(response), { status, headers }));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    const abort = () => req.destroy(Error('Audio download cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', abort));
    req.on('error', reject);
    if (signal?.aborted) abort();
  });
}
function fetchAudio(url, options, fileTransport = httpFile) {
  return options.transport === 'http-file'
    ? fileTransport(url, { signal: options.signal })
    : fetch(url, { signal: options.signal, headers: options.headers, credentials: 'omit' });
}
module.exports = { httpFile, fetchAudio };
