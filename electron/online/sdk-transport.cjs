const { Worker } = require('node:worker_threads');
const path = require('node:path');

const WORKER_SCRIPT = path.join(__dirname, '../platform-worker.cjs');
const REQUEST_TIMEOUT_MS = 25000;
const WORKER_IDLE_MS = 60000;
const MAX_HUNG_REQUESTS = 4;

const pool = new Map();
let nextRequestId = 1;

function clearIdle(slot) {
  if (slot.idleTimer) {
    clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
  }
}

function armIdle(slot) {
  clearIdle(slot);
  if (slot.dead || slot.pending.size > 0) return;
  slot.worker.unref();
  slot.idleTimer = setTimeout(() => {
    void disposeSlot(slot, Error('Platform worker idle timeout'));
  }, WORKER_IDLE_MS);
  slot.idleTimer.unref?.();
}

function teardownSlot(slot, error) {
  if (slot.dead) return;
  slot.dead = true;
  clearIdle(slot);
  if (pool.get(slot.platform) === slot) pool.delete(slot.platform);
  for (const entry of [...slot.pending.values()]) {
    entry.finish(error || Error('Platform worker stopped'));
  }
  slot.pending.clear();
}

async function disposeSlot(slot, error) {
  teardownSlot(slot, error);
  try {
    await slot.worker.terminate();
  } catch {
    /* Worker already exited. */
  }
}

function getSlot(platform) {
  const existing = pool.get(platform);
  if (existing && !existing.dead) {
    clearIdle(existing);
    existing.worker.ref();
    return existing;
  }
  const worker = new Worker(WORKER_SCRIPT, {
    workerData: { platform },
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  const slot = {
    platform,
    worker,
    pending: new Map(),
    idleTimer: null,
    dead: false,
    timeouts: 0,
  };
  worker.on('message', (response) => {
    if (!response || typeof response !== 'object') return;
    const entry = slot.pending.get(response.id);
    if (!entry) return;
    slot.timeouts = 0;
    entry.finish(response.error ? Error(response.error) : null, response.value);
  });
  worker.once('error', (error) => teardownSlot(slot, error));
  worker.once('exit', () => teardownSlot(slot, Error('Platform worker stopped')));
  pool.set(platform, slot);
  return slot;
}

function sdk(platform, method, query, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const slot = getSlot(platform);
    const id = nextRequestId++;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      slot.pending.delete(id);
      if (slot.pending.size === 0) {
        if (slot.timeouts >= MAX_HUNG_REQUESTS) void disposeSlot(slot, Error('Platform worker recycled'));
        else armIdle(slot);
      }
      err ? reject(err) : resolve(value);
    };
    const abort = () => finish(Error('Cancelled'));
    const timer = setTimeout(() => {
      slot.timeouts++;
      finish(Error('Platform request timed out'));
    }, REQUEST_TIMEOUT_MS);
    slot.pending.set(id, { finish });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      slot.worker.postMessage({ id, method, query });
    } catch (error) {
      finish(error);
    }
  });
}

async function closeSdkWorkers() {
  const slots = [...pool.values()];
  pool.clear();
  await Promise.allSettled(slots.map((slot) => disposeSlot(slot, Error('Platform worker closed'))));
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

module.exports = { sdk, unwrap, closeSdkWorkers };
