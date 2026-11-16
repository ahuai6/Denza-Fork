const { parentPort, workerData } = require('node:worker_threads');

const platform = workerData?.platform;
process.env.DEBUG = 'false';
process.env.LOG_LEVEL = 'error';
process.env.DOTENV_CONFIG_QUIET = 'true';

let sdkPromise = null;
function getSDK() {
  if (!sdkPromise) {
    sdkPromise = require('./online/sdk-loaders.cjs')
      .loadSDK(platform)
      .catch((error) => {
        sdkPromise = null;
        throw error;
      });
  }
  return sdkPromise;
}

async function runOperation(method, query) {
  const payload = query && typeof query === 'object' ? { ...query } : {};
  if (platform !== 'qq' && !payload.proxy && (process.env.HTTPS_PROXY || process.env.HTTP_PROXY)) {
    payload.proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  }
  const sdk = await getSDK();
  if (typeof sdk[method] !== 'function') throw Error('Platform operation unavailable');
  return sdk[method](payload);
}

if (workerData?.method) {
  (async () => {
    try {
      parentPort.postMessage({ value: await runOperation(workerData.method, workerData.query) });
    } catch {
      // SDK errors can include authenticated request URLs; expose the operation, never those URLs.
      parentPort.postMessage({ error: `Platform request failed (${platform}/${workerData.method})` });
    }
  })();
} else {
  parentPort.on('message', async (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'shutdown') {
      process.exit(0);
    }
    const { id, method, query } = message;
    try {
      const value = await runOperation(method, query);
      parentPort.postMessage({ id, value });
    } catch {
      // SDK errors can include authenticated request URLs; expose the operation, never those URLs.
      parentPort.postMessage({ id, error: `Platform request failed (${platform}/${method})` });
    }
  });
}
