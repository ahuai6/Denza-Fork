const catalog = require('../../../shared/online-providers.json');
const factories = {
  netease: require('./netease.cjs'),
  qq: require('./qq.cjs'),
  kugou: require('./kugou.cjs'),
  apple: require('./apple.cjs'),
};
function createProviders(host, apple, services = {}) {
  return new Map(
    catalog.map((info) => [info.id, { ...factories[info.id](host(info.id), apple, services.audio), info }]),
  );
}
module.exports = { createProviders, catalog };
