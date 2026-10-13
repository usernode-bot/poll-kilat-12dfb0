# Quick Poll icon

The app icon and the featured artwork share one mark: three bar-chart
columns rising left to right, with a lightning bolt cut into the tallest
column. Flat vector shapes, no gradients, strokes or text, only Homeroom
brand colours.

## Files

| File | Canvas | Background | Mark | Use |
| --- | --- | --- | --- | --- |
| `icon.png` | 1024x1024, opaque, square corners | Yellow `#FFEE6F` | Black `#000000` | `icon.image` in `dapp.json`. Homeroom rounds the tile itself, so the canvas is full bleed. |
| `featured-light.png` | 1600x900, opaque | Cream `#FFFEEA` | Black `#000000` | Featured artwork for the Homeroom directory, light look. |
| `featured-dark.png` | 1600x900, opaque | Black `#000000` | Yellow `#FFEE6F` | Featured artwork for the Homeroom directory, dark look. |

Each PNG has an SVG source next to it with the same name. Only the app
icon is wired into the manifest; the featured artwork is a committed
asset ready for the directory (`icon.emoji` 📊 stays as the fallback).

## Mark geometry

On a 1024x1024 grid, mark colour M, background colour B:

```svg
<rect width="1024" height="1024" fill="B"/>
<rect x="184" y="544" width="176" height="256" rx="40" fill="M"/>
<rect x="424" y="400" width="176" height="400" rx="40" fill="M"/>
<rect x="664" y="224" width="176" height="576" rx="40" fill="M"/>
<polygon points="780,280 700,432 748,432 724,560 808,400 760,400 788,280" fill="B"/>
```

The mark spans x 184-840 and y 224-800, centred with at least 184 px of
margin. Bars are 176 px wide, so on a 32 px tile each column is about
5.5 px and the bolt notch still reads. For the featured canvases the
same group is translated by `(288, -62)` to centre on 1600x900.

## Rendering

The build sandbox has no `rsvg-convert`, ImageMagick or Pillow, so the
PNGs are rasterised with headless Chromium: the SVG is drawn onto a
canvas at the exact pixel size (1024x1024 / 1600x900, device scale
factor 1) and captured as a PNG. Each render was checked to be exactly
its canvas size, fully opaque, and to contain only the two palette
colours above plus anti-aliased edge pixels between them.
