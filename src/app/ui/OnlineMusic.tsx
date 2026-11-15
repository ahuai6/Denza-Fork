import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { tx } from '../../i18n';
import { Online, type LibView } from '../bridge';
import { lib, useStore, fmtTime } from '../state';
import { playIds } from '../playback/player';
import { online, request, jobId } from '../online/state';
import { run } from '../commands';
import { openRemote } from '../actions/online';
import {
  MUSIC_PLATFORMS,
  platformInfo,
  songKey,
  type OnlineSong,
  type SearchResult,
  type MusicPlatform,
  type LoginState,
  type OnlineLyrics,
} from '../online/types';
import { translationLines, readTranslationPaste, type TranslationFragment } from '../../engine';
import { Button, Dropdown, Note, Cover } from './kit';
import '../online/words';
import s from './OnlineMusic.module.css';
import cards from './CollectionCards.module.css';
import { PlatformArtwork } from './PlatformArtwork';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const platformName = (platform: string) => MUSIC_PLATFORMS.find(([id]) => id === platform)?.[1] || platform;
export function OnlineDialog({ title, children, close }: { title: string; children: ReactNode; close(): void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const prior = document.activeElement;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (ref.current?.querySelector('[role="listbox"]')) return;
        e.stopImmediatePropagation();
        close();
      }
      if (e.key === 'Tab') {
        const items = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
          ) || []),
        ].filter((el) => el.getClientRects().length);
        const first = items[0],
          last = items.at(-1);
        if (
          !items.includes(document.activeElement as HTMLElement) ||
          (!e.shiftKey && document.activeElement === last)
        ) {
          e.preventDefault();
          first?.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      }
    };
    addEventListener('keydown', key, true);
    return () => {
      removeEventListener('keydown', key, true);
      if (prior instanceof HTMLElement) prior.focus();
    };
  }, []);
  return createPortal(
    <div
      className={s.overlay}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section className={s.dialog} ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}>
        <header className={s.header}>
          <h2>{title}</h2>
          <Button onClick={close}>{tx('on.close')}</Button>
        </header>
        {children}
      </section>
    </div>,
    document.body,
  );
}
export function QualityPicker({
  value,
  change,
  platform,
}: {
  value: string;
  change(value: string): void;
  platform?: string;
}) {
  const labels = platform && platform !== 'all' ? platformInfo(platform).qualityLabels : undefined;
  return (
    <Dropdown
      className={s.compact}
      label={tx('on.quality')}
      value={value}
      onChange={change}
      options={(['standard', 'high', 'lossless', 'hires'] as const).map((k) => [k, tx(labels?.[k] || 'on.' + k)])}
    />
  );
}
function useQuality(platform: string) {
  const quality = useStore(online, (v) => v.preferences?.qualities[platform] || 'high');
  return [
    quality,
    (value: string) => {
      online.set({
        ...online.get(),
        preferences: {
          lyricsMode: 'both',
          ...online.get().preferences,
          qualities: { ...online.get().preferences?.qualities, [platform]: value },
        },
      });
      void request('preferences', { platform, quality: value }).catch(() => {});
    },
  ] as const;
}
function LyricFields() {
  const mode = useStore(online, (v) => v.preferences?.lyricsMode || 'both');
  return (
    <Dropdown
      className={s.compact}
      label={tx('on.lyricFields')}
      value={mode}
      onChange={(lyricsMode) => {
        online.set({ ...online.get(), preferences: { qualities: {}, ...online.get().preferences, lyricsMode } });
        void request('preferences', { lyricsMode }).catch(() => {});
      }}
      options={['both', 'lrc', 'ttml', 'none'].map((key) => [key, tx('on.fields.' + key)])}
    />
  );
}
export function SearchSongs({
  onReferences,
  onQueued,
  onLyrics,
  initialQuery = '',
}: {
  onReferences?: (fragments: TranslationFragment[]) => void;
  onQueued?(): void;
  onLyrics?(lyrics: OnlineLyrics): void | Promise<void>;
  initialQuery?: string;
}) {
  const [platform, setPlatform] = useState('all'),
    [query, setQuery] = useState(initialQuery),
    [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [page, setPage] = useState(1);
  const [quality, setQuality] = useQuality(platform);
  const [link, setLink] = useState('');
  const [selected, setSelected] = useState<string[]>([]),
    [preview, setPreview] = useState<(OnlineLyrics & { song: OnlineSong }) | null>(null);
  const task = useRef(''),
    mounted = useRef(true),
    scope = useRef(0);
  const folder = useStore(online, (v) => v.folder);
  const lyricOnly = !!onReferences || !!onLyrics;
  useEffect(
    () => () => {
      mounted.current = false;
      if (task.current) void request('cancel', { jobId: task.current });
    },
    [],
  );
  const act = async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      if (mounted.current) setError(message(e));
    }
  };
  const find = (next: number) =>
    act(async () => {
      if (task.current) await request('cancel', { jobId: task.current });
      const id = jobId(),
        current = ++scope.current;
      task.current = id;
      setBusy(true);
      try {
        const value = await request<SearchResult>('search', { platform, query, page: next, jobId: id });
        if (!mounted.current || current !== scope.current) return;
        setResult(value);
        setPage(next);
        setSelected([]);
        setPreview(null);
      } finally {
        if (mounted.current && current === scope.current) {
          setBusy(false);
          task.current = '';
        }
      }
    });
  const download = (keys: string[]) =>
    act(async () => {
      if (!folder && !(await request<string>('folder'))) return;
      await request('enqueue', { keys, quality });
      onQueued?.();
    });
  const lyrics = (song: OnlineSong) =>
    act(async () => {
      const id = jobId();
      task.current = id;
      setBusy(true);
      try {
        const value = await request<OnlineLyrics>('lyrics', {
          key: songKey(song),
          jobId: id,
        });
        if (mounted.current) setPreview({ song, ...value });
      } finally {
        if (mounted.current) {
          setBusy(false);
          task.current = '';
        }
      }
    });
  const remoteHelp = result?.tracks
    .map((song) => platformInfo(song.platform))
    .find((info) => info.remotePlayback)?.playbackHelp;
  return (
    <div className={s.stack} data-test="online-search">
      <form
        className={s.toolbar}
        onSubmit={(e) => {
          e.preventDefault();
          void find(1);
        }}
      >
        <Dropdown
          label={tx('on.all')}
          className={s.compact}
          value={platform}
          onChange={setPlatform}
          options={[['all', tx('on.all')], ...MUSIC_PLATFORMS]}
        />
        <input aria-label={tx('on.search')} value={query} maxLength={200} onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" disabled={busy || !query.trim()}>
          {tx(busy ? 'on.wait' : 'on.search')}
        </Button>
      </form>
      {!lyricOnly && (
        <div className={s.toolbar}>
          {(platform === 'all' || platformInfo(platform).download) && (
            <>
              <QualityPicker value={quality} change={setQuality} platform={platform} />
              <LyricFields />
              <Button disabled={!selected.length} onClick={() => void download(selected)}>
                {tx('on.selected')} ({selected.length})
              </Button>
            </>
          )}
        </div>
      )}
      {!lyricOnly && (
        <form
          className={s.toolbar}
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const id = jobId();
              task.current = id;
              setBusy(true);
              try {
                const tracks = await request<OnlineSong[]>('lookup', { input: link, jobId: id });
                if (mounted.current) {
                  setResult({ tracks, errors: [] });
                  setSelected([]);
                  setPlatform('apple');
                  setPreview(null);
                }
              } finally {
                if (mounted.current) {
                  setBusy(false);
                  task.current = '';
                }
              }
            });
          }}
        >
          <input
            aria-label={tx('on.appleLink')}
            placeholder={tx('on.appleLink')}
            value={link}
            maxLength={2048}
            onChange={(event) => setLink(event.target.value)}
          />
          <Button type="submit" disabled={busy || !link.trim()}>
            {tx('on.readLink')}
          </Button>
        </form>
      )}
      {!lyricOnly && remoteHelp && <Note>{tx(remoteHelp)}</Note>}
      {error && <Note>{error}</Note>}
      {result?.errors.map((e) => (
        <Note key={e.platform}>
          {platformName(e.platform)}: {e.message}
        </Note>
      ))}
      {result && !result.tracks.length && <Note>{tx('on.empty')}</Note>}
      <div className={s.rows}>
        {result?.tracks.map((song) => (
          <div className={s.row} key={songKey(song)}>
            {!lyricOnly && (
              <input
                type="checkbox"
                disabled={!platformInfo(song.platform).download}
                aria-label={song.title}
                checked={selected.includes(songKey(song))}
                onChange={(e) =>
                  setSelected((v) => (e.target.checked ? [...v, songKey(song)] : v.filter((k) => k !== songKey(song))))
                }
              />
            )}
            <Cover src={song.artworkUrl} className={s.songCover} />
            <div className={s.info}>
              <b>{song.title}</b>
              <small>
                {song.artist} · {song.album} · {platformName(song.platform)} · {fmtTime(song.duration)}
              </small>
            </div>
            <Button size="sm" disabled={busy || !platformInfo(song.platform).lyrics} onClick={() => void lyrics(song)}>
              {tx('on.lyrics')}
            </Button>
            {!lyricOnly && platformInfo(song.platform).remotePlayback && (
              <Button
                size="sm"
                onClick={() =>
                  void act(async () => {
                    await openRemote({ key: songKey(song) });
                  })
                }
              >
                {tx('on.playBrowser')}
              </Button>
            )}
            {!lyricOnly && platformInfo(song.platform).download && (
              <Button size="sm" onClick={() => void download([songKey(song)])}>
                {tx('on.download')}
              </Button>
            )}
          </div>
        ))}
      </div>
      {result && result.tracks.length >= 30 && (
        <Button disabled={busy} onClick={() => void find(page + 1)}>
          {tx('on.next')}
        </Button>
      )}
      {preview && (
        <section className={s.preview} data-test="online-lyrics-preview">
          <h3>{preview.song.title}</h3>
          <pre>{onLyrics ? preview.lrc || preview.original : preview.translation || preview.original}</pre>
          {onLyrics && (
            <>
              <Note>{tx('on.fullTracksHelp')}</Note>
              <Button
                kind="primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setBusy(true);
                    try {
                      await onLyrics(preview);
                    } finally {
                      if (mounted.current) setBusy(false);
                    }
                  })
                }
              >
                {tx('on.useFullLyrics')}
              </Button>
            </>
          )}
          {!preview.translation && <Note>{tx('on.noTranslation')}</Note>}
          {onReferences && (
            <Button
              disabled={!preview.translation}
              onClick={() => {
                const originals = translationLines(preview.original);
                const fragments = readTranslationPaste(preview.translation).map((f) => ({
                  ...f,
                  source: originals.find((l) => f.t !== null && Math.abs(l.t - f.t) < 0.025)?.text,
                }));
                onReferences(fragments);
                setPreview(null);
              }}
            >
              {tx('on.append')}
            </Button>
          )}
        </section>
      )}
    </div>
  );
}
export function SyncedPlaylists({ playlistId, embedded = false }: { playlistId?: string; embedded?: boolean } = {}) {
  const playlists = useStore(lib, (v) => v.playlists).filter((p) => p.remote),
    [picked, setPicked] = useState(''),
    [platform, setPlatform] = useState<MusicPlatform | ''>(''),
    [error, setError] = useState('');
  const selected = playlists.find((p) => p.id === (playlistId || picked));
  const [quality, setQuality] = useQuality(selected?.remote?.platform || platform || 'all');
  const remote = selected?.remote;
  const accounts = useStore(online, (v) => v.accounts),
    [busy, setBusy] = useState(false),
    task = useRef('');
  useEffect(
    () => () => {
      if (task.current) void request('cancel', { jobId: task.current });
    },
    [],
  );
  const sync = async (platform: MusicPlatform) => {
    setBusy(true);
    setError('');
    const id = jobId();
    task.current = id;
    try {
      lib.set(await request<LibView>('sync', { platform, jobId: id }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      task.current = '';
    }
  };
  const download = async (songs: OnlineSong[]) => {
    setError('');
    try {
      if (!online.get().folder && !(await request<string>('folder'))) return;
      await request('enqueue', { keys: songs.map(songKey), quality });
    } catch (e) {
      setError(message(e));
    }
  };
  const open = async (args: { key?: string; playlistId?: string }) => {
    setError('');
    try {
      await openRemote(args);
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <div className={s.stack} data-test="synced-playlists">
      <Note>{tx(remote ? platformInfo(remote.platform).syncHelp : 'on.syncHelp')}</Note>
      <div className={s.toolbar}>
        {platform && !embedded && (
          <Button
            onClick={() => {
              setPicked('');
              setPlatform('');
            }}
          >
            {tx('on.platforms')}
          </Button>
        )}
        {selected && !embedded && <Button onClick={() => setPicked('')}>{tx('on.synced')}</Button>}
        {(remote?.platform || platform) &&
          accounts
            .filter((a) => a.platform === (remote?.platform || platform))
            .map((a) => (
              <Button key={a.platform} disabled={busy} onClick={() => void sync(a.platform)}>
                {tx(busy ? 'on.wait' : 'on.sync')} · {a.name}
              </Button>
            ))}
        {busy && <Button onClick={() => void request('cancel', { jobId: task.current })}>{tx('on.cancel')}</Button>}
      </div>
      {!platform && !playlistId && (
        <div className={cards.cards}>
          {MUSIC_PLATFORMS.map(([id, label]) => (
            <div className={cards.cardWrap} key={id}>
              <button
                className={cards.card}
                onClick={() => {
                  setPlatform(id);
                  setPicked('');
                }}
              >
                <PlatformArtwork platform={id} />
                <b>{label}</b>
                <small>{accounts.find((a) => a.platform === id)?.name || tx('on.signin')}</small>
              </button>
            </div>
          ))}
        </div>
      )}
      {platform && !selected && !playlistId && (
        <div className={cards.cards}>
          {playlists
            .filter(
              (p) =>
                p.remote?.platform === platform &&
                (!accounts.find((a) => a.platform === platform) ||
                  p.remote.uid === accounts.find((a) => a.platform === platform)?.uid),
            )
            .map((p) => (
              <div className={cards.cardWrap} key={p.id}>
                <button className={cards.card} onClick={() => setPicked(p.id)}>
                  <Cover k={p.remote?.cover} src={p.remote?.cover ? undefined : p.remote?.artworkUrl} />
                  <b>{p.name}</b>
                  <small>
                    {p.remote?.songs.length} · {platformName(platform)}
                  </small>
                </button>
              </div>
            ))}
        </div>
      )}
      {error && <Note>{error}</Note>}
      {!playlists.length && <Note>{tx('on.empty')}</Note>}
      {selected && remote && (
        <>
          {!embedded && (
            <div className={s.playlistHead}>
              <Cover k={remote.cover} src={remote.cover ? undefined : remote.artworkUrl} />
              <h2>{selected.name}</h2>
            </div>
          )}
          <div className={s.toolbar}>
            {platformInfo(remote.platform).download && (
              <>
                <QualityPicker value={quality} change={setQuality} platform={remote.platform} />
                <LyricFields />
              </>
            )}
            <Button disabled={!selected.tracks.length} onClick={() => void playIds(selected.tracks, 0)}>
              {tx('on.playLocal')}
            </Button>
            <Button
              disabled={!selected.tracks.length}
              onClick={() => run('tracks.enqueue', { kind: 'tracks', ids: selected.tracks })}
            >
              {tx('s.queue.add')}
            </Button>
            {platformInfo(remote.platform).remotePlayback && (
              <>
                <Button onClick={() => void open({ playlistId: selected.id })}>{tx('on.playBrowser')}</Button>
                {platformInfo(remote.platform).offlineLabel && (
                  <Button onClick={() => setError(tx(platformInfo(remote.platform).playbackHelp!))}>
                    {tx(platformInfo(remote.platform).offlineLabel!)}
                  </Button>
                )}
              </>
            )}
            {platformInfo(remote.platform).download && (
              <Button
                disabled={!remote.songs.some((song) => !song.localId)}
                onClick={() => void download(remote.songs.filter((song) => !song.localId).slice(0, 100))}
              >
                {tx('on.download')} (≤100)
              </Button>
            )}
          </div>
          {platformInfo(remote.platform).playbackHelp && <Note>{tx(platformInfo(remote.platform).playbackHelp!)}</Note>}
          <small>
            {new Date(remote.updated).toLocaleString()} · {selected.tracks.length}/{remote.songs.length}
          </small>
          <div className={s.rows}>
            {remote.songs.map((song, i) => (
              <div className={s.row} key={`${song.id}:${i}`}>
                <span>{i + 1}</span>
                <Cover src={song.artworkUrl} className={s.songCover} />
                <div className={s.info}>
                  <b>{song.title}</b>
                  <small>
                    {song.artist} · {song.album} · {fmtTime(song.duration)} ·{' '}
                    {tx(
                      song.localId
                        ? 'on.localSong'
                        : platformInfo(song.platform).remotePlayback
                          ? 'on.remoteSong'
                          : 'on.notDownloaded',
                    )}
                  </small>
                </div>
                {song.localId ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      void playIds(
                        selected.tracks,
                        remote.songs.slice(0, i + 1).filter((value) => value.localId).length - 1,
                      )
                    }
                  >
                    {tx('s.play')}
                  </Button>
                ) : (
                  <>
                    {platformInfo(song.platform).remotePlayback && (
                      <Button size="sm" onClick={() => void open({ key: songKey(song) })}>
                        {tx('on.playBrowser')}
                      </Button>
                    )}
                    {platformInfo(song.platform).download && (
                      <Button size="sm" onClick={() => void download([song])}>
                        {tx('on.download')}
                      </Button>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
function Accounts() {
  const accounts = useStore(online, (v) => v.accounts);
  const [platform, setPlatform] = useState<MusicPlatform>('netease'),
    [login, setLogin] = useState<LoginState | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [cookie, setCookie] = useState(''),
    [uid, setUid] = useState('');
  const current = useRef<{ platform: MusicPlatform; id: string } | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      if (current.current)
        void request('login', { platform: current.current.platform, action: 'cancel', sessionId: current.current.id });
    },
    [],
  );
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className={s.stack} data-test="online-accounts">
      <Dropdown
        label={tx('on.accounts')}
        value={platform}
        onChange={(v) => {
          if (busy) return;
          if (current.current)
            void request('login', {
              platform: current.current.platform,
              action: 'cancel',
              sessionId: current.current.id,
            });
          current.current = null;
          setPlatform(v as MusicPlatform);
          setLogin(null);
          setCookie('');
        }}
        options={MUSIC_PLATFORMS}
      />
      <Note>{tx(platformInfo(platform).accountHelp)}</Note>
      <div className={s.toolbar}>
        <Button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              if (current.current)
                await request('login', { platform, action: 'cancel', sessionId: current.current.id });
              const value = await request<LoginState>('login', { platform, action: 'create' });
              if (!mounted.current) {
                if (value.sessionId) await request('login', { platform, action: 'cancel', sessionId: value.sessionId });
                return;
              }
              setLogin(value);
              current.current = value.sessionId ? { platform, id: value.sessionId } : null;
            })
          }
        >
          {tx(platformInfo(platform).loginLabel)}
        </Button>
        {login?.sessionId && (
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const value = await request<LoginState>('login', {
                  platform,
                  action: 'poll',
                  sessionId: login.sessionId,
                });
                if (value.done) {
                  setLogin(null);
                  current.current = null;
                }
              })
            }
          >
            {tx('on.check')}
          </Button>
        )}
      </div>
      {login?.image && <img className={s.qr} src={login.image} alt={tx('on.signin')} />}
      {platformInfo(platform).credentialImport && (
        <details>
          <summary>{tx('on.importAccount')}</summary>
          <div className={s.stack}>
            <label>
              {tx('on.uid')}
              <input value={uid} onChange={(e) => setUid(e.target.value)} />
            </label>
            <label>
              {tx('on.cookie')}
              <input type="password" autoComplete="off" value={cookie} onChange={(e) => setCookie(e.target.value)} />
            </label>
            <Button
              disabled={busy || !cookie.trim()}
              onClick={() =>
                void act(async () => {
                  await request('account', { platform, cookie, uid });
                  setCookie('');
                })
              }
            >
              {tx('on.importAccount')}
            </Button>
          </div>
        </details>
      )}
      {error && <Note>{error}</Note>}
      {accounts.map((a) => (
        <div className={s.row} key={a.platform}>
          <div className={s.info}>
            <b>{a.name}</b>
            <small>
              {platformName(a.platform)} · {a.uid}
            </small>
          </div>
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await request('logout', { platform: a.platform });
              })
            }
          >
            {tx('on.logout')}
          </Button>
        </div>
      ))}
    </div>
  );
}
export function DownloadList() {
  const state = useStore(online),
    [error, setError] = useState('');
  const act = async (operation: string, args?: object) => {
    setError('');
    try {
      await request(operation, args);
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <div className={s.stack} data-test="online-downloads">
      <Button onClick={() => void act('folder')}>{tx('on.folder')}</Button>
      <small>{state.folder}</small>
      <LyricFields />
      <Note>{tx('on.nativeTtmlOnly')}</Note>
      {!state.jobs.length && <Note>{tx('on.empty')}</Note>}
      {error && <Note>{error}</Note>}
      {state.jobs.map((j) => (
        <div className={s.row} key={j.id}>
          <Cover src={j.track.artworkUrl} className={s.songCover} />
          <div className={s.info}>
            <b>{j.track.title}</b>
            <small>
              {tx('on.status.' + j.status)} · {j.total ? Math.round((j.received / j.total) * 100) + '%' : ''}
            </small>
            <progress
              aria-label={j.track.title}
              max={j.total || undefined}
              value={j.total ? Math.min(j.received, j.total) : j.status === 'completed' ? 1 : undefined}
            />
            <small>
              {(j.received / 1048576).toFixed(1)} / {j.total ? (j.total / 1048576).toFixed(1) : '…'} MB ·{' '}
              {tx(platformInfo(j.track.platform).qualityLabels?.[j.quality as 'high'] || 'on.' + j.quality)}
              {j.resolvedQuality && j.resolvedQuality !== j.quality
                ? ' → ' +
                  tx(
                    platformInfo(j.track.platform).qualityLabels?.[j.resolvedQuality as 'high'] ||
                      'on.' + j.resolvedQuality,
                  )
                : ''}{' '}
              · {j.source}
            </small>
            {j.fallbackReason && <small>{tx('on.qualityFallback')}</small>}
            {j.lyrics && (
              <small>
                {tx('on.lyricFields')}:{' '}
                {j.lyrics.fields.join(' + ').toUpperCase() ||
                  tx('on.fields.' + (j.lyrics.status === 'disabled' ? 'none' : 'unavailable'))}
                {j.lyrics.converted && j.lyrics.fields.includes('ttml') ? ' · ' + tx('on.convertedTtml') : ''}
              </small>
            )}
            {j.metadataWarning && <small role="status">{j.metadataWarning}</small>}
            {j.info && (
              <small>
                {j.info.codec} · {j.info.bits} bit · {j.info.sampleRate / 1000} kHz ·{' '}
                {Math.round(j.info.bitrate / 1000)} kbps
              </small>
            )}
            {j.error && <small role="status">{j.error}</small>}
          </div>
          {['queued', 'resolving', 'downloading'].includes(j.status) && (
            <Button size="sm" onClick={() => void act('downloadAction', { id: j.id, action: 'pause' })}>
              {tx('on.pause')}
            </Button>
          )}
          {['paused', 'failed', 'cancelled'].includes(j.status) && (
            <Button size="sm" onClick={() => void act('downloadAction', { id: j.id, action: 'retry' })}>
              {tx('on.retry')}
            </Button>
          )}
          {j.status !== 'saving' && j.status !== 'completed' && j.status !== 'cancelled' && (
            <Button size="sm" onClick={() => void act('downloadAction', { id: j.id, action: 'cancel' })}>
              {tx('on.cancel')}
            </Button>
          )}
          {['completed', 'failed', 'cancelled', 'paused'].includes(j.status) && (
            <Button size="sm" onClick={() => void act('downloadAction', { id: j.id, action: 'remove' })}>
              {tx('on.remove')}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
export function OnlineMusic() {
  const [tab, setTab] = useState('search');
  if (!Online) return <Note>{tx('on.empty')}</Note>;
  return (
    <div className={s.stack} data-test="online-music">
      <nav className={s.toolbar} aria-label={tx('on.title')}>
        {['search', 'synced', 'downloads', 'accounts'].map((k) => (
          <Button key={k} kind={tab === k ? 'primary' : 'quiet'} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {tx('on.' + k)}
          </Button>
        ))}
      </nav>
      {tab === 'search' && <SearchSongs onQueued={() => setTab('downloads')} />}
      {tab === 'synced' && <SyncedPlaylists />}
      {tab === 'downloads' && <DownloadList />}
      {tab === 'accounts' && <Accounts />}
    </div>
  );
}
