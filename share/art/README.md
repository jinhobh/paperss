# Ink artwork

`source/pines-01.png` was generated with the built-in OpenAI image-generation
tool on 2026-07-20 for this personal desktop. The deterministic two-tone files
under `processed/` were produced locally with ImageMagick and are the only
versions consumed by `poster`.

## Prompt

Use case: stylized-concept

Asset type: source artwork for a dark UNIX desktop wallpaper collage

Input image: the supplied light UNIX desktop screenshot was a style and
composition reference only; its exact landscape and layout were not reproduced.

Create an original stark monochrome ink landscape with wind-bent pine branches,
eroded rock, and sweeping abstract negative space. Isolate the natural forms on
a completely plain white paper field. Use traditional black sumi-e ink,
woodcut-like high contrast, rough xerographic texture, irregular handmade marks,
and a wide composition whose ink mass begins near the lower-left and sweeps
toward the center-right. Use pure black ink and white paper only. Include no UI,
frames, typography, symbols, people, buildings, logos, or watermark.

## Processing

```sh
magick source/pines-01.png -colorspace Gray -resize 2800x1600 \
  -auto-level -ordered-dither o8x8,2 processed/pines-01-main.png
```

The detail view is a crop of the same source, keeping both wallpaper images
visually related without duplicating the complete composition.
