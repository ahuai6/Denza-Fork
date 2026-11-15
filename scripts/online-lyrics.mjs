// Reuse Cadenza's pure lyric parser in the main process; no second TTML parser or renderer is shipped.
import { build } from 'vite';
await build({
  configFile: false,
  logLevel: 'error',
  build: {
    target: 'node22',
    lib: { entry: 'src/lyrics/download.ts', formats: ['cjs'], fileName: () => 'lyrics.cjs' },
    outDir: 'electron/generated',
    emptyOutDir: false,
    minify: false,
  },
});
