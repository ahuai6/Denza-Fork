// Two ways in: the desktop app (the music library, the player and the workshop) or the web build (the workshop alone,
// its project kept in this browser). The desktop app has two interfaces, chosen at start by the `ui` setting: the
// classic pages, or the space (a cathedral to walk through, src/app/space); changing it restarts the app.
import './styles/base.css';
import './words';
import { createRoot } from 'react-dom/client';
import { D, Lib } from './bridge';

const root = createRoot(document.getElementById('root')!);
(async () => {
  const mode = D && Lib ? (await D.settings().catch(() => null))?.ui : null;
  if (mode === 'space') {
    const { SpaceShell } = await import('./space/SpaceShell');
    root.render(<SpaceShell />);
    return;
  }
  if (Lib) {
    const { Shell } = await import('./views/Shell');
    root.render(<Shell />);
    return;
  }
  const { WebApp } = await import('./views/workshop/WebApp');
  root.render(<WebApp />);
})();
