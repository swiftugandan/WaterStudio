/**
 * The .wsproj file: a SQLite database. The network is stored whole as the canonical
 * model (JSON, lossless for every number), so a project reopens exactly as saved;
 * `nodes` and `links` views over it serve SQL and GIS tools and are ignored on reading.
 *
 * Schema (user_version 1):
 *   meta(key, value)                 format, version, application, saved, fileName, title
 *   model(json)                      one row: the canonical model
 *   scenarios(ord, id, name, parent, json)
 *   extras(key, json)                scenarioBase, activeScenario, isolationValves, msx, criteria
 *   settings(key, json)              how the project was being viewed
 *   nodes(id, kind, x, y, elevation)                       view
 *   links(id, kind, from_node, to_node, length, diameter)  view
 *
 * The functions take an initialised sqlite3 module so the caller decides where it
 * runs (a worker in the app, Node in tests).
 */

import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { readCriteria, type model } from '@waterstudio/core';
import type { ProjectData, StoredScenario, StoredScenarios } from './project.ts';

/** `PRAGMA application_id`: "WSPR". */
export const APPLICATION_ID = 0x57535052;
/** The schema version this code writes; it reads this and every earlier one. */
export const FORMAT_VERSION = 1;
const FORMAT = 'waterstudio-project';

/** SQLite's file header, the first 16 bytes of every database. */
const MAGIC = 'SQLite format 3\0';

export class ProjectError extends Error {
  override name = 'ProjectError';
}

/** Whether `bytes` start like a SQLite database (and so might be a project). */
export function isSqlite(bytes: Uint8Array): boolean {
  if (bytes.length < 100) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

export interface ProjectMeta {
  /** The application that wrote the file, e.g. "WaterStudio 0.1.0". */
  application: string;
  /** When it was saved (ISO 8601). */
  saved: string;
}

// JSON has no NaN, infinities or negative zero. They are written as strings marked by a
// leading NUL ("\u0000NaN", "\u0000-0", ...), and a string that really starts with NUL
// gets a second one. Decoding walks the value only when the text has a NUL escape, so
// the usual case is a plain JSON.parse (a reviver would be several times slower).
const NUL = '\u0000';
const SPECIALS: Record<string, number> = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 };
function replacer(_k: string, v: unknown): unknown {
  if (typeof v === 'number') {
    if (Number.isFinite(v)) return Object.is(v, -0) ? `${NUL}-0` : v;
    return `${NUL}${String(v)}`;
  }
  if (typeof v === 'string' && v.startsWith(NUL)) return NUL + v;
  return v;
}
function unmark(v: unknown): unknown {
  if (typeof v === 'string') {
    if (!v.startsWith(NUL)) return v;
    const rest = v.slice(1);
    if (rest.startsWith(NUL)) return rest;
    return Object.hasOwn(SPECIALS, rest) ? SPECIALS[rest] : v;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = unmark(v[i]);
  } else if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) o[k] = unmark(o[k]);
  }
  return v;
}
/** JSON that keeps every number exactly. */
export const encode = (v: unknown): string => JSON.stringify(v, replacer);
export function decode(s: string): unknown {
  const v = JSON.parse(s) as unknown;
  return s.includes('\\u0000') ? unmark(v) : v;
}

// The nodes and links as views over the model, for SQL and GIS tools; never read back.
const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE model(json TEXT NOT NULL);
CREATE TABLE scenarios(ord INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, parent TEXT, json TEXT NOT NULL);
CREATE TABLE extras(key TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE VIEW nodes AS SELECT
  json_extract(n.value, '$.id') AS id,
  json_extract(n.value, '$.kind.type') AS kind,
  json_extract(n.value, '$.coordinates[0]') AS x,
  json_extract(n.value, '$.coordinates[1]') AS y,
  coalesce(json_extract(n.value, '$.kind.elevation'), json_extract(n.value, '$.kind.head')) AS elevation
  FROM model, json_each(model.json, '$.nodes') AS n;
CREATE VIEW links AS SELECT
  json_extract(l.value, '$.id') AS id,
  coalesce(json_extract(l.value, '$.kind.valveType'), json_extract(l.value, '$.kind.type')) AS kind,
  json_extract(l.value, '$.from') AS from_node,
  json_extract(l.value, '$.to') AS to_node,
  json_extract(l.value, '$.kind.length') AS length,
  json_extract(l.value, '$.kind.diameter') AS diameter
  FROM model, json_each(model.json, '$.links') AS l;
`;

/** Write a project to the bytes of a new SQLite database. */
export function writeProject(sqlite3: Sqlite3Static, data: ProjectData, meta: ProjectMeta): Uint8Array {
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  try {
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${FORMAT_VERSION};`);
    db.exec(SCHEMA);
    db.transaction((t) => {
      const metaRows: [string, string][] = [
        ['format', FORMAT],
        ['version', String(FORMAT_VERSION)],
        ['application', meta.application],
        ['saved', meta.saved],
        ['fileName', data.fileName],
        ['title', data.model.title[0] ?? ''],
      ];
      for (const row of metaRows) t.exec({ sql: 'INSERT INTO meta VALUES (?, ?)', bind: row });
      t.exec({ sql: 'INSERT INTO model VALUES (?)', bind: [encode(data.model)] });

      const s = data.scenarios;
      if (s) {
        s.scenarios.forEach((sc, i) => {
          t.exec({
            sql: 'INSERT INTO scenarios VALUES (?, ?, ?, ?, ?)',
            bind: [i, sc.id, sc.name, sc.parent, encode({ fields: sc.fields, doc: sc.doc })],
          });
        });
        t.exec({ sql: 'INSERT INTO extras VALUES (?, ?)', bind: ['scenarioBase', encode(s.base)] });
        t.exec({ sql: 'INSERT INTO extras VALUES (?, ?)', bind: ['activeScenario', encode(s.active)] });
      }
      if (data.isolationValves.length > 0)
        t.exec({
          sql: 'INSERT INTO extras VALUES (?, ?)',
          bind: ['isolationValves', encode(data.isolationValves)],
        });
      if (data.msx) t.exec({ sql: 'INSERT INTO extras VALUES (?, ?)', bind: ['msx', encode(data.msx)] });
      if (data.criteria)
        t.exec({ sql: 'INSERT INTO extras VALUES (?, ?)', bind: ['criteria', encode(data.criteria)] });
      for (const [k, v] of Object.entries(data.settings))
        t.exec({ sql: 'INSERT INTO settings VALUES (?, ?)', bind: [k, encode(v)] });
    });
    return sqlite3.capi.sqlite3_js_db_export(db);
  } finally {
    db.close();
  }
}

function open(sqlite3: Sqlite3Static, bytes: Uint8Array): Database {
  if (!isSqlite(bytes)) throw new ProjectError('not a WaterStudio project (not a SQLite database)');
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const { capi } = sqlite3;
  const rc = capi.sqlite3_deserialize(
    db.pointer ?? 0,
    'main',
    p,
    bytes.length,
    bytes.length,
    capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  if (rc !== capi.SQLITE_OK) {
    db.close();
    throw new ProjectError(`the project file could not be opened (SQLite error ${rc})`);
  }
  return db;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : String(v));

/** Read a project written by `writeProject`. Throws `ProjectError` for anything else. */
export function readProject(sqlite3: Sqlite3Static, bytes: Uint8Array): ProjectData & { meta: ProjectMeta } {
  const db = open(sqlite3, bytes);
  try {
    let appId: unknown;
    let version: unknown;
    try {
      appId = db.selectValue('PRAGMA application_id');
      version = db.selectValue('PRAGMA user_version');
    } catch {
      throw new ProjectError('the project file is damaged');
    }
    if (appId !== APPLICATION_ID) throw new ProjectError('not a WaterStudio project');
    if (typeof version !== 'number' || version < 1)
      throw new ProjectError('the project file has no format version');
    if (version > FORMAT_VERSION)
      throw new ProjectError(`the project was saved by a newer WaterStudio (format ${version})`);

    const meta = new Map<string, string>();
    for (const [k, v] of db.selectArrays('SELECT key, value FROM meta')) meta.set(asString(k), asString(v));
    if (meta.get('format') !== FORMAT) throw new ProjectError('not a WaterStudio project');

    const modelJson = db.selectValue('SELECT json FROM model');
    if (typeof modelJson !== 'string') throw new ProjectError('the project has no network');
    const model = decode(modelJson) as model.Model;

    const extras = new Map<string, unknown>();
    for (const [k, v] of db.selectArrays('SELECT key, json FROM extras'))
      extras.set(asString(k), decode(asString(v)));

    let scenarios: StoredScenarios | null = null;
    if (extras.has('scenarioBase')) {
      const list: StoredScenario[] = db
        .selectArrays('SELECT id, name, parent, json FROM scenarios ORDER BY ord')
        .map(([id, name, parent, json]) => {
          const body = decode(asString(json)) as Pick<StoredScenario, 'fields' | 'doc'>;
          return {
            id: asString(id),
            name: asString(name),
            parent: parent === null ? null : asString(parent),
            fields: body.fields,
            doc: body.doc,
          };
        });
      scenarios = {
        scenarios: list,
        base: extras.get('scenarioBase') as StoredScenarios['base'],
        active: (extras.get('activeScenario') ?? null) as string | null,
      };
    }

    const settings: Record<string, unknown> = {};
    for (const [k, v] of db.selectArrays('SELECT key, json FROM settings'))
      settings[asString(k)] = decode(asString(v));

    return {
      fileName: meta.get('fileName') ?? '',
      model,
      scenarios,
      isolationValves: (extras.get('isolationValves') ?? []) as ProjectData['isolationValves'],
      msx: (extras.get('msx') ?? null) as ProjectData['msx'],
      ...(extras.has('criteria') ? { criteria: readCriteria(extras.get('criteria')) } : {}),
      settings,
      meta: { application: meta.get('application') ?? '', saved: meta.get('saved') ?? '' },
    };
  } catch (e) {
    if (e instanceof ProjectError) throw e;
    throw new ProjectError(`the project file is damaged (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    db.close();
  }
}
