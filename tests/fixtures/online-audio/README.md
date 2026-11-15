# Generated audio fixtures

These four files contain only a one-second 523 Hz sine wave generated with FFmpeg, not a commercial recording. They exercise MP3, AAC/M4A, FLAC and ALAC/M4A validation and tagging without calling an external audio service.

```sh
ffmpeg -f lavfi -i 'sine=frequency=523:sample_rate=44100:duration=1' -c:a libmp3lame -b:a 32k tone.mp3
ffmpeg -f lavfi -i 'sine=frequency=523:sample_rate=44100:duration=1' -c:a aac -b:a 32k tone-aac.m4a
ffmpeg -f lavfi -i 'sine=frequency=523:sample_rate=44100:duration=1' -c:a flac tone.flac
ffmpeg -f lavfi -i 'sine=frequency=523:sample_rate=44100:duration=1' -c:a alac tone-alac.m4a
```
