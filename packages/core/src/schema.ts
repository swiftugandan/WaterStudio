/**
 * The element schema: every column of the node and link tables, which element kinds
 * use it, and how the inspector, data grid, import mapping and agent tools present it.
 * This is the single catalogue the plan calls for; the tables are built from it.
 */

import type { ColumnSpec, ColumnType } from './table.ts';

export const NODE_KINDS = ['junction', 'reservoir', 'tank'] as const;
export const LINK_KINDS = ['pipe', 'pump', 'valve'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export type LinkKind = (typeof LINK_KINDS)[number];
export type ElementKind = NodeKind | LinkKind;

export const PIPE_STATUS = ['open', 'closed', 'checkValve'] as const;
export const VALVE_TYPES = ['prv', 'psv', 'pbv', 'fcv', 'tcv', 'gpv', 'pcv'] as const;
export const PUMP_CURVE_TYPES = ['none', 'head', 'power'] as const;
export const OPEN_CLOSED = ['open', 'closed'] as const;
export const FIXED_STATUS = ['none', 'open', 'closed'] as const;
export const OVERFLOW = ['unset', 'no', 'yes'] as const;

/** Physical quantities, for unit labels and conversion. */
export type Quantity =
  | 'elevation'
  | 'length'
  | 'diameter'
  | 'tankDiameter'
  | 'flow'
  | 'pressure'
  | 'head'
  | 'level'
  | 'velocity'
  | 'roughness'
  | 'power'
  | 'volume'
  | 'emitter'
  | 'concentration'
  | 'reactionRate'
  | 'bulkRate'
  | 'wallRate'
  | 'leakArea'
  | 'leakExpansion'
  | 'price'
  | 'none';

export type Editor =
  | { type: 'number'; min?: number; max?: number; optional?: boolean }
  | { type: 'text' }
  | { type: 'enum'; options: readonly string[] }
  | { type: 'pattern'; optional: true }
  | { type: 'curve'; optional: true }
  | { type: 'node' }
  | { type: 'none' };

export interface FieldSpec {
  name: string;
  column: ColumnType;
  fallback: unknown;
  label: string;
  /** Element kinds that have this field; empty means every kind of the table. */
  kinds: readonly ElementKind[];
  quantity: Quantity;
  editor: Editor;
  /** Shown as help in the inspector and as the description in agent tool schemas. */
  help: string;
  /** The inspector groups fields under these headings. */
  group: 'General' | 'Hydraulics' | 'Quality' | 'Energy' | 'Leakage' | 'Display';
}

const f = (
  s: Omit<FieldSpec, 'kinds' | 'group'> & Partial<Pick<FieldSpec, 'kinds' | 'group'>>,
): FieldSpec => ({
  kinds: [],
  group: 'Hydraulics',
  ...s,
});
const num = (min?: number): Editor => (min === undefined ? { type: 'number' } : { type: 'number', min });
const opt: Editor = { type: 'number', optional: true };
const none: Editor = { type: 'none' };

export const NODE_FIELDS: readonly FieldSpec[] = [
  f({
    name: 'kind',
    column: 'u8',
    fallback: 0,
    label: 'Type',
    quantity: 'none',
    editor: none,
    group: 'General',
    help: 'Junction, reservoir or tank.',
  }),
  f({
    name: 'id',
    column: 'str',
    fallback: '',
    label: 'ID',
    quantity: 'none',
    editor: { type: 'text' },
    group: 'General',
    help: 'Unique label, at most 31 characters, no spaces.',
  }),
  f({
    name: 'x',
    column: 'f64',
    fallback: NaN,
    label: 'X',
    quantity: 'none',
    editor: num(),
    group: 'Display',
    help: 'Map X coordinate.',
  }),
  f({
    name: 'y',
    column: 'f64',
    fallback: NaN,
    label: 'Y',
    quantity: 'none',
    editor: num(),
    group: 'Display',
    help: 'Map Y coordinate.',
  }),
  f({
    name: 'comment',
    column: 'str',
    fallback: null,
    label: 'Description',
    quantity: 'none',
    editor: { type: 'text' },
    group: 'General',
    help: "Free text, written as the comment on the element's line.",
  }),
  f({
    name: 'tag',
    column: 'str',
    fallback: null,
    label: 'Tag',
    quantity: 'none',
    editor: { type: 'text' },
    group: 'General',
    help: 'A label for grouping elements, from [TAGS].',
  }),
  f({
    name: 'elevation',
    column: 'f64',
    fallback: 0,
    label: 'Elevation',
    kinds: ['junction', 'tank'],
    quantity: 'elevation',
    editor: num(),
    help: 'Elevation above a common datum.',
  }),
  f({
    name: 'demands',
    column: 'any',
    fallback: [],
    label: 'Demands',
    kinds: ['junction'],
    quantity: 'flow',
    editor: none,
    help: 'Demand categories: base demand, time pattern and category name.',
  }),
  f({
    name: 'emitter',
    column: 'f64',
    fallback: NaN,
    label: 'Emitter coefficient',
    kinds: ['junction'],
    quantity: 'emitter',
    editor: opt,
    help: 'Flow through a sprinkler or leak per unit of pressure drop raised to the emitter exponent.',
  }),
  f({
    name: 'head',
    column: 'f64',
    fallback: 0,
    label: 'Total head',
    kinds: ['reservoir'],
    quantity: 'head',
    editor: num(),
    help: 'Hydraulic head (elevation plus pressure head) of the water.',
  }),
  f({
    name: 'headPattern',
    column: 'str',
    fallback: null,
    label: 'Head pattern',
    kinds: ['reservoir'],
    quantity: 'none',
    editor: { type: 'pattern', optional: true },
    help: 'Time pattern that multiplies the total head.',
  }),
  f({
    name: 'level',
    column: 'f64',
    fallback: 0,
    label: 'Level offset',
    kinds: ['reservoir'],
    quantity: 'level',
    editor: none,
    help: 'Level added to the head (only from a zero-diameter tank).',
  }),
  f({
    name: 'initLevel',
    column: 'f64',
    fallback: 10,
    label: 'Initial level',
    kinds: ['tank'],
    quantity: 'level',
    editor: num(0),
    help: 'Water level above the tank bottom at the start of the simulation.',
  }),
  f({
    name: 'minLevel',
    column: 'f64',
    fallback: 0,
    label: 'Minimum level',
    kinds: ['tank'],
    quantity: 'level',
    editor: num(0),
    help: 'Lowest level the tank is allowed to drain to.',
  }),
  f({
    name: 'maxLevel',
    column: 'f64',
    fallback: 20,
    label: 'Maximum level',
    kinds: ['tank'],
    quantity: 'level',
    editor: num(0),
    help: 'Highest level the tank is allowed to fill to.',
  }),
  f({
    name: 'diameter',
    column: 'f64',
    fallback: 50,
    label: 'Diameter',
    kinds: ['tank'],
    quantity: 'tankDiameter',
    editor: num(0),
    help: 'Diameter of a cylindrical tank; ignored when a volume curve is given.',
  }),
  f({
    name: 'minVolume',
    column: 'f64',
    fallback: 0,
    label: 'Minimum volume',
    kinds: ['tank'],
    quantity: 'volume',
    editor: num(0),
    help: 'Volume at the minimum level.',
  }),
  f({
    name: 'volumeCurve',
    column: 'str',
    fallback: null,
    label: 'Volume curve',
    kinds: ['tank'],
    quantity: 'none',
    editor: { type: 'curve', optional: true },
    help: 'Volume against depth for a non-cylindrical tank.',
  }),
  f({
    name: 'overflow',
    column: 'u8',
    fallback: 0,
    label: 'Can overflow',
    kinds: ['tank'],
    quantity: 'none',
    editor: { type: 'enum', options: OVERFLOW },
    help: 'Whether the tank spills when full instead of closing its inlet.',
  }),
  f({
    name: 'mixing',
    column: 'any',
    fallback: null,
    label: 'Mixing model',
    kinds: ['tank'],
    quantity: 'none',
    editor: none,
    group: 'Quality',
    help: 'How water mixes in the tank: complete, two-compartment, FIFO or LIFO.',
  }),
  f({
    name: 'bulkCoeff',
    column: 'f64',
    fallback: NaN,
    label: 'Bulk reaction coefficient',
    kinds: ['tank'],
    quantity: 'bulkRate',
    editor: opt,
    group: 'Quality',
    help: 'Tank-specific bulk reaction rate coefficient.',
  }),
  f({
    name: 'initialQuality',
    column: 'f64',
    fallback: NaN,
    label: 'Initial quality',
    quantity: 'concentration',
    editor: opt,
    group: 'Quality',
    help: 'Water quality at the start of the simulation.',
  }),
  f({
    name: 'source',
    column: 'any',
    fallback: null,
    label: 'Source',
    quantity: 'none',
    editor: none,
    group: 'Quality',
    help: 'Water quality source: type, strength and pattern.',
  }),
];

export const LINK_FIELDS: readonly FieldSpec[] = [
  f({
    name: 'kind',
    column: 'u8',
    fallback: 0,
    label: 'Type',
    quantity: 'none',
    editor: none,
    group: 'General',
    help: 'Pipe, pump or valve.',
  }),
  f({
    name: 'id',
    column: 'str',
    fallback: '',
    label: 'ID',
    quantity: 'none',
    editor: { type: 'text' },
    group: 'General',
    help: 'Unique label, at most 31 characters, no spaces.',
  }),
  f({
    name: 'from',
    column: 'u32',
    fallback: 0,
    label: 'Start node',
    quantity: 'none',
    editor: { type: 'node' },
    group: 'General',
    help: 'Node the link starts at; positive flow runs from start to end.',
  }),
  f({
    name: 'to',
    column: 'u32',
    fallback: 0,
    label: 'End node',
    quantity: 'none',
    editor: { type: 'node' },
    group: 'General',
    help: 'Node the link ends at.',
  }),
  f({
    name: 'comment',
    column: 'str',
    fallback: null,
    label: 'Description',
    quantity: 'none',
    editor: { type: 'text' },
    group: 'General',
    help: "Free text, written as the comment on the element's line.",
  }),
  f({
    name: 'tag',
    column: 'str',
    fallback: null,
    label: 'Tag',
    quantity: 'none',
    editor: { type: 'text' },
    group: 'General',
    help: 'A label for grouping elements, from [TAGS].',
  }),
  f({
    name: 'vertices',
    column: 'any',
    fallback: [],
    label: 'Vertices',
    quantity: 'none',
    editor: none,
    group: 'Display',
    help: 'Interior points of the drawn line, as [x, y, x, y, ...].',
  }),
  f({
    name: 'length',
    column: 'f64',
    fallback: 1000,
    label: 'Length',
    kinds: ['pipe'],
    quantity: 'length',
    editor: num(0),
    help: 'Actual length of the pipe.',
  }),
  f({
    name: 'diameter',
    column: 'f64',
    fallback: 12,
    label: 'Diameter',
    kinds: ['pipe', 'valve'],
    quantity: 'diameter',
    editor: num(0),
    help: 'Internal diameter.',
  }),
  f({
    name: 'roughness',
    column: 'f64',
    fallback: 100,
    label: 'Roughness',
    kinds: ['pipe'],
    quantity: 'roughness',
    editor: num(0),
    help: 'Hazen-Williams C, Darcy-Weisbach roughness height or Manning n, depending on the head loss formula.',
  }),
  f({
    name: 'minorLoss',
    column: 'f64',
    fallback: 0,
    label: 'Minor loss coefficient',
    kinds: ['pipe', 'valve'],
    quantity: 'none',
    editor: num(0),
    help: 'Sum of the minor loss coefficients of the fittings.',
  }),
  f({
    name: 'pipeStatus',
    column: 'u8',
    fallback: 0,
    label: 'Initial status',
    kinds: ['pipe'],
    quantity: 'none',
    editor: { type: 'enum', options: PIPE_STATUS },
    help: 'Open, closed, or a check valve that only lets water flow from start to end.',
  }),
  f({
    name: 'leakArea',
    column: 'f64',
    fallback: NaN,
    label: 'Leak area',
    kinds: ['pipe'],
    quantity: 'leakArea',
    editor: opt,
    group: 'Leakage',
    help: 'FAVAD leak area per 100 length units of pipe.',
  }),
  f({
    name: 'leakExpansion',
    column: 'f64',
    fallback: NaN,
    label: 'Leak expansion',
    kinds: ['pipe'],
    quantity: 'leakExpansion',
    editor: opt,
    group: 'Leakage',
    help: 'FAVAD increase of leak area with pressure, per 100 length units of pipe.',
  }),
  f({
    name: 'bulkCoeff',
    column: 'f64',
    fallback: NaN,
    label: 'Bulk coefficient',
    kinds: ['pipe'],
    quantity: 'bulkRate',
    editor: opt,
    group: 'Quality',
    help: 'Pipe-specific bulk reaction rate coefficient.',
  }),
  f({
    name: 'wallCoeff',
    column: 'f64',
    fallback: NaN,
    label: 'Wall coefficient',
    kinds: ['pipe'],
    quantity: 'wallRate',
    editor: opt,
    group: 'Quality',
    help: 'Pipe-specific wall reaction rate coefficient.',
  }),
  f({
    name: 'pumpCurveType',
    column: 'u8',
    fallback: 1,
    label: 'Pump defined by',
    kinds: ['pump'],
    quantity: 'none',
    editor: { type: 'enum', options: PUMP_CURVE_TYPES },
    help: 'A head curve, or constant power.',
  }),
  f({
    name: 'pumpCurve',
    column: 'str',
    fallback: null,
    label: 'Pump curve',
    kinds: ['pump'],
    quantity: 'none',
    editor: { type: 'curve', optional: true },
    help: 'Head against flow.',
  }),
  f({
    name: 'power',
    column: 'f64',
    fallback: 0,
    label: 'Power',
    kinds: ['pump'],
    quantity: 'power',
    editor: num(0),
    help: 'Constant power, when the pump has no curve.',
  }),
  f({
    name: 'speed',
    column: 'f64',
    fallback: 1,
    label: 'Speed',
    kinds: ['pump'],
    quantity: 'none',
    editor: num(0),
    help: 'Relative speed setting (1 is normal speed).',
  }),
  f({
    name: 'pattern',
    column: 'str',
    fallback: null,
    label: 'Speed pattern',
    kinds: ['pump'],
    quantity: 'none',
    editor: { type: 'pattern', optional: true },
    help: 'Time pattern of relative speed.',
  }),
  f({
    name: 'pumpStatus',
    column: 'u8',
    fallback: 0,
    label: 'Initial status',
    kinds: ['pump'],
    quantity: 'none',
    editor: { type: 'enum', options: OPEN_CLOSED },
    help: 'Whether the pump starts on or off.',
  }),
  f({
    name: 'price',
    column: 'f64',
    fallback: NaN,
    label: 'Energy price',
    kinds: ['pump'],
    quantity: 'price',
    editor: opt,
    group: 'Energy',
    help: 'Average energy price per kWh; overrides the global price.',
  }),
  f({
    name: 'pricePattern',
    column: 'str',
    fallback: null,
    label: 'Price pattern',
    kinds: ['pump'],
    quantity: 'none',
    editor: { type: 'pattern', optional: true },
    group: 'Energy',
    help: 'Time pattern of energy price.',
  }),
  f({
    name: 'efficiencyCurve',
    column: 'str',
    fallback: null,
    label: 'Efficiency curve',
    kinds: ['pump'],
    quantity: 'none',
    editor: { type: 'curve', optional: true },
    group: 'Energy',
    help: 'Efficiency (%) against flow.',
  }),
  f({
    name: 'valveType',
    column: 'u8',
    fallback: 0,
    label: 'Valve type',
    kinds: ['valve'],
    quantity: 'none',
    editor: { type: 'enum', options: VALVE_TYPES },
    help: 'PRV, PSV, PBV, FCV, TCV, GPV or PCV.',
  }),
  f({
    name: 'setting',
    column: 'f64',
    fallback: 0,
    label: 'Setting',
    kinds: ['valve'],
    quantity: 'none',
    editor: num(),
    help: 'Pressure for PRV, PSV and PBV; flow for FCV; loss coefficient for TCV; percent open for PCV.',
  }),
  f({
    name: 'settingCurve',
    column: 'str',
    fallback: null,
    label: 'Head loss curve',
    kinds: ['valve'],
    quantity: 'none',
    editor: { type: 'curve', optional: true },
    help: 'Head loss against flow for a GPV.',
  }),
  f({
    name: 'pcvCurve',
    column: 'str',
    fallback: null,
    label: 'Loss curve',
    kinds: ['valve'],
    quantity: 'none',
    editor: { type: 'curve', optional: true },
    help: 'Loss coefficient ratio against percent open for a PCV.',
  }),
  f({
    name: 'fixedStatus',
    column: 'u8',
    fallback: 0,
    label: 'Fixed status',
    kinds: ['valve'],
    quantity: 'none',
    editor: { type: 'enum', options: FIXED_STATUS },
    help: 'Open or closed regardless of the setting; none lets the valve control.',
  }),
];

function columns(fields: readonly FieldSpec[]): ColumnSpec[] {
  return fields.map((s) => ({ name: s.name, type: s.column, fallback: s.fallback }));
}

export const NODE_COLUMNS = columns(NODE_FIELDS);
export const LINK_COLUMNS = columns(LINK_FIELDS);

export const nodeField = new Map(NODE_FIELDS.map((s) => [s.name, s]));
export const linkField = new Map(LINK_FIELDS.map((s) => [s.name, s]));

/** The fields an element kind has, in catalogue order. */
export function fieldsOf(kind: ElementKind): FieldSpec[] {
  const isNode = (NODE_KINDS as readonly string[]).includes(kind);
  return (isNode ? NODE_FIELDS : LINK_FIELDS).filter((s) => s.kinds.length === 0 || s.kinds.includes(kind));
}
