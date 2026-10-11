// Writes src/tokens/tokens.css from src/tokens/tokens.ts.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tokensToCss } from '../src/tokens/css.ts';

const out = fileURLToPath(new URL('../src/tokens/tokens.css', import.meta.url));
writeFileSync(out, tokensToCss());
console.log(`wrote ${out}`);
