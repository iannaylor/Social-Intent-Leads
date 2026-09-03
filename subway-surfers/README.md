# Ballast Run

A photorealistic-styled, Subway Surfers-inspired endless runner that lives in a
single HTML file. Open `index.html` in any modern browser (Chrome, Edge, Safari,
Firefox) or serve the folder statically. No build step, no assets to download:
every texture is generated procedurally on a canvas at load time.

## Controls

| Action        | Keyboard                 | Touch        |
| ------------- | ------------------------ | ------------ |
| Change track  | Left / Right, A / D      | Swipe left / right |
| Jump          | Up, W, Space             | Swipe up     |
| Roll / drop   | Down, S                  | Swipe down   |
| Start / retry | Space or Enter, button   | Tap          |

Jump the concrete hurdles, roll under the "LOW CLEARANCE" gates, change track
around the fences. Parked trains can be ridden from a hazard-striped ramp.
Moving trains end the run. Clipping the side of a parked train shoves you back
a lane instead of ending the run.

## How the look is built

- Three.js r128 (UMD from cdnjs) with physically based materials on everything.
- Real image based lighting from an embedded CC0 industrial HDRI, plus ten
  CC0 normal maps (concrete, cracked plaster, brushed and flaking steel,
  corrugated car sides, glazed tile, fabric, diamond plate, tactile paving).
  See `ATTRIBUTION.md`.
- Canvas-generated colour textures: concrete, ballast gravel with a derived
  normal map, sooty brick with recessed mortar, station tile aligned to the
  tile normal map, wood sleepers, rust, brushed-steel train sides with lit
  windows, hazard stripes, chain-link, graffiti and signage.
- Geometry with real profiles: an elliptical brick vault with steel ribs,
  extruded rail sections with polished heads, rounded sleepers with clips,
  third rail with cover boards, I-beam station columns, jersey barriers,
  rounded train bodies with glass bands, AC units and bogies, wet puddles.
- A smooth articulated runner: lathe torso, hood, capsule limbs with hips,
  knees, shoulders and elbows driven by a run cycle.
- Screen-space ambient occlusion inside the HDR half-float pipeline, Unreal
  bloom, a film grade pass (ACES, chromatic aberration, vignette, grain, hit
  flash) and FXAA.
- Sections alternate between brick tunnel and a tiled station platform with
  columns, benches, a vending machine and a "BALLAST ST" sign.

## Building

`index.html` is generated from `src/game.html` by `tools/build.mjs`, which
inlines the assets:

```
npm i @pmndrs/assets@1.7.0
node tools/build.mjs
```

Best score is kept in `localStorage` under `ballastrun.best`.
