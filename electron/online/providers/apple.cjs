const { LyricsFlowAudio } = require('../lyricsflow-audio.cjs');
// Metadata enrichment must not hold a valid public collection behind an unavailable catalog.
const METADATA_WAIT_MS = 15000;
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
  lookup: async (input, signal) => {
    const tracks = await audio.lookup(input, signal);
    try {
      const metadataSignal = AbortSignal.any([AbortSignal.timeout(METADATA_WAIT_MS), ...(signal ? [signal] : [])]);
      return await apple.localizeSongs(tracks, metadataSignal);
    } catch {
      signal?.throwIfAborted();
      return tracks;
    }
  },
});
