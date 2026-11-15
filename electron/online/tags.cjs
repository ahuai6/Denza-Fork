const taglib = require('node-taglib-sharp');
const { downloadLyricFormats } = require('../generated/lyrics.cjs');
function setTtml(file, ext, text) {
  if (['flac', 'ogg', 'opus'].includes(ext)) {
    const tag = file.getTag(taglib.TagTypes.Xiph, true);
    if (!tag?.setFieldAsStrings) return false;
    text ? tag.setFieldAsStrings('TTML', text) : tag.removeField('TTML');
  } else if (ext === 'mp3') {
    const tag = file.getTag(taglib.TagTypes.Id3v2, true);
    for (const frame of tag.getFramesByClassType(taglib.Id3v2FrameClassType.UserTextInformationFrame))
      if (frame.description?.toUpperCase() === 'TTML') tag.removeFrame(frame);
    if (text) {
      const frame = taglib.Id3v2UserTextInformationFrame.fromDescription('TTML', taglib.StringType.UTF8);
      frame.text = [text];
      tag.addFrame(frame);
    }
  } else if (ext === 'm4a') file.tag.setItunesStrings('com.apple.iTunes', 'TTML', ...(text ? [text] : []));
  else return false;
  return !!text;
}
function nativeTtml(native) {
  for (const tags of Object.values(native || {}))
    for (const tag of tags) {
      if (!/(^|[:\s])TTML$/i.test(tag.id || '')) continue;
      const value = typeof tag.value === 'string' ? tag.value : tag.value?.text || tag.value?.value;
      if (typeof value === 'string') return value;
    }
  return '';
}
function writeDownloadTags(path, ext, track, found, mode = 'both', artwork) {
  const formats = downloadLyricFormats(found?.ttml || found?.original || '', found?.translation || '');
  const fields = [],
    file = taglib.File.createFromPath(path);
  try {
    file.tag.title = track.title;
    file.tag.performers = [track.artist];
    file.tag.album = track.album;
    file.tag.lyrics = mode === 'lrc' || mode === 'both' ? formats.lrc : '';
    if (file.tag.lyrics) fields.push('lrc');
    if (setTtml(file, ext, mode === 'ttml' || mode === 'both' ? formats.ttml : '')) fields.push('ttml');
    if (artwork?.length) {
      try {
        file.tag.pictures = [taglib.Picture.fromData(taglib.ByteVector.fromByteArray(artwork))];
      } catch {
        /* Invalid artwork must not discard valid lyric fields. */
      }
    }
    file.save();
    return {
      mode,
      fields,
      converted: formats.converted,
      source: found?.source || track.platform,
      status: mode === 'none' ? 'disabled' : fields.length ? 'embedded' : 'unavailable',
    };
  } finally {
    file.dispose();
  }
}
function verifyLyrics(metadata, state) {
  if (state.fields.includes('lrc') && !metadata.common.lyrics?.length) throw Error('LRC tag verification failed');
  if (state.fields.includes('ttml') && !nativeTtml(metadata.native)) throw Error('TTML tag verification failed');
}
module.exports = { writeDownloadTags, verifyLyrics, nativeTtml };
