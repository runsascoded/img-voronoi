# img-voronoi

Interactive Voronoi diagram visualization from images, with animated site physics and a Rust CLI for video rendering.

**[Live demo][demo]** | Originally forked from [txstc55/ImageVoronoi]

## Features

- **Voronoi from images**: brightness-weighted site sampling, CPU flood-fill and WebGL cone rendering
- **WASM backend**: Rust-compiled Voronoi compute with O-U physics (centroid pull, drift, wander)
- **Animation**: play/pause/step with configurable speed, doubling time for gradual site growth
- **Image gallery**: always-visible collapsible sidebar, OPFS storage with thumbnails, auto-seeds sample images on first visit
- **CLI video rendering**: Rust CLI with phase specs (grow, hold, fade), ffmpeg encoding, GPU compute shader backend

## Quick Start

```sh
pnpm install
pnpm dev        # http://localhost:5184
```

### CLI

```sh
cd cli
cargo build --release
cargo run --release -- -i image.jpg -o output.mp4 -p n=400,dt=5 -p t=2 -p fade=3
```

## Keyboard Shortcuts

Press `?` to open the omnibar (via [use-kbd]) showing all available shortcuts.

[demo]: https://voro.rbw.sh
[txstc55/ImageVoronoi]: https://github.com/txstc55/ImageVoronoi
[use-kbd]: https://github.com/runsascoded/use-kbd
