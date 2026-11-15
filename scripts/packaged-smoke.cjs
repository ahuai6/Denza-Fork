// Run with the packaged Electron executable in ELECTRON_RUN_AS_NODE mode, not a development Node runtime.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const resources = path.resolve(process.argv[2]);
const root = path.join(resources, 'app.asar');
(async () => {
  assert(fs.existsSync(path.join(resources, 'cadenza-audio.exe')), 'Missing native audio executable');
  const catalog = require(path.join(root, 'shared/online-providers.json'));
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    ['netease', 'qq', 'kugou', 'apple'],
  );
  const { loadSDK } = require(path.join(root, 'electron/online/sdk-loaders.cjs'));
  for (const [platform, method] of [
    ['netease', 'cloudsearch'],
    ['qq', 'getSearchByKey'],
    ['kugou', 'search'],
  ]) {
    const sdk = await loadSDK(platform);
    assert.equal(typeof sdk[method], 'function', `Missing packaged ${platform} SDK`);
  }
  const { CodexText } = require(path.join(root, 'electron/translation-service.cjs'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'denza-packaged-'));
  const runtime = new CodexText(profile, () => {
    throw Error('No sign-in browser should open in a packaging check');
  });
  try {
    const models = await runtime.models();
    assert(models.length > 0, 'Packaged text runtime returned no models');
    console.log(`Packaged modules and text runtime passed (${models.length} models; no account sign-in)`);
  } finally {
    runtime.close();
    // Windows may retain the child executable/profile briefly while the process exits.
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
