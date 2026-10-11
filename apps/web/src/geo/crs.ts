/**
 * Coordinate reference systems for placing a network on the world map. EPANET files
 * have no CRS, so WaterStudio records one in [BACKDROP] as `CRS <code or proj4>`, a
 * line EPANET ignores. Common systems are built in; anything else can be given as a
 * proj4 definition.
 */

import proj4 from 'proj4';

export interface Crs {
  /** As written: "EPSG:32633" or a proj4 string. */
  code: string;
  label: string;
  /** Model coordinates to longitude and latitude (degrees). */
  toLngLat(x: number, y: number): [number, number];
  fromLngLat(lng: number, lat: number): [number, number];
}

/** Definitions that are not UTM zones (those are generated). */
const NAMED: Record<string, [string, string]> = {
  'EPSG:4326': ['WGS 84 (longitude, latitude)', '+proj=longlat +datum=WGS84 +no_defs'],
  'EPSG:3857': [
    'Web Mercator',
    '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs',
  ],
  'EPSG:27700': [
    'British National Grid',
    '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs',
  ],
  'EPSG:2154': [
    'RGF93 / Lambert-93 (France)',
    '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs',
  ],
  'EPSG:28992': [
    'Amersfoort / RD New (Netherlands)',
    '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs',
  ],
  'EPSG:2193': [
    'NZGD2000 / New Zealand Transverse Mercator',
    '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +units=m +no_defs',
  ],
  'EPSG:3006': ['SWEREF99 TM (Sweden)', '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs'],
  'EPSG:31370': [
    'Belge 1972 / Belgian Lambert 72',
    '+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 +lat_2=49.8333339 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs',
  ],
  'EPSG:3577': [
    'GDA94 / Australian Albers',
    '+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  ],
};

/** UTM zones: WGS 84 (EPSG:326zz north, 327zz south) and ETRS89 (EPSG:258zz). */
function utm(code: string): [string, string] | null {
  const m = /^EPSG:(32[67]|258)(\d\d)$/.exec(code);
  if (!m) return null;
  const zone = Number(m[2]);
  if (m[1] === '258') {
    if (zone < 28 || zone > 38) return null;
    return [`ETRS89 / UTM zone ${zone}N`, `+proj=utm +zone=${zone} +ellps=GRS80 +units=m +no_defs`];
  }
  if (zone < 1 || zone > 60) return null;
  const south = m[1] === '327';
  return [
    `WGS 84 / UTM zone ${zone}${south ? 'S' : 'N'}`,
    `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`,
  ];
}

/** Systems offered by name in the interface. */
export const COMMON_CRS: { code: string; label: string }[] = [
  ...Object.entries(NAMED).map(([code, [label]]) => ({ code, label })),
  { code: 'EPSG:326zz', label: 'WGS 84 / UTM zone zz N (replace zz)' },
  { code: 'EPSG:327zz', label: 'WGS 84 / UTM zone zz S (replace zz)' },
  { code: 'EPSG:258zz', label: 'ETRS89 / UTM zone zz N (replace zz)' },
];

/** Resolve a CRS code or proj4 definition; null if it is not understood. */
export function resolveCrs(text: string): Crs | null {
  const code = text.trim();
  if (!code) return null;
  const upper = code.toUpperCase();
  let def: [string, string] | null = NAMED[upper] ?? utm(upper);
  if (!def && code.startsWith('+')) def = ['Custom (proj4)', code];
  if (!def) return null;
  let conv: proj4.Converter;
  try {
    conv = proj4(def[1], NAMED['EPSG:4326']![1]);
    // Reject definitions proj4 accepted but cannot evaluate.
    const p = conv.forward([0, 0]);
    if (!Array.isArray(p)) return null;
  } catch {
    return null;
  }
  const c = conv;
  return {
    code: def[1] === code ? code : upper,
    label: def[0],
    toLngLat: (x, y) => {
      const [lng, lat] = c.forward<number[]>([x, y]);
      return [lng ?? NaN, lat ?? NaN];
    },
    fromLngLat: (lng, lat) => {
      const [x, y] = c.inverse<number[]>([lng, lat]);
      return [x ?? NaN, y ?? NaN];
    },
  };
}

/** Guess a CRS from coordinates that look like longitude and latitude. */
export function looksGeographic(minX: number, minY: number, maxX: number, maxY: number): boolean {
  return minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90 && maxX - minX < 5 && maxY - minY < 5;
}
