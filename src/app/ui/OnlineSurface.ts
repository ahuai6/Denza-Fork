// Shared extension surfaces follow the active appearance, including content mounted through portals.
import { settings, useStore } from '../state';
import s from './OnlineSurface.module.css';
export function useOnlineSurface() {
  const space = useStore(settings, (state) => state.ui === 'space');
  const lite = useStore(settings, (state) => state.gfx === 'lite');
  return { space, className: space ? s.space + (lite ? ' ' + s.lite : '') : '' };
}
