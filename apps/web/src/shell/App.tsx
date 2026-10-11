import { useEffect } from 'react';
import { useApp } from '../app/context.tsx';
import { installShortcuts } from '../app/shortcuts.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { Dock } from './Dock.tsx';
import { Ribbon } from './Ribbon.tsx';
import { StatusBar } from './StatusBar.tsx';

export function App() {
  const { state, bus } = useApp();
  useEffect(() => installShortcuts(bus), [bus]);
  useEffect(() => {
    document.title = `${state.dirty ? '• ' : ''}${state.fileName} — WaterStudio`;
  });
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (state.dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state]);
  return (
    <div className="app">
      <header className="titlebar">
        <img src="/favicon.svg" alt="" width={20} height={20} />
        <h1>WaterStudio</h1>
        <span className="file">
          {state.fileName}
          {state.dirty ? ' •' : ''}
        </span>
        <span className="badge">pre-alpha</span>
      </header>
      <Ribbon />
      <main className="workspace" aria-label="Workspace">
        <Dock />
      </main>
      <StatusBar />
      <CommandPalette />
    </div>
  );
}
