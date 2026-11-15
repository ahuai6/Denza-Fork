const { Worker } = require('node:worker_threads');
const path = require('node:path');
function sdk(platform, method, query, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, '../platform-worker.cjs'), {
      workerData: { platform, method, query },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      err ? reject(err) : resolve(value);
    };
    const abort = () => finish(Error('Cancelled'));
    const timer = setTimeout(() => finish(Error('Platform request timed out')), 25000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('error', (e) => finish(e));
    worker.once('exit', () => finish(Error('Platform worker stopped')));
    worker.once('message', (r) => finish(r.error ? Error(r.error) : null, r.value));
    if (signal?.aborted) abort();
  });
}
function unwrap(raw) {
  let body = raw?.body ?? raw;
  if (body?.response && typeof body.response === 'object') body = body.response;
  if (
    raw?.status >= 400 ||
    body?.error ||
    body?.isOk === false ||
    body?.status === 0 ||
    (body?.code !== undefined && ![0, 1, 200, 800, 801, 802, 803].includes(Number(body.code))) ||
    (body?.error_code && Number(body.error_code) !== 0)
  )
    throw Error('Platform rejected the request');
  return body;
}
module.exports = { sdk, unwrap };
