export type MusicPlatform = 'netease' | 'qq' | 'kugou';
export interface OnlineSong {
  platform: MusicPlatform;
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  albumId?: string;
  albumAudioId?: string;
  mediaId?: string;
  localId?: string | null;
}
export interface RemotePlaylist {
  platform: MusicPlatform;
  uid: string;
  id: string;
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
  error?: string;
}
export interface OnlineState {
  accounts: MusicAccount[];
  jobs: DownloadJob[];
  folder: string;
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
export const MUSIC_PLATFORMS: [MusicPlatform, string][] = [
  ['netease', '网易云音乐'],
  ['qq', 'QQ Music'],
  ['kugou', '酷狗音乐'],
];
export const songKey = (song: OnlineSong) => `${song.platform}:${song.id}`;
