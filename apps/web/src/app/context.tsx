import { createContext, useContext, useSyncExternalStore } from 'react';
import type { CommandBus } from '@waterstudio/core';
import type { AppState } from './state.ts';

export interface App {
  state: AppState;
  bus: CommandBus<AppState>;
}

export const AppContext = createContext<App | null>(null);

export function useAppContext(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error('AppContext missing');
  return app;
}

/** Subscribe to app state; re-renders on every change. */
export function useApp(): App & { version: number } {
  const app = useAppContext();
  const version = useSyncExternalStore(app.state.subscribe, () => app.state.version);
  return { ...app, version };
}
