const { parentPort, workerData } = require('node:worker_threads');

(async () => {
  try {
    const { platform, method, query } = workerData;
    if (platform !== 'qq' && !query.proxy && (process.env.HTTPS_PROXY || process.env.HTTP_PROXY))
      query.proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    process.env.DEBUG = 'false';
    process.env.LOG_LEVEL = 'error';
    process.env.DOTENV_CONFIG_QUIET = 'true';
    const sdk = await require('./online/sdk-loaders.cjs').loadSDK(platform);
    if (typeof sdk[method] !== 'function') throw Error('Platform operation unavailable');
    parentPort.postMessage({ value: await sdk[method](query) });
  } catch (e) {
    // SDK errors can include authenticated request URLs; expose the operation, never those URLs.
    parentPort.postMessage({ error: `Platform request failed (${workerData.platform}/${workerData.method})` });
  }
})();
