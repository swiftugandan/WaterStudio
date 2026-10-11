/**
 * The engineering symbol catalogue. Each symbol has one SVG master in `masters/` on a
 * 24-unit grid, anchored at (12, 12). Node symbols are drawn centred on the node; link
 * symbols are drawn along +x and rotated to the link's bearing at its midpoint.
 *
 * Every shape in a master carries `data-paint`:
 *  - `fg`: the symbol's colour (the element's result colour or the theme's node colour);
 *  - `bg`: the canvas background, so the link line does not show through the symbol;
 *  - `state`: a translucent fill driven by results (`data-role="level"` is a tank's level,
 *    scaled from the bottom of its rectangle by the fraction full).
 * Default fills and strokes in the files only make them viewable on their own.
 *
 * Glyphs follow ISO 14617 and ISO 10628-2 conventions where they exist, while staying
 * close to what EPANET users already read.
 */

export type SymbolKind = 'node' | 'link' | 'marker';

export interface SymbolSpec {
  id: string;
  name: string;
  kind: SymbolKind;
  /** Link symbols turn with the link; node and marker symbols stay upright. */
  rotates: boolean;
  /** What the symbol stands for, for tooltips and the legend. */
  description: string;
}

export const symbols = [
  {
    id: 'junction',
    name: 'Junction',
    kind: 'node',
    rotates: false,
    description: 'Filled circle; sized by zoom.',
  },
  {
    id: 'reservoir',
    name: 'Reservoir',
    kind: 'node',
    rotates: false,
    description: 'Open-top basin with a waterline: a fixed-head source.',
  },
  {
    id: 'tank',
    name: 'Tank',
    kind: 'node',
    rotates: false,
    description: 'Closed vessel; the fill shows the current level during playback.',
  },
  {
    id: 'pump',
    name: 'Pump',
    kind: 'link',
    rotates: true,
    description: 'Circle with a triangle pointing downstream.',
  },
  {
    id: 'valve-prv',
    name: 'Pressure reducing valve',
    kind: 'link',
    rotates: true,
    description: 'Valve with a pressure actuator sensing the downstream side.',
  },
  {
    id: 'valve-psv',
    name: 'Pressure sustaining valve',
    kind: 'link',
    rotates: true,
    description: 'Valve with a pressure actuator sensing the upstream side.',
  },
  {
    id: 'valve-pbv',
    name: 'Pressure breaker valve',
    kind: 'link',
    rotates: true,
    description: 'Valve with a pressure actuator sensing both sides.',
  },
  {
    id: 'valve-fcv',
    name: 'Flow control valve',
    kind: 'link',
    rotates: true,
    description: 'Valve with an actuator and a flow tag.',
  },
  {
    id: 'valve-tcv',
    name: 'Throttle control valve',
    kind: 'link',
    rotates: true,
    description: 'Valve tagged T.',
  },
  {
    id: 'valve-gpv',
    name: 'General purpose valve',
    kind: 'link',
    rotates: true,
    description: 'Valve tagged G.',
  },
  {
    id: 'valve-pcv',
    name: 'Positional control valve',
    kind: 'link',
    rotates: true,
    description: 'Valve tagged P (EPANET 2.3).',
  },
  {
    id: 'check-valve',
    name: 'Check valve',
    kind: 'link',
    rotates: true,
    description: 'Valve with its upstream half filled: flow passes left to right only.',
  },
  {
    id: 'isolation-valve-open',
    name: 'Isolation valve (open)',
    kind: 'marker',
    rotates: true,
    description: 'Small valve on a pipe, open.',
  },
  {
    id: 'isolation-valve-closed',
    name: 'Isolation valve (closed)',
    kind: 'marker',
    rotates: true,
    description: 'Small valve on a pipe, filled when closed.',
  },
  {
    id: 'emitter',
    name: 'Emitter',
    kind: 'marker',
    rotates: false,
    description: 'Spray mark beside a junction that discharges through an emitter.',
  },
  { id: 'hydrant', name: 'Hydrant', kind: 'marker', rotates: false, description: 'Hydrant post.' },
  {
    id: 'sensor',
    name: 'Sensor',
    kind: 'marker',
    rotates: false,
    description: 'Instrument bubble (ISA 5.1 style).',
  },
  { id: 'meter', name: 'Meter', kind: 'marker', rotates: false, description: 'Instrument bubble tagged M.' },
  {
    id: 'flow-arrow',
    name: 'Flow arrow',
    kind: 'marker',
    rotates: true,
    description: 'Points in the direction of flow.',
  },
] as const satisfies readonly SymbolSpec[];

export type SymbolId = (typeof symbols)[number]['id'];

/** Which symbol draws a link of each EPANET type. Pipes are plain lines. */
export const linkSymbol = {
  pump: 'pump',
  PRV: 'valve-prv',
  PSV: 'valve-psv',
  PBV: 'valve-pbv',
  FCV: 'valve-fcv',
  TCV: 'valve-tcv',
  GPV: 'valve-gpv',
  PCV: 'valve-pcv',
  CV: 'check-valve',
} as const satisfies Record<string, SymbolId>;
