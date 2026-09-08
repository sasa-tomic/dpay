#!/usr/bin/env node
// Write crates/dpay-relay/assets/palette.css from app/config/palette.ts. See
// app/config/relayPaletteCss.ts for what is emitted and why the artifact is checked in.
//
// No bundler and no transpile step: Node imports the TypeScript directly (type stripping), and the
// emitter's only import is a type, so nothing has to resolve. `just palette-css` runs this.
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {LIGHT, DARK} from '../app/config/palette.ts';
import {relayPaletteCss} from '../app/config/relayPaletteCss.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'crates', 'dpay-relay', 'assets', 'palette.css');
writeFileSync(out, relayPaletteCss(LIGHT, DARK));
console.log(`wrote ${out}`);
