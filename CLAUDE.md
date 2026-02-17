# img-voronoi

Interactive Voronoi diagram visualization from images. Dual-platform: **React/Vite web app** + **Rust CLI** for video rendering.

## Project Structure

```
src/                          # Web app (React/TS/Vite)
  components/
    ImageVoronoi.tsx          # Main UI: canvas, controls, animation, image loading
    ImageGallery.tsx           # Always-visible collapsible image gallery
  voronoi/
    VoronoiDrawer.ts          # CPU Voronoi (bucket-queue flood fill)
    VoronoiWebGL.ts           # WebGL acceleration (cone rendering)
    ChoosePoints.ts           # Brightness-weighted site sampling
  storage/ImageStorage.ts     # OPFS image persistence
  utils/random.ts             # Mulberry32 seeded PRNG

cli/                          # Rust CLI
  voronoi-cli/src/main.rs     # CLI entry: phases, ffmpeg encoding, progress
  voronoi-core/src/
    lib.rs                    # Public API exports
    voronoi.rs                # ComputeBackend trait, VoronoiResult
    site.rs                   # Site, SiteCollection, SplitStrategy, physics
    cpu.rs                    # Rayon parallel backend + spatial grid
    gpu.rs                    # wgpu/WGSL compute shader backend
```

## Web App

- Dev server: port **5184** (`pnpm dev`)
- Deployed to **[voro.rbw.sh]** via GitHub Pages (GHA builds WASM + Vite)
- URL params via `use-prms/hash`: `s` (seed), `n` (sites), `i` (inverse), `v` (speed), `g` (WebGL), `d` (doubling time), `w` (WASM), `cp` (centroid pull), `th` (O-U theta), `si` (O-U sigma)
- Keyboard shortcuts via `use-kbd`
- MUI Tooltips throughout
- Gallery sidebar (always visible, collapsible): OPFS-backed image storage with thumbnails, auto-seeds `sample.jpg`/`sample2.jpg` on first visit

[voro.rbw.sh]: https://voro.rbw.sh

## CLI

- Build/run from `cli/` directory: `cargo build --release`, `cargo run --release -- ...`
- Phase specs: `-p n=<sites>,dt=<secs>` (grow), `-p t=<secs>` (hold), `-p fade=<secs>` (crossfade to image)
- YAML spec files via `--spec`
- Output: MP4 (via ffmpeg) or GIF

## Dev Notes

- The web app and CLI share the same algorithmic ideas but have independent implementations (TS vs Rust).
- `demos/` and `specs/` are untracked workspace dirs.
