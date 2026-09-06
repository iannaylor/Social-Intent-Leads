# Local Surfer

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
neighbouring panoramas, so the run follows the road exactly. The road ahead is
fitted to the next four panoramas (their link headings and spacing) and the game
road bends to that curve, with the eye walking along it and the photo turned to
match, so the road in the picture and the road under your feet stay one road; four Street View
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
458 model, see ATTRIBUTION.md), hurdles and gates, and two pickups every few hundred metres: glowing orange
WINGS (seven seconds of a high, floaty jump that clears the cars, and double
points) and a red horseshoe MAGNET (ten seconds of coins pulled to you).

## Leaderboards

After every run the end card shows where the score lands: in your town (or
area), your county and the world, with a "this week" note when it is a top-ten
weekly score. LEADERBOARDS on the start and end cards opens the boards:
WORLD, UK (or your country), county, town and postcode area, all time or this
week, best run per player. Only street runs are recorded, on every board of the place you started from.
The tunnel is for practice and never reaches the boards.

The first run's end card asks for a name (2 to 14 characters). Runs are tied to a
random key kept in the browser, so there is no sign-up. CHANGE NAME and REMOVE
MY SCORES live in the boards panel.

The backend is a Supabase project; the client talks only to the SQL functions
in `supabase/schema.sql` (tables are behind row-level security with no direct
access). To set it up, or move it to your own project:

1. Create a Supabase project, open SQL Editor, paste `supabase/schema.sql`,
   Run. It is safe to run again after edits.
2. Put the project URL and the publishable (anon) key in the config block at
   the top of `src/game.html` (`supabaseUrl`, `supabaseKey`) and rebuild. The
   key is public by design.
3. Places come from postcodes.io for UK runs and Google's geocoder elsewhere,
   both looked up once at street start.

SHARE on the end card opens the phone's share sheet (or, on a desktop, links to
X, Facebook, WhatsApp, Telegram, LinkedIn, Reddit and email, plus copy and a
saved image) with your best position, a generated card image and a link that
starts a friend on the same street (`?pc=` or `?at=lat,lon&name=`, with `?by=`
naming who set the challenge). `share.jpg` is the link preview image, cropped
from the poster artwork; `splash-land.jpg` and `splash-port.jpg` (and the `-s`
phone sizes) are the loading splash and the backdrop of the start card.

`submit_run` rejects practice (tunnel) runs and runs that are faster than the game allows, score more than
the distance and coins could earn, or arrive more than once every six seconds,
and caps a device at 300 runs a day.

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

### Custom domain (localsurfer.app)

GitHub Pages serves the site at the domain once two things are done:

1. **DNS at the registrar.** For the apex `localsurfer.app` add four A records
   (185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153) and
   four AAAA records (2606:50c0:8000::153, 2606:50c0:8001::153,
   2606:50c0:8002::153, 2606:50c0:8003::153). For `www` add a CNAME record
   pointing at `iannaylor.github.io`.
2. **GitHub.** Repository → Settings → Pages → Custom domain: enter
   `localsurfer.app`, Save, wait for the DNS check to pass, then tick
   Enforce HTTPS once the certificate has been issued (a few minutes to an
   hour). `.app` domains only work over HTTPS, so this step is required.

The site then lives at `https://localsurfer.app/` and the old address
redirects to it. Because the page is deployed by a GitHub Actions workflow,
no CNAME file is needed in the repository. Remember to add
`https://localsurfer.app/*` and `https://www.localsurfer.app/*` to the Google
Maps key's website restrictions, or Street View will be refused on the new
address.

