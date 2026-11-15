import { useEffect, useRef, useState } from 'react';
import { cleanBlankLyricRows, isTtml } from '../../engine';
import { tx } from '../../i18n';
import { Lib, type LyricsFound } from '../bridge';
import { SearchSongs } from './OnlineMusic';
import { Button, Note } from './kit';
import s from './OnlineMusic.module.css';

/** Both interfaces use the same complete-track picker. LRCLIB remains available as the original source. */
export function OnlineLyricsSearch({
  song,
  apply,
}: {
  song: { title: string; artist: string; album: string; duration?: number };
  apply(text: string): void | Promise<void>;
}) {
  const [source, setSource] = useState('platforms'),
    [title, setTitle] = useState(song.title),
    [artist, setArtist] = useState(song.artist);
  const [results, setResults] = useState<LyricsFound[] | null>(null),
    [picked, setPicked] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const use = async (text: string) => {
    setError('');
    setBusy(true);
    try {
      await apply(isTtml(text) ? text : cleanBlankLyricRows(text));
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <div className={s.stack} data-test="full-lyrics-search">
      <nav className={s.toolbar}>
        {['platforms', 'lrclib'].map((value) => (
          <Button key={value} aria-pressed={source === value} onClick={() => setSource(value)}>
            {value === 'lrclib' ? 'LRCLIB' : tx('on.platforms')}
          </Button>
        ))}
      </nav>
      {source === 'platforms' ? (
        <SearchSongs
          initialQuery={song.title}
          initialArtist={song.artist}
          onLyrics={(lyrics) => use(lyrics.ttml || lyrics.lrc || lyrics.original)}
        />
      ) : (
        <>
          <form
            className={s.toolbar}
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              setError('');
              void Lib?.searchLyrics({ title, artist, album: song.album, duration: song.duration })
                .then((value) => {
                  if (alive.current) {
                    setResults(value);
                    setPicked(null);
                  }
                })
                .catch(() => {
                  if (alive.current) setError(tx('s.netFail'));
                })
                .finally(() => {
                  if (alive.current) setBusy(false);
                });
            }}
          >
            <input aria-label={tx('s.col.title')} value={title} onChange={(e) => setTitle(e.target.value)} />
            <input aria-label={tx('s.artists')} value={artist} onChange={(e) => setArtist(e.target.value)} />
            <Button type="submit" disabled={busy || !title.trim() || !Lib}>
              {tx(busy ? 's.searching' : 's.searchBtn')}
            </Button>
          </form>
          {results?.length === 0 && <Note>{tx('s.empty.results')}</Note>}
          {results?.map((result) => (
            <section className={s.preview} key={result.id}>
              <Button onClick={() => setPicked(picked === result.id ? null : result.id)}>
                {result.title} · {result.artist} · {result.album}
              </Button>
              {picked === result.id && !result.instrumental && (
                <>
                  <pre>{cleanBlankLyricRows(result.synced || result.plain)}</pre>
                  <Button disabled={busy} onClick={() => void use(result.synced || result.plain)}>
                    {tx('s.lyr.use')}
                  </Button>
                </>
              )}
            </section>
          ))}
        </>
      )}
      {error && <Note>{error}</Note>}
    </div>
  );
}
