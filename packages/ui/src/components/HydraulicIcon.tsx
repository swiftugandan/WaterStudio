import type { SVGProps } from 'react';
import { hydraulicIcons, type HydraulicIconName } from '../icons/hydraulic.ts';

export interface HydraulicIconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  name: HydraulicIconName;
  /** Pixel size; 16 for menus and small ribbon buttons, 32 for large ribbon buttons. */
  size?: number;
  /** Accessible name. Without it the icon is decorative and hidden from assistive technology. */
  title?: string;
}

/** A hydraulic interface icon, styled like Lucide's so the two sets mix. */
export function HydraulicIcon({ name, size = 20, title, ...rest }: HydraulicIconProps) {
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true as const };
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...a11y}
      {...rest}
      // Static markup from our own icon set, never user input.
      dangerouslySetInnerHTML={{ __html: (title ? `<title>${title}</title>` : '') + hydraulicIcons[name] }}
    />
  );
}
