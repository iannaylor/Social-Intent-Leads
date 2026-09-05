# Embedded assets

`index.html` inlines the following CC0 assets from the
[@pmndrs/assets](https://github.com/pmndrs/assets) package (v1.7.0), base64 encoded:

- `hdri/warehouse.exr` (Poly Haven, CC0) for image based lighting and reflections.
- `normals/0001, 0002, 0004, 0005, 0006, 0008, 0016, 0018, 0025, 0027` (emmelleppi/normal-maps, CC0).

Every other texture is generated procedurally at load time. Fonts are loaded from Google Fonts.
Three.js r128 and its example passes are loaded from cdnjs and jsDelivr.

# Street mode imagery

Street mode fetches imagery at run time and does not embed it. Google Street View
images come from the Street View Static API and are shown with the "Google Street
View" credit in the corner label, subject to the Google Maps Platform terms. Mapillary
360° photos are CC BY-SA 4.0 from their contributors and are credited the same way.

# Car model

`car.glb` is the Ferrari 458 Italia model by vicent091036 (CC BY 4.0), as shipped with the
three.js examples (`examples/models/gltf/ferrari.glb`), welded, simplified and Draco compressed
for this game; `car_ao.png` is its baked ground shadow from the same examples. The Draco decoder
is loaded from jsDelivr at run time.
