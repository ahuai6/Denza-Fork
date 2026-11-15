import catalog from '../../../shared/online-providers.json';
export type MusicPlatform = 'netease' | 'qq' | 'kugou' | 'apple';
export interface OnlineSong {
  platform: MusicPlatform;
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  artworkUrl?: string;
  albumId?: string;
  albumAudioId?: string;
  mediaId?: string;
  localId?: string | null;
  catalogId?: string;
  storefront?: string;
}
export interface RemotePlaylist {
  platform: MusicPlatform;
  uid: string;
  id: string;
  artworkUrl?: string;
  updated: number;
  songs: OnlineSong[];
}
export interface MusicAccount {
  platform: MusicPlatform;
  uid: string;
  name: string;
}
export interface DownloadJob {
  id: string;
  track: OnlineSong;
  quality: string;
  status: 'queued' | 'resolving' | 'downloading' | 'saving' | 'completed' | 'paused' | 'cancelled' | 'failed';
  received: number;
  total: number;
  info?: { codec: string; sampleRate: number; bits: number; bitrate: number };
  resolvedQuality?: string;
  fallbackReason?: string;
  source?: string;
  metadataWarning?: string;
  lyrics?: { mode: string; fields: string[]; status: string; converted?: boolean };
  error?: string;
}
export interface OnlineState {
  accounts: MusicAccount[];
  jobs: DownloadJob[];
  folder: string;
  preferences?: { qualities: Record<string, string>; lyricsMode: string };
}
export interface OnlineApi {
  request(operation: string, args?: object): Promise<unknown>;
  onChanged(listener: (state: OnlineState) => void): () => void;
}
export interface TranslationProvider {
  kind: 'openai' | 'compatible' | 'deepseek' | 'codex';
  baseURL: string;
  protocol: 'chat' | 'responses';
  model: string;
  hasKey: boolean;
}
export interface LoginState {
  done: boolean;
  sessionId?: string;
  image?: string;
}
export interface SearchResult {
  tracks: OnlineSong[];
  errors: { platform: string; message: string }[];
}
export const MUSIC_PLATFORMS: [MusicPlatform, string][] = catalog.map((info) => [info.id as MusicPlatform, info.label]);
export interface PlatformInfo {
  id: string;
  label: string;
  login: string;
  download: boolean;
  lyrics: boolean;
  remotePlayback: boolean;
  credentialImport: boolean;
  loginLabel: string;
  accountHelp: string;
  syncHelp: string;
  playbackHelp?: string;
  offlineLabel?: string;
  qualityLabels?: Partial<Record<'standard' | 'high' | 'lossless' | 'hires', string>>;
}
export function platformInfo(platform: string): PlatformInfo {
  const info = catalog.find((value) => value.id === platform);
  if (!info) throw new Error('Unknown music platform');
  return info;
}
export const songKey = (song: OnlineSong) => `${song.platform}:${song.id}`;
