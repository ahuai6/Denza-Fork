const { LyricsFlowAudio } = require('../lyricsflow-audio.cjs');
module.exports = (_host, apple, audio = new LyricsFlowAudio()) => ({
  search: (...args) => apple.search(...args),
  login: (action) => apple.login(action),
  page: (...args) => apple.page(...args),
  logout: () => apple.logout(),
  open: (song, playlistId) => apple.play(song, playlistId),
  verify: () => {
    throw Error('Use the Apple Music sign-in window');
  },
  resolve: (track, quality) => audio.resolve(track, quality),
  lyrics: (track, signal) => audio.lyrics(track, signal),
  lookup: async (input, signal) => apple.localizeSongs(await audio.lookup(input, signal), signal),
});
