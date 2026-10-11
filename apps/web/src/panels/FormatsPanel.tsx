/**
 * Number formats, as EPANET's Preferences › Formats: decimal places for each result
 * variable in the results table, the inspector and map labels. Remembered per browser.
 */

import { LINK_VARIABLES, NODE_VARIABLES } from '@waterstudio/engine-client';
import { useApp } from '../app/context.tsx';
import { variableLabel } from '../shell/Ribbon.tsx';
import { InputRow } from './fields.tsx';

export function FormatsPanel() {
  const { state } = useApp();
  const prefs = state.prefs;
  const row = (v: string) => (
    <InputRow
      key={v}
      label={variableLabel(v)}
      help="Decimal places, 0 to 6."
      numeric
      value={prefs.decimals[v] === undefined ? '' : String(prefs.decimals[v])}
      placeholder={String(prefs.places(v))}
      onCommit={(t) => {
        const s = t.trim();
        if (s === '') {
          prefs.setDecimals(v, null);
          return undefined;
        }
        if (!/^[0-6]$/.test(s)) return 'Decimal places must be a whole number from 0 to 6.';
        prefs.setDecimals(v, Number(s));
        return undefined;
      }}
    />
  );
  return (
    <div className="panel formats">
      <section className="field-group" aria-label="Node results">
        <h3>Node results</h3>
        {NODE_VARIABLES.map(row)}
      </section>
      <section className="field-group" aria-label="Link results">
        <h3>Link results</h3>
        {LINK_VARIABLES.filter((v) => v !== 'status').map(row)}
      </section>
    </div>
  );
}
