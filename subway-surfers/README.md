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
- Canvas-generated concrete, ballast gravel with a derived normal map, sooty
  brick, glazed station tile, rusted steel, brushed-steel train sides with lit
  windows, hazard stripes, chain-link, graffiti decals and station signage.
- PMREM environment for reflections on rails, coins and train bodies, one
  shadow-casting key light that tracks the runner, and recycled point lights
  that snap to the nearest sodium or fluorescent fixtures.
- HDR half-float pipeline, Unreal bloom on the lamps and coins, then a film
  grade pass: ACES tone curve, chromatic aberration that grows with speed,
  vignette, grain and a red hit flash.
- Sections alternate between brick tunnel and a tiled station platform with
  columns, benches, a vending machine and a "BALLAST ST" sign.

Best score is kept in `localStorage` under `ballastrun.best`.
