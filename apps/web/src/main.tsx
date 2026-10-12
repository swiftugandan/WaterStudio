import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@waterstudio/ui/tokens.css';
import './app.css';
import { noticeAutosave, startAutosave } from './app/autosave.ts';
import { gridModel } from './app/bench.ts';
import { createCommands } from './app/commands.ts';
import { AppContext } from './app/context.tsx';
import { Prefs } from './app/prefs.ts';
import { AppState } from './app/state.ts';
import { App } from './shell/App.tsx';

const prefs = new Prefs();
const state = new AppState(prefs);
prefs.subscribe(() => state.emit());
const bus = createCommands(state);
// Exposed for tests and the browser console.
(globalThis as { waterstudio?: unknown }).waterstudio = { state, bus, gridModel };

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <AppContext.Provider value={{ state, bus }}>
      <App />
    </AppContext.Provider>
  </StrictMode>,
);

// Start with a sample so the map is never empty on first visit.
void Promise.resolve(bus.execute('file.sample.Net1')).then(() => {
  noticeAutosave(state);
  startAutosave(state);
});
