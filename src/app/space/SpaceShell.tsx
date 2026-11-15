// The space interface: the music library as a cathedral to walk through (docs/SPACE.md). It is the second appearance
// half of the interface: it keeps the logic half (state, actions, playback, the bridge) exactly as the classic pages do.
// The scene reads the library and the song playing through bind.ts, and plays through it; the settings page is React,
// opened by the scene (the gear, the , key, the south chapel's sculptures).
import { useEffect, useRef, useState } from 'react';
import { boot } from '../actions/boot';
import { ensureFont } from '../../engine';
import { createWorld } from './world';
import { createBind, isNight } from './bind';
import { hudHtml } from './hud';
import { SpaceSettings } from './SpaceSettings';
import { PlayerExtras, SpacePanel, WinButtons, type Panel } from './SpacePanels';
import { SpaceDetail, type Detail } from './SpaceDetail';
import { ContextMenu, Toast } from '../ui/kit';
import { menuFor } from '../commands';
import { targetOf } from './targets';
import { MiniLyrics } from '../ui/MiniLyrics';
import { lang as langStore } from '../../i18n';
import { useStore, settings, ui, openMenu, lib } from '../state';
import './space.css';
import s from './SpaceShell.module.css';
import { OnlineDialog, OnlineMusic } from '../ui/OnlineMusic';
import { Button } from '../ui/kit';
import { useOnlineSurface } from '../ui/OnlineSurface';
import { dialogs } from '../actions/dialogs';
import { DialogOwner } from '../ui/DialogOwner';
import type { PlaylistSource } from './playlistRoom';
import { tx } from '../../i18n';
import { request } from '../online/state';

// every face the scene's textures and the HUD draw with, loaded before the first texture is drawn
const FACES: [string, string][] = [
  ['serif', '聖堂中殿全部歌曲歌單設定播放中清晨的光'],
  ['notosans', '聖堂中殿全部歌曲'],
  ['sansmed', '聖堂中殿全部歌曲清晨的光落在窗邊 Morning light'],
  ['tiempos', 'The Nave Crossing'],
];

type SpaceView =
  | null
  | { kind: 'online' }
  | { kind: 'settings'; section?: string }
  | { kind: 'detail'; detail: NonNullable<Detail> }
  | { kind: 'panel'; panel: NonNullable<Panel> };
export function SpaceShell() {
  const [view, setView] = useState<SpaceView>(null);
  const onlineOpen = view?.kind === 'online';
  const cfg = view?.kind === 'settings' ? { open: true, section: view.section } : { open: false, section: undefined };
  const panel = view?.kind === 'panel' ? view.panel : null;
  const detail = view?.kind === 'detail' ? view.detail : null;
  const openView = (next: SpaceView) => {
    dialogs.dismiss('navigation');
    setView(next);
  };
  const dialogOpen = useStore(ui, (state) => !!state.dialog);
  const [room, setRoom] = useState('gallery');
  const [playlistSource, setPlaylistSource] = useState<PlaylistSource>('local');
  const surface = useOnlineSurface();
  const playlists = useStore(lib, (state) => state.playlists),
    attemptedCovers = useRef(new Set<string>());
  useEffect(() => {
    let active = true;
    const pending = playlists.filter((p) => p.remote?.artworkUrl && !p.remote.cover);
    const worker = async () => {
      while (active && pending.length) {
        const p = pending.shift()!;
        const key = p.id + '|' + p.remote!.artworkUrl;
        if (attemptedCovers.current.has(key)) continue;
        attemptedCovers.current.add(key);
        await request('playlistCover', { id: p.id }).catch(() => {});
      }
    };
    void worker();
    void worker();
    return () => {
      active = false;
    };
  }, [playlists]);
  const root = useRef<HTMLDivElement>(null),
    [ready, setReady] = useState(false),
    [gen, setGen] = useState(0),
    [extra, setExtra] = useState<HTMLElement | null>(null),
    [winHost, setWinHost] = useState<HTMLElement | null>(null);
  const world = useRef<ReturnType<typeof createWorld> | null>(null);
  const lang = useStore(langStore, (x) => x.lang),
    lite = useStore(settings, (x) => x.gfx === 'lite'),
    // (dusk or midnight: the scene is built for one of them, and built again when it changes)
    [night, setNight] = useState(() => isNight(settings.get())),
    mini = useStore(ui, (x) => !!x.win.mini),
    away = useStore(ui, (x) => !!x.win.min);
  useEffect(() => boot(() => setReady(true)), []);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)'),
      check = () => setNight(isNight(settings.get()));
    const off = settings.subscribe(check);
    mq.addEventListener('change', check);
    return () => {
      off();
      mq.removeEventListener('change', check);
    };
  }, []);
  useEffect(() => {
    if (!ready || !root.current) return;
    let gone = false;
    Promise.all(FACES.map(([k, t]) => ensureFont(k, t).catch(() => {}))).then(() => {
      if (gone) return;
      setExtra(document.getElementById('p-extra'));
      setWinHost(document.getElementById('win-btns'));
      setRoom('gallery');
      setPlaylistSource('local');
      world.current = createWorld(createBind(), {
        roomChanged: setRoom,
        playlistSourceChanged: setPlaylistSource,
        openSettings: (section) => {
          openView({ kind: 'settings', section });
        },
        show: (d) => {
          if (d) openView({ kind: 'detail', detail: d });
          else setView((v) => (v?.kind === 'detail' ? null : v));
        },
        closeSettings: () => setView((v) => (v?.kind === 'settings' ? null : v)),
        menu: (d, x, y) => {
          const t = targetOf(d);
          if (!t) return world.current?.takePointer();
          const at = { clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} };
          openMenu(at, menuFor(t));
        },
        // a lost graphics context: a fresh canvas and scene a moment later (the HUD remounts with it)
        lost: () => setTimeout(() => setGen((g) => g + 1), 600),
      });
    });
    return () => {
      gone = true;
      world.current?.dispose();
      world.current = null;
    };
  }, [ready, lang, gen, night]);
  // (a menu closed: the view held again, if it was let out for the menu)
  const menuOpen = useStore(ui, (x) => !!x.menu);
  useEffect(() => {
    if (!menuOpen) world.current?.takePointer();
  }, [menuOpen]);
  useEffect(() => {
    document.getElementById('mini')?.setAttribute('aria-pressed', String(mini));
    world.current?.pause(mini || away);
    if (onlineOpen) document.exitPointerLock();
  }, [mini, away, gen, lang, ready, onlineOpen]);
  const close = () => {
    setView(null);
    world.current?.takePointer();
  };
  return (
    <div
      className={`space-root ${s.space}${cfg.open ? ' space-cfg' : ''}${lite ? ' space-lite' : ''}${mini ? ' space-mini' : ''}`}
      data-test="space"
      inert={dialogOpen}
    >
      {/* a language change rebuilds the HUD and the scene's labels */}
      {ready && (
        <div
          key={lang + ':' + gen + ':' + night}
          ref={root}
          className={s.hud}
          dangerouslySetInnerHTML={{ __html: hudHtml() }}
        />
      )}
      {ready && cfg.open && (
        <DialogOwner>
          <SpaceSettings section={cfg.section} onClose={close} />
        </DialogOwner>
      )}
      {ready && !mini && (
        <div className={s.onlineControl + ' ' + surface.className} data-test="space-online-control">
          <Button className="card" onClick={() => openView({ kind: 'online' })}>
            {tx('on.short')}
          </Button>
        </div>
      )}
      {ready && !mini && !cfg.open && !onlineOpen && room === 'lists' && (
        <div
          className={'hud card ' + s.playlistSwitch}
          data-test="space-playlist-source"
          role="group"
          aria-label={tx('on.playlistSource')}
        >
          {(['local', 'online'] as const).map((source) => (
            <button
              type="button"
              key={source}
              aria-pressed={playlistSource === source}
              onClick={() => {
                setView((v) => (v?.kind === 'detail' ? null : v));
                world.current?.playlistSource(source);
              }}
            >
              {tx(source === 'local' ? 'on.localShort' : 'on.short')}
            </button>
          ))}
          {!playlists.some((p) => (playlistSource === 'online' ? !!p.remote : !p.remote)) &&
            playlistSource === 'online' && <small>{tx('on.noOnlineLists')}</small>}
        </div>
      )}
      {onlineOpen && (
        <OnlineDialog title={tx('on.title')} close={() => setView(null)}>
          <OnlineMusic />
        </OnlineDialog>
      )}
      {ready && (
        <PlayerExtras
          host={extra}
          panel={panel}
          setPanel={(p) => {
            openView(p ? { kind: 'panel', panel: p } : null);
          }}
        />
      )}
      {ready && detail && (
        <DialogOwner>
          <SpaceDetail
            detail={detail}
            onClose={() => {
              setView(null);
              world.current?.closed();
            }}
          />
        </DialogOwner>
      )}
      {ready && <ContextMenu />}
      {ready && <Toast />}
      {ready && <WinButtons host={winHost} />}
      {ready && mini && <MiniLyrics />}
      {ready && !cfg.open && (
        <DialogOwner>
          <SpacePanel panel={panel} onClose={() => setView(null)} />
        </DialogOwner>
      )}
    </div>
  );
}
