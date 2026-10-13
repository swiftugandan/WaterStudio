/**
 * The design criteria profile: the limits a design is checked against, the same for a
 * person and an agent (PLAN: "Design criteria profile"). Every limit starts blank, for
 * the engineer to set to their local standard; a blank limit is not checked. Values are
 * in the model's units, like everything else the user sees.
 */

/** The limits of a design, each `null` until set. */
export interface Criteria {
  /** Lowest junction pressure at any report time. */
  minPressure: number | null;
  /** Highest junction pressure at any report time. */
  maxPressure: number | null;
  /** Highest pipe velocity. */
  maxVelocity: number | null;
  /** Highest pipe unit head loss (per 1000 length units). */
  maxHeadloss: number | null;
  /** Lowest disinfectant residual at a junction, when the model runs a chemical. */
  minResidual: number | null;
  /** Highest water age at a junction, in hours, when the model runs water age. */
  maxAge: number | null;
}

export type Criterion = keyof Criteria;

export const CRITERIA: readonly Criterion[] = [
  'minPressure',
  'maxPressure',
  'maxVelocity',
  'maxHeadloss',
  'minResidual',
  'maxAge',
];

/** What each criterion limits, for people and agents. */
export const CRITERION_LABEL: Record<Criterion, string> = {
  minPressure: 'Minimum pressure',
  maxPressure: 'Maximum pressure',
  maxVelocity: 'Maximum velocity',
  maxHeadloss: 'Maximum unit head loss',
  minResidual: 'Minimum disinfectant residual',
  maxAge: 'Maximum water age',
};

export function emptyCriteria(): Criteria {
  return {
    minPressure: null,
    maxPressure: null,
    maxVelocity: null,
    maxHeadloss: null,
    minResidual: null,
    maxAge: null,
  };
}

/** The criteria that are set. */
export function setCriteria(c: Criteria): Criterion[] {
  return CRITERIA.filter((k) => c[k] !== null);
}

/**
 * Why a profile cannot be used, or null: limits must be finite, those that cannot be
 * negative are not, and a minimum pressure must not exceed the maximum.
 */
export function criteriaError(c: Criteria): string | null {
  for (const k of CRITERIA) {
    const v = c[k];
    if (v === null) continue;
    if (!Number.isFinite(v)) return `${CRITERION_LABEL[k]} must be a number.`;
    if (k !== 'minPressure' && k !== 'maxPressure' && v < 0)
      return `${CRITERION_LABEL[k]} cannot be negative.`;
  }
  if (c.minPressure !== null && c.maxPressure !== null && c.minPressure > c.maxPressure)
    return 'The minimum pressure is above the maximum.';
  return null;
}

/** A profile read from stored data, keeping only valid limits. */
export function readCriteria(v: unknown): Criteria {
  const out = emptyCriteria();
  if (typeof v !== 'object' || v === null) return out;
  for (const k of CRITERIA) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
  }
  return criteriaError(out) === null ? out : emptyCriteria();
}
