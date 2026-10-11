/** Resolves an icon name from a command to the hydraulic set or a Lucide icon. */

import { HydraulicIcon, hydraulicIconNames, type HydraulicIconName } from '@waterstudio/ui';
import {
  Command,
  FilePlus,
  FolderOpen,
  Hand,
  Monitor,
  Moon,
  MousePointer2,
  PanelsTopLeft,
  Redo2,
  Rows3,
  Save,
  Scan,
  SquareDashedMousePointer,
  StepBack,
  StepForward,
  Sun,
  SunMoon,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
  Maximize,
  type LucideIcon,
} from 'lucide-react';

const LUCIDE: Record<string, LucideIcon> = {
  'file-plus': FilePlus,
  'folder-open': FolderOpen,
  save: Save,
  undo: Undo2,
  redo: Redo2,
  trash: Trash2,
  'select-all': SquareDashedMousePointer,
  x: X,
  pointer: MousePointer2,
  hand: Hand,
  fit: Maximize,
  'zoom-in': ZoomIn,
  'zoom-out': ZoomOut,
  scan: Scan,
  command: Command,
  moon: Moon,
  sun: Sun,
  'sun-moon': SunMoon,
  rows: Rows3,
  monitor: Monitor,
  panel: PanelsTopLeft,
  'step-back': StepBack,
  'step-forward': StepForward,
};

const HYDRAULIC = new Set<string>(hydraulicIconNames);

export function Icon({ name, size = 16 }: { name: string | undefined; size?: number }) {
  if (name && HYDRAULIC.has(name)) return <HydraulicIcon name={name as HydraulicIconName} size={size} />;
  const L = name ? LUCIDE[name] : undefined;
  return L ? <L size={size} aria-hidden="true" strokeWidth={size >= 24 ? 1.75 : 2} /> : null;
}
