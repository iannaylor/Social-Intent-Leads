// Builds ../index.html from ../src/game.html by inlining CC0 assets from @pmndrs/assets.
// Usage: npm i @pmndrs/assets@1.7.0 && node tools/build.mjs   (run from subway-surfers/)
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkgDir = process.env.PMNDRS_ASSETS || dirname(require.resolve('@pmndrs/assets/package.json'));
const uri = (rel) => readFileSync(join(pkgDir, rel), 'utf8').match(/'(data:[^']+)'/)[1];

const ASSETS = {
  hdri: uri('hdri/warehouse.exr.js'),
  nConcrete: uri('normals/0002.webp.js'),   // rough render / plaster
  nCracked: uri('normals/0006.webp.js'),    // cracked plaster (vault)
  nBrushed: uri('normals/0004.webp.js'),    // brushed steel
  nRust: uri('normals/0005.webp.js'),       // flaking rust
  nFluting: uri('normals/0016.webp.js'),    // corrugated car side
  nTile: uri('normals/0025.webp.js'),       // glazed tile grid (8x8)
  nWeave: uri('normals/0018.webp.js'),      // fine fabric
  nCanvas: uri('normals/0001.webp.js'),     // coarse fabric
  nDiamond: uri('normals/0008.webp.js'),    // diamond plate
  nNubs: uri('normals/0027.webp.js'),       // tactile paving
};
const src = readFileSync(join(here, '..', 'src', 'game.html'), 'utf8');
const out = src.replace('<!--ASSETS-->', `<script>window.ASSETS=${JSON.stringify(ASSETS)};</script>`);
writeFileSync(join(here, '..', 'index.html'), out);
console.log('index.html written,', (out.length / 1048576).toFixed(2), 'MB');
