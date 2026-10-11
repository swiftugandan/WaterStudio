import { Moon, Rows3, Sun, SunMoon } from 'lucide-react';
import { EngineDemo } from './sections/EngineDemo.tsx';
import { IconGallery } from './sections/IconGallery.tsx';
import { SymbolGallery } from './sections/SymbolGallery.tsx';
import { TokenGallery } from './sections/TokenGallery.tsx';
import { Segmented } from './Segmented.tsx';
import { useApplyPreferences, usePreference, type DensityPref, type ThemePref } from './preferences.ts';

const THEMES = ['system', 'light', 'dark'] as const;
const DENSITIES = ['comfortable', 'compact'] as const;

export function App() {
  const [theme, setTheme] = usePreference<ThemePref>('ws.theme', THEMES, 'system');
  const [density, setDensity] = usePreference<DensityPref>('ws.density', DENSITIES, 'comfortable');
  useApplyPreferences(theme, density);
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : SunMoon;

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="appbar">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <div className="brand">
          <span className="name">WaterStudio</span>
          <span className="sub">Foundations preview</span>
        </div>
        <span className="badge">pre-alpha</span>
        <div className="spacer" />
        <ThemeIcon size={16} aria-hidden="true" />
        <Segmented
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
        <Rows3 size={16} aria-hidden="true" />
        <Segmented
          label="Density"
          value={density}
          onChange={setDensity}
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
        />
      </header>
      <main id="main">
        <p className="intro">
          The building blocks of WaterStudio, before the editor exists: the Rust engine running as WebAssembly
          in a worker, and the design system the app is built from. The engine below is bit-identical to
          OWA-EPANET 2.3.5 on every network in our test corpus.
        </p>
        <EngineDemo />
        <IconGallery />
        <SymbolGallery />
        <TokenGallery />
      </main>
      <footer className="footer">
        Open source under MIT or Apache-2.0.{' '}
        <a href="https://github.com/swiftugandan/WaterStudio">Source and roadmap on GitHub</a>.
      </footer>
    </>
  );
}
