/**
 * The command bus: every action in the app has an id and goes through `execute`,
 * whether it comes from the ribbon, a shortcut, the command palette, a context menu
 * or an agent. Commands carry their own title, icon, shortcut and enablement so every
 * surface shows them the same way.
 */

export interface Command<C> {
  id: string;
  title: string;
  /** Longer description for the palette and agent tool schemas. */
  description?: string;
  /** Icon name (hydraulic icon set or Lucide), resolved by the UI. */
  icon?: string;
  /** Keyboard shortcut in `Mod+Shift+K` form; `Mod` is Ctrl, or Cmd on macOS. */
  shortcut?: string;
  category: string;
  enabled?: (ctx: C) => boolean;
  checked?: (ctx: C) => boolean;
  run: (ctx: C, args?: unknown) => unknown;
}

export interface CommandRecord {
  id: string;
  time: number;
  ok: boolean;
  error?: string;
}

export class CommandBus<C> {
  private readonly commands = new Map<string, Command<C>>();
  private readonly listeners = new Set<(r: CommandRecord) => void>();

  private readonly context: () => C;

  constructor(context: () => C) {
    this.context = context;
  }

  register(...commands: Command<C>[]): void {
    for (const c of commands) {
      if (this.commands.has(c.id)) throw new Error(`command ${c.id} registered twice`);
      this.commands.set(c.id, c);
    }
  }

  get(id: string): Command<C> | undefined {
    return this.commands.get(id);
  }

  all(): Command<C>[] {
    return [...this.commands.values()];
  }

  isEnabled(id: string): boolean {
    const c = this.commands.get(id);
    return c !== undefined && (c.enabled?.(this.context()) ?? true);
  }

  isChecked(id: string): boolean {
    return this.commands.get(id)?.checked?.(this.context()) ?? false;
  }

  onExecute(fn: (r: CommandRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  execute(id: string, args?: unknown): unknown {
    const c = this.commands.get(id);
    if (!c) throw new Error(`unknown command ${id}`);
    const ctx = this.context();
    if (c.enabled && !c.enabled(ctx)) return undefined;
    try {
      const out = c.run(ctx, args);
      this.notify({ id, time: Date.now(), ok: true });
      return out;
    } catch (e) {
      this.notify({ id, time: Date.now(), ok: false, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  private notify(r: CommandRecord): void {
    for (const fn of this.listeners) fn(r);
  }
}
