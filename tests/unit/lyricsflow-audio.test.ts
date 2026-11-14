import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseFile } from 'music-metadata';
const require = createRequire(import.meta.url);
const { LyricsFlowAudio } = require('../../electron/online/lyricsflow-audio.cjs');
const { httpFile, fetchAudio } = require('../../electron/online/http-files.cjs');
const { validateFormat } = require('../../electron/online/audio-validation.cjs');
const { Downloads } = require('../../electron/downloads.cjs');
const fixtures = resolve(__dirname, '../fixtures/online-audio');
describe('public audio file service', () => {
  it('maps the public routes and sends only catalog, format and storefront values', () => {
    const service = new LyricsFlowAudio();
    const song = { platform: 'apple', id: 'i.local', catalogId: '123', storefront: 'cn', cookie: 'private-token' };
    for (const [quality, format] of Object.entries({ standard: 'mp3', high: 'aac', lossless: 'flac', hires: 'alac' })) {
      const request = service.resolve(song, quality),
        url = new URL(request.url);
      expect(url.origin).toBe('https://api.trylyricsflow.com');
      expect(url.searchParams.get('song')).toBe('123');
      expect(url.pathname).toBe(['mp3', 'flac'].includes(format) ? '/download/' + format : '/download');
      expect(request.expectedFormat).toBe(format);
      expect(JSON.stringify(request)).not.toContain('private-token');
      expect(url.searchParams.has('cookie')).toBe(false);
      if (format === 'alac') {
        expect(url.searchParams.get('fallback')).toBe('false');
        expect(url.searchParams.get('codec')).toBe('alac');
      }
    }
    expect(() => service.resolve({ id: 'i.upload' }, 'high')).toThrow('catalog ID');
    expect(() => new LyricsFlowAudio('https://user:password@example.com')).toThrow();
  });
  it('validates actual codec/container rather than trusting the URL suffix or requested label', () => {
    expect(() => validateFormat('flac', 'mp3', { format: { codec: 'MPEG 1 Layer 3' } })).toThrow('different format');
    expect(() => validateFormat('alac', 'm4a', { format: { codec: 'AAC' } })).toThrow('different format');
    expect(() => validateFormat('aac', 'm4a', { format: { codec: 'AAC' } })).not.toThrow();
    expect(() => validateFormat('alac', 'm4a', { format: { codec: 'ALAC' } })).not.toThrow();
    expect(() => validateFormat('aac', 'm4a', { format: { codec: 'AAC', duration: 30 } }, 50)).toThrow('preview');
  });
  it('streams all four synthetic formats through validation, tagging and existing library import', async () => {
    const requests: { url: string; cookie?: string; authorization?: string }[] = [];
    let forceAAC = false;
    const server = createServer((req, res) => {
      requests.push({ url: req.url || '', cookie: req.headers.cookie, authorization: req.headers.authorization });
      const url = new URL(req.url || '/', 'http://localhost');
      const format = url.pathname.endsWith('/flac')
        ? 'flac'
        : url.pathname.endsWith('/mp3')
          ? 'mp3'
          : url.searchParams.get('codec');
      const file =
        forceAAC || format === 'aac' ? 'tone-aac.m4a' : format === 'alac' ? 'tone-alac.m4a' : 'tone.' + format;
      const body = readFileSync(join(fixtures, file));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
      res.end(body);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing fixture port');
    const folder = await mkdtemp(join(tmpdir(), 'denza-file-service-'));
    const store = { data: { jobs: [] as object[], folder }, save: async () => {} };
    const imported: string[] = [];
    const service = new LyricsFlowAudio(`http://127.0.0.1:${address.port}`);
    const manager = new Downloads(
      store,
      {
        resolve: (track: object, quality: string) => service.resolve(track, quality),
        lyrics: async () => {
          throw Error('Optional lyrics unavailable');
        },
      },
      {
        importDownload: async (file: string) => {
          imported.push(file);
        },
      },
      () => {},
    );
    try {
      for (const [quality, codec] of Object.entries({
        standard: 'MP3',
        high: 'AAC',
        lossless: 'FLAC',
        hires: 'ALAC',
      })) {
        const job = {
          id: 'service-' + quality,
          track: {
            platform: 'apple',
            id: 'i.' + quality,
            catalogId: '123',
            title: 'Generated tone ' + quality,
            artist: 'Test generator',
            album: 'Fixture',
            duration: 1,
          },
          quality,
          folder,
          status: 'queued',
          received: 0,
          total: 0,
          file: '',
          error: '',
        };
        store.data.jobs.push(job);
        await manager.run(job, new AbortController());
        expect(job.status, job.error).toBe('completed');
        const saved = await parseFile(job.file);
        expect(saved.common.title).toBe(job.track.title);
        expect(saved.format.duration).toBeGreaterThan(0.9);
        expect(saved.format.codec?.toUpperCase()).toContain(codec === 'MP3' ? 'MPEG' : codec);
      }
      forceAAC = true;
      const invalid = {
        id: 'wrong-format',
        track: {
          platform: 'apple',
          id: 'i.wrong',
          catalogId: '123',
          title: 'Wrong format',
          artist: 'Test generator',
          album: '',
          duration: 1,
        },
        quality: 'hires',
        folder,
        status: 'queued',
        received: 0,
        total: 0,
        file: '',
        error: '',
      };
      store.data.jobs.push(invalid);
      await manager.run(invalid, new AbortController());
      expect(invalid.status).toBe('failed');
      expect(invalid.error).toContain('different format');
      expect(imported).toHaveLength(4);
      expect(requests).toHaveLength(5);
      expect(requests.every((request) => !request.cookie && !request.authorization)).toBe(true);
    } finally {
      await manager.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(folder, { recursive: true, force: true });
    }
  });
  it('cancels while waiting for the file server, handles redirects and rejects HTML', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/wait') return;
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/file' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>Unavailable</html>');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing fixture port');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const control = new AbortController();
      const pending = httpFile(base + '/wait', { signal: control.signal });
      control.abort();
      await expect(pending).rejects.toThrow('cancelled');
      const response = await fetchAudio(base + '/redirect', { transport: 'http-file' });
      const { audioExtension } = require('../../electron/downloads.cjs');
      expect(() => audioExtension(Buffer.from('<html>Unavailable</html>'))).toThrow('audio');
      expect(await response.text()).toContain('Unavailable');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
