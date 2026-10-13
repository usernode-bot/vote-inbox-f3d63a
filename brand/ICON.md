# Vote Inbox icon

Vote Inbox's brand icon: an inbox tray with a ballot checkmark dropping into it.
Used for the app's home-screen tile (`dapp.json` → `icon.image`) and, drawn larger,
for the app's featured icon in the Homeroom directory.

Brand framework: https://baked.design/brand/homeroom/ (the group's own brand
artwork is used here in place of the platform's default gradient icon style,
which defers to a group's chosen artwork).

## The mark

A custom Lucide-style glyph drawn on the 24-unit grid with 2-unit round strokes
and no fill (same line style as the [Lucide](https://lucide.dev) icons, ISC
licence): an open inbox tray with a checkmark just above it, as if a ballot is
dropping in.

```svg
<path d="M8 6.5l3 3 5-6"/>
<path d="M3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>
<path d="M3 13h5l1.5 2.5h5L16 13h5"/>
```

## Colours

| Image | Background | Mark | Pairing |
| --- | --- | --- | --- |
| `icon.png` | Black `#000000` | Cream `#FFFEEA` | Cream + Black |
| `featured-light.png` | Cream `#FFFEEA` | Black `#000000` | Cream + Black |
| `featured-dark.png` | Black `#000000` | Cream `#FFFEEA` | Cream + Black |

Two flat colours per image. No gradients, no shadows, no text.

## Sources and rendering

The icon SVG (1024×1024, full-bleed black, square corners; the platform rounds
the tile). The glyph group fills the middle 576 px:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="#000000"/>
  <g transform="translate(224 224) scale(24)" fill="none" stroke="#FFFEEA"
     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 6.5l3 3 5-6"/>
    <path d="M3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>
    <path d="M3 13h5l1.5 2.5h5L16 13h5"/>
  </g>
</svg>
```

The featured SVGs (1600×900, full-bleed background, the same mark centred —
group `translate(512 162) scale(24)`, glyph box 576×576). Light has background
`#FFFEEA` with stroke `#000000`; dark has background `#000000` with stroke
`#FFFEEA`.

Render (nothing is added to `package.json`; the SVGs live outside the repo):

```sh
npx --yes @resvg/resvg-js-cli --no-system-font icon.svg brand/icon.png
npx --yes @resvg/resvg-js-cli --no-system-font featured-light.svg brand/featured-light.png
npx --yes @resvg/resvg-js-cli --no-system-font featured-dark.svg brand/featured-dark.png
```

`icon.png` must stay ≤ 256 KB (the platform's icon limit); these renders are
~14 KB. It stays legible down to 32 px: the checkmark clears the tray lip.

## Featured icons

`featured-light.png` and `featured-dark.png` are the larger featured versions
for the app's place in the Homeroom directory. No `dapp.json` field points to
them (none is documented), so they are committed here as brand files only.
The app icon's `emoji: "📥"` stays declared as the fallback if the image ever
fails validation.
