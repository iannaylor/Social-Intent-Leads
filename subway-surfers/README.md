# Indi’s Wipeout

A photorealistic-styled, Subway Surfers-inspired endless runner that lives in a
single HTML file. Open `index.html` in any modern browser (Chrome, Edge, Safari,
Firefox) or serve the folder statically. No build step, no assets to download:
every texture is generated procedurally on a canvas at load time.

## View and character

The game plays in first person by default, like the subway FPS it was inspired
by, so the environment is the whole picture. The procedural stand-in runner is
never shown. To get a third-person chase camera with a real character, put a
rigged glTF binary named `runner.glb` next to `index.html` (or pass
`?runner=URL`). Mixamo or Ready Player Me exports work: the loader scales the
model to 1.78 m, faces it down the track, and picks animation clips whose names
contain `run`, `jump`, `roll` and `idle`. Press V to switch cameras once it has
loaded.

## Street mode

Tick **STREET MODE** on the start card, type a postcode or address (or press
MY LOCATION), and the run moves from the tunnel onto a real 3D street: tarmac
with markings, kerbs, pavements, garden walls and hedges, lamp posts, bins and
parked cars as lane blockers. Around it, real photos of the chosen area form the
sky and skyline: Google Street View is used first. The Maps JavaScript API's
Street View service gives each panorama's true facing and its links to the
neighbouring panoramas, so the run follows the road exactly; four Street View
Static API views of each panorama (ahead, left, right, up) are mapped onto a box
around the camera, and the picture drifts forward and cross-fades to the next
panorama every 150 m of running. If the JavaScript API is unavailable the game
falls back to probing the Static API's metadata for nearby panoramas. If no Google
key is configured, 360° photos from [Mapillary](https://www.mapillary.com) are
used instead. Places with no coverage at all run with a plain sky and say so.

The Google Maps key and the Mapillary client token are built into the page
(`window.INDI_CONFIG`); different ones can be passed as `?gkey=KEY` and
`?mly=TOKEN`. Restrict the Google key to the site's referrer and to the Street
View Static API in the Google Cloud console. Place lookup uses postcodes.io for
UK postcodes and Nominatim for anything else, so Street mode needs a hosted
copy rather than the Claude artifact frame. `?pc=SW1A%201AA` pre-fills a place.

Street mode has its own hazards and rewards: real parked cars (a CC BY Ferrari
458 model, see ATTRIBUTION.md), hurdles and gates, and a glowing TURBO can every
few hundred metres that gives seven seconds of double points, a super jump that
clears the cars, and a coin magnet.

### Hosting on GitHub Pages

`.github/workflows/pages.yml` publishes this folder to GitHub Pages on every
push. Enable it once in the repository: Settings, Pages, Build and deployment,
Source: GitHub Actions. The game is then at
`https://<owner>.github.io/<repo>/`.

## Controls

| Action        | Keyboard                 | Touch        |
| ------------- | ------------------------ | ------------ |
| Change track  | Left / Right, A / D      | Swipe left / right |
| Jump          | Up, W, Space             | Swipe up     |
| Roll / drop   | Down, S                  | Swipe down   |
| Start / retry | Space or Enter, button   | Tap          |
| Camera        | V (with `runner.glb`)    |              |

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
  columns, benches, a vending machine and an "INDI ST" sign.

## Building

`index.html` is generated from `src/game.html` by `tools/build.mjs`, which
inlines the assets:

```
npm i @pmndrs/assets@1.7.0
node tools/build.mjs
```

Best score is kept in `localStorage` under `indiswipeout.best`.
