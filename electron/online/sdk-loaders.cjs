// Only this worker-side module imports third-party platform SDKs.
const loaders = {
  netease: () => require('@neteasecloudmusicapienhanced/api'),
  qq: () => import('@sansenjian/qq-music-api/services'),
  kugou: () => require('kugoumusicapi'),
};
module.exports = {
  loadSDK: async (platform) => {
    if (!Object.hasOwn(loaders, platform)) throw Error('Unknown SDK platform');
    return loaders[platform]();
  },
};
