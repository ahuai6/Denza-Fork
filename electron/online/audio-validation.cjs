function validateFormat(expected, ext, metadata, duration = 0) {
  if (!expected) return;
  const codec = metadata.format.codec || '';
  const valid =
    expected === 'mp3'
      ? ext === 'mp3' && /MPEG.*Layer\s*3|MP3/i.test(codec)
      : expected === 'flac'
        ? ext === 'flac' && /FLAC/i.test(codec)
        : expected === 'aac'
          ? ['aac', 'm4a'].includes(ext) && /AAC/i.test(codec)
          : expected === 'alac'
            ? ext === 'm4a' && /ALAC|Apple Lossless/i.test(codec)
            : false;
  if (!valid) throw Error('Audio service returned a different format than requested');
  const tolerance = Math.min(5, Math.max(1, duration * 0.02));
  if (duration > 0 && metadata.format.duration + tolerance < duration)
    throw Error('Audio service returned an incomplete song or preview');
}
module.exports = { validateFormat };
