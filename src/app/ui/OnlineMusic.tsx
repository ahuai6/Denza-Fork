import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { tx } from '../../i18n';
import { Online, type LibView } from '../bridge';
import { lib, useStore, fmtTime } from '../state';
import { playIds } from '../playback/player';
import { online, request, jobId, openApple } from '../online/state';
import {
  MUSIC_PLATFORMS,
  songKey,
  type OnlineSong,
  type SearchResult,
  type MusicPlatform,
  type LoginState,
} from '../online/types';
import { translationLines, readTranslationPaste, type TranslationFragment } from '../../engine';
import { Button, Dropdown, Note } from './kit';
import '../online/words';
import s from './OnlineMusic.module.css';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const platformName = (platform: string) => MUSIC_PLATFORMS.find(([id]) => id === platform)?.[1] || platform;
export function OnlineDialog({ title, children, close }: { title: string; children: ReactNode; close(): void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const prior = document.activeElement;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
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
export function QualityPicker({ value, change }: { value: string; change(value: string): void }) {
  return (
    <Dropdown
      className={s.compact}
      label={tx('on.quality')}
      value={value}
      onChange={change}
      options={['standard', 'high', 'lossless', 'hires'].map((k) => [k, tx('on.' + k)])}
    />
  );
}
export function SearchSongs({ onReferences }: { onReferences?: (fragments: TranslationFragment[]) => void }) {
  const [platform, setPlatform] = useState('all'),
    [query, setQuery] = useState(''),
    [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [page, setPage] = useState(1),
    [quality, setQuality] = useState('high');
  const [selected, setSelected] = useState<string[]>([]),
    [preview, setPreview] = useState<{ song: OnlineSong; original: string; translation: string } | null>(null);
  const task = useRef(''),
    mounted = useRef(true),
    scope = useRef(0);
  const folder = useStore(online, (v) => v.folder);
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
    });
  const lyrics = (song: OnlineSong) =>
    act(async () => {
      const id = jobId();
      task.current = id;
      setBusy(true);
      try {
        const value = await request<{ original: string; translation: string }>('lyrics', {
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
      {!onReferences && (
        <div className={s.toolbar}>
          {platform !== 'apple' && (
            <>
              <QualityPicker value={quality} change={setQuality} />
              <Button disabled={!selected.length} onClick={() => void download(selected)}>
                {tx('on.selected')} ({selected.length})
              </Button>
            </>
          )}
        </div>
      )}
      {!onReferences && result?.tracks.some((song) => song.platform === 'apple') && (
        <Note>{tx('on.applePlaybackHelp')}</Note>
      )}
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
            {!onReferences && (
              <input
                type="checkbox"
                disabled={song.platform === 'apple'}
                aria-label={song.title}
                checked={selected.includes(songKey(song))}
                onChange={(e) =>
                  setSelected((v) => (e.target.checked ? [...v, songKey(song)] : v.filter((k) => k !== songKey(song))))
                }
              />
            )}
            <div className={s.info}>
              <b>{song.title}</b>
              <small>
                {song.artist} · {song.album} · {platformName(song.platform)} · {fmtTime(song.duration)}
              </small>
            </div>
            <Button size="sm" disabled={busy || song.platform === 'apple'} onClick={() => void lyrics(song)}>
              {tx('on.lyrics')}
            </Button>
            {!onReferences && song.platform === 'apple' ? (
              <Button
                size="sm"
                onClick={() =>
                  void act(async () => {
                    await openApple({ key: songKey(song) });
                  })
                }
              >
                {tx('on.applePlay')}
              </Button>
            ) : (
              !onReferences && (
                <Button size="sm" onClick={() => void download([songKey(song)])}>
                  {tx('on.download')}
                </Button>
              )
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
          <pre>{preview.translation || preview.original}</pre>
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
export function SyncedPlaylists() {
  const playlists = useStore(lib, (v) => v.playlists).filter((p) => p.remote),
    [picked, setPicked] = useState(''),
    [quality, setQuality] = useState('high'),
    [error, setError] = useState('');
  const selected = playlists.find((p) => p.id === picked) || playlists[0];
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
      await openApple(args);
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <div className={s.stack} data-test="synced-playlists">
      <Note>{tx(remote?.platform === 'apple' ? 'on.appleSyncHelp' : 'on.syncHelp')}</Note>
      <div className={s.toolbar}>
        {accounts.map((a) => (
          <Button key={a.platform} disabled={busy} onClick={() => void sync(a.platform)}>
            {tx(busy ? 'on.wait' : 'on.sync')} · {a.name}
          </Button>
        ))}
        {busy && <Button onClick={() => void request('cancel', { jobId: task.current })}>{tx('on.cancel')}</Button>}
      </div>
      {error && <Note>{error}</Note>}
      {!playlists.length && <Note>{tx('on.empty')}</Note>}
      {selected && remote && (
        <>
          <Dropdown
            label={tx('on.synced')}
            value={selected.id}
            onChange={setPicked}
            options={playlists.map((p) => [p.id, `${p.name} · ${platformName(p.remote!.platform)}`])}
          />
          <div className={s.toolbar}>
            {remote.platform !== 'apple' && <QualityPicker value={quality} change={setQuality} />}
            <Button disabled={!selected.tracks.length} onClick={() => void playIds(selected.tracks, 0)}>
              {tx('on.playLocal')}
            </Button>
            {remote.platform === 'apple' ? (
              <>
                <Button onClick={() => void open({ playlistId: selected.id })}>{tx('on.applePlay')}</Button>
                <Button onClick={() => setError(tx('on.applePlaybackHelp'))}>{tx('on.appleOffline')}</Button>
              </>
            ) : (
              <Button
                disabled={!remote.songs.some((song) => !song.localId)}
                onClick={() => void download(remote.songs.filter((song) => !song.localId).slice(0, 100))}
              >
                {tx('on.download')} (≤100)
              </Button>
            )}
          </div>
          <small>
            {new Date(remote.updated).toLocaleString()} · {selected.tracks.length}/{remote.songs.length}
          </small>
          <div className={s.rows}>
            {remote.songs.map((song, i) => (
              <div className={s.row} key={`${song.id}:${i}`}>
                <span>{i + 1}</span>
                <div className={s.info}>
                  <b>{song.title}</b>
                  <small>
                    {song.artist} ·{' '}
                    {tx(
                      song.localId ? 'on.localSong' : song.platform === 'apple' ? 'on.remoteSong' : 'on.notDownloaded',
                    )}
                  </small>
                </div>
                {song.localId ? (
                  <Button
                    size="sm"
                    onClick={() => void playIds(selected.tracks, selected.tracks.indexOf(song.localId!))}
                  >
                    {tx('s.play')}
                  </Button>
                ) : song.platform === 'apple' ? (
                  <Button size="sm" onClick={() => void open({ key: songKey(song) })}>
                    {tx('on.applePlay')}
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => void download([song])}>
                    {tx('on.download')}
                  </Button>
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
      <Note>{tx(platform === 'apple' ? 'on.appleHelp' : 'on.accountHelp')}</Note>
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
          {tx(platform === 'apple' ? 'on.appleSignin' : 'on.signin')}
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
      {platform !== 'apple' && (
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
function DownloadList() {
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
      {error && <Note>{error}</Note>}
      {state.jobs.map((j) => (
        <div className={s.row} key={j.id}>
          <div className={s.info}>
            <b>{j.track.title}</b>
            <small>
              {tx('on.status.' + j.status)} · {j.total ? Math.round((j.received / j.total) * 100) + '%' : ''}
            </small>
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
      {tab === 'search' && <SearchSongs />}
      {tab === 'synced' && <SyncedPlaylists />}
      {tab === 'downloads' && <DownloadList />}
      {tab === 'accounts' && <Accounts />}
    </div>
  );
}
