module.exports = (_host, apple) => ({
  search: (...args) => apple.search(...args),
  login: (action) => apple.login(action),
  page: (...args) => apple.page(...args),
  logout: () => apple.logout(),
  open: (song, playlistId) => apple.play(song, playlistId),
  verify: () => {
    throw Error('Use the Apple Music sign-in window');
  },
  resolve: () => {
    throw Error('Apple Music offline downloads are managed by the official Apple Music app');
  },
  lyrics: () => {
    throw Error('Apple Music lyrics are available in the official player');
  },
});
