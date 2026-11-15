import type { MusicPlatform } from '../online/types';
import s from './OnlineMusic.module.css';

// Original geometric artwork: recognizable platform colors without official marks, lettering or silhouettes.
export function PlatformArtwork({ platform }: { platform: MusicPlatform }) {
  return (
    <span className={s.platformArt} data-platform={platform} aria-hidden="true">
      <svg
        viewBox="0 0 100 100"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {platform === 'netease' && (
          <>
            <path d="M72 32a31 31 0 1 0 8 31M50 25v31" />
            <circle cx="44" cy="60" r="10" />
            <path d="m50 26 17-7v18" />
          </>
        )}
        {platform === 'qq' && (
          <>
            <path d="M31 37v28m13-40v51m13-40v29m13-20v10" />
            <path d="M20 27a41 41 0 0 1 61 44M20 73a41 41 0 0 0 54 10" />
          </>
        )}
        {platform === 'kugou' && (
          <>
            <path d="m50 13 34 20v35L50 87 16 68V33Z" />
            <path d="M31 51h8l7-17 9 33 8-16h8" />
          </>
        )}
        {platform === 'apple' && (
          <>
            <rect x="20" y="15" width="60" height="70" rx="20" />
            <path d="M43 62V36l22-5v26M43 43l22-5" />
            <ellipse cx="36" cy="65" rx="7" ry="5" />
            <ellipse cx="58" cy="60" rx="7" ry="5" />
          </>
        )}
      </svg>
    </span>
  );
}
