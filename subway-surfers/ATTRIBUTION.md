# Embedded assets

`index.html` inlines the following CC0 assets from the
[@pmndrs/assets](https://github.com/pmndrs/assets) package (v1.7.0), base64 encoded:

- `hdri/warehouse.exr` (Poly Haven, CC0) for image based lighting and reflections.
- `normals/0001, 0002, 0004, 0005, 0006, 0008, 0016, 0018, 0025, 0027` (emmelleppi/normal-maps, CC0).

Every other texture is generated procedurally at load time. Fonts are loaded from Google Fonts.
Three.js r128 and its example passes are loaded from cdnjs and jsDelivr.
