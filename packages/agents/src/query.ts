/**
 * The element query language agents (and later the map and data grid) use, e.g.
 * `type = junction and pressure < 20` or `diameter <= 150 or (status = closed)`.
 * Comparisons are `< <= > >= = !=`; numbers compare numerically, text without regard
 * to case. A unit word after a number is allowed and ignored: values are always in the
 * model's own units. `and` binds tighter than `or`; `not` negates.
 */

export type Value = number | string | boolean | null;

export type Query =
  | { op: 'and' | 'or'; a: Query; b: Query }
  | { op: 'not'; a: Query }
  | { op: 'cmp'; field: string; cmp: '<' | '<=' | '>' | '>=' | '=' | '!='; value: number | string };

export class QueryError extends Error {
  override name = 'QueryError';
}

type Token = { t: 'id' | 'num' | 'str' | 'op' | '(' | ')'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '(' || c === ')') {
      out.push({ t: c, v: c });
      i++;
    } else if ('<>=!'.includes(c)) {
      const two = src.slice(i, i + 2);
      const op = ['<=', '>=', '!=', '==', '<>'].includes(two) ? two : c;
      if (op === '!') throw new QueryError(`Unexpected "!" at ${i + 1}`);
      out.push({ t: 'op', v: op === '==' ? '=' : op === '<>' ? '!=' : op });
      i += op.length;
    } else if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new QueryError('Unclosed quote');
      out.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
    } else if (/[-+.\d]/.test(c)) {
      const m = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
      if (!m) throw new QueryError(`Unexpected "${c}" at ${i + 1}`);
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][\w.]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else {
      throw new QueryError(`Unexpected "${c}" at ${i + 1}`);
    }
  }
  return out;
}

const WORDS = new Set(['and', 'or', 'not']);

export function parseQuery(src: string): Query {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isWord = (w: string) => peek()?.t === 'id' && peek()!.v.toLowerCase() === w;

  const primary = (): Query => {
    const t = peek();
    if (!t) throw new QueryError('The query ended early');
    if (t.t === '(') {
      p++;
      const q = or();
      if (peek()?.t !== ')') throw new QueryError('Missing ")"');
      p++;
      return q;
    }
    if (t.t !== 'id' || WORDS.has(t.v.toLowerCase()))
      throw new QueryError(`Expected a field name, found "${t.v}"`);
    p++;
    const op = peek();
    if (op?.t !== 'op') throw new QueryError(`Expected a comparison after "${t.v}"`);
    p++;
    const v = peek();
    if (!v || (v.t !== 'num' && v.t !== 'str' && v.t !== 'id'))
      throw new QueryError(`Expected a value after "${op.v}"`);
    p++;
    let value: number | string = v.t === 'num' ? Number(v.v) : v.v;
    if (v.t === 'num') {
      // A unit word after a number ("20 psi") is allowed and ignored.
      const u = peek();
      if (u?.t === 'id' && !WORDS.has(u.v.toLowerCase())) p++;
    } else if (v.t === 'id' && /^(true|false)$/i.test(v.v)) {
      value = v.v.toLowerCase();
    }
    return { op: 'cmp', field: t.v.toLowerCase(), cmp: op.v as '<', value };
  };
  const not = (): Query => {
    if (isWord('not')) {
      p++;
      return { op: 'not', a: not() };
    }
    return primary();
  };
  const and = (): Query => {
    let q = not();
    while (isWord('and')) {
      p++;
      q = { op: 'and', a: q, b: not() };
    }
    return q;
  };
  const or = (): Query => {
    let q = and();
    while (isWord('or')) {
      p++;
      q = { op: 'or', a: q, b: and() };
    }
    return q;
  };
  const q = or();
  if (p < toks.length) throw new QueryError(`Unexpected "${toks[p]!.v}"`);
  return q;
}

/** Field names a query uses, to check them before evaluating. */
export function queryFields(q: Query): string[] {
  if (q.op === 'cmp') return [q.field];
  if (q.op === 'not') return queryFields(q.a);
  return [...queryFields(q.a), ...queryFields(q.b)];
}

/** Evaluate against an element whose fields `get` returns (undefined when it has none). */
export function matches(q: Query, get: (field: string) => Value | undefined): boolean {
  switch (q.op) {
    case 'and':
      return matches(q.a, get) && matches(q.b, get);
    case 'or':
      return matches(q.a, get) || matches(q.b, get);
    case 'not':
      return !matches(q.a, get);
    case 'cmp': {
      const v = get(q.field);
      if (v === undefined || v === null) return q.cmp === '!=';
      if (typeof q.value === 'number') {
        const x = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
        if (!Number.isFinite(x)) return q.cmp === '!=';
        switch (q.cmp) {
          case '<':
            return x < q.value;
          case '<=':
            return x <= q.value;
          case '>':
            return x > q.value;
          case '>=':
            return x >= q.value;
          case '=':
            return x === q.value;
          case '!=':
            return x !== q.value;
        }
      }
      const a = String(v).toLowerCase();
      const b = q.value.toLowerCase();
      if (q.cmp === '=') return a === b;
      if (q.cmp === '!=') return a !== b;
      return q.cmp === '<' ? a < b : q.cmp === '<=' ? a <= b : q.cmp === '>' ? a > b : a >= b;
    }
  }
}
