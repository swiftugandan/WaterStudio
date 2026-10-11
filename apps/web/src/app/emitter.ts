/** A minimal observable for React's useSyncExternalStore. */
export class Emitter {
  private listeners = new Set<() => void>();
  private v = 0;

  get version(): number {
    return this.v;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  emit(): void {
    this.v++;
    for (const fn of this.listeners) fn();
  }
}
