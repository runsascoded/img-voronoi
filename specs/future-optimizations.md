# Future Optimizations

## Incremental Frame Updates

### Problem
Each frame recomputes the entire Voronoi diagram from scratch. At 30fps with small step sizes, the vast majority of pixels remain in the same cell frame-to-frame. Only pixels near cell boundaries (where sites have shifted) actually change assignment.

### Approach
- Track cell boundaries from previous frame
- On new frame, only re-evaluate pixels within some distance of where sites moved
- "Dirty region" approach: mark grid cells as dirty when a site moves through them, only recompute affected pixels
- Could also detect when a pixel's nearest-site distance increased (suggesting its site moved away) vs decreased (suggesting a new site moved closer)

### Key challenges
- Determining the dirty region correctly (must not miss any pixel that changed)
- Site spawning/removal invalidates large regions at once
- Parallel decomposition changes (can't easily parallelize over rows if only scattered pixels need updating)
- May need a different data structure than flat `cell_of: Vec<i32>` — perhaps a quadtree or tile-based approach where tiles track their dominant cell and only recompute boundary tiles

### Expected impact
Very high for smooth animations. At 12,800 sites on a 1280x964 image, each frame moves sites by ~0.5px. Boundary region might be ~5% of pixels, giving ~20x speedup on the assignment phase. Less impact during rapid growth (many spawns per frame).

### Complexity
High. Needs careful correctness validation (diff against full recompute). Probably want a `--incremental` flag with fallback to full recompute, plus a verification mode that does both and asserts equality.

---

## Probabilistic Poisson Splitting

### Problem
The binary distance-threshold split strategy (already implemented as `SplitStrategy::Poisson`) gates splits on whether `nn_dist > threshold_k * sqrt(area/n)`. This works well but can still cause minor bursts when multiple sites cross the threshold in the same frame.

### Approach
Add a true probabilistic rate: instead of binary eligible/not-eligible, compute split probability proportional to how far above threshold a site is:

```
P = 1 - exp(-λ * (dist - threshold) * dt)
```

This spreads splits over time even when multiple sites are eligible simultaneously. λ controls rate; the binary case is the limit as λ→∞.

The λ parameter is already parsed in `SplitStrategy::Poisson(threshold_k, lambda)` but not used in `adjust_count()`.

### Expected impact
Smoother growth at the margin — noticeable mostly at low frame rates or during rapid expansion phases. The binary variant already handles most cases well.

### Complexity
Low. The NN distances and threshold are already computed; just need to replace the binary eligibility check with a probabilistic one using the existing λ parameter.

---

## Scale-Invariant Units

### Problem
`speed` is in raw pixels/sec, so behavior changes with image resolution. Similarly, centroid pull strength and split thresholds are resolution-dependent.

### Approach
Normalize to viewport-relative units:
- Speed in `vmin/s` (fraction of min(width, height) per second) — e.g. `speed=0.01` means 1% of the shorter dimension per second
- Split threshold in same units
- Centroid pull strength could also benefit from normalization
- Backward-compatible: detect raw-pixel values (>1.0) vs normalized values (<1.0), or add explicit `--units px|vmin` flag

### Expected impact
Consistent visual behavior across resolutions. Spec files and presets become resolution-independent.

### Complexity
Low-medium. Mostly unit conversion plumbing throughout the physics code.

---

## Guided Collapse / Loop Mode

### Problem
For seamless looping animations, the last frame needs to match the first frame. Currently animations grow and shrink site counts but there's no way to guide sites back to their original positions while collapsing.

### Approach
Record the initial site positions at frame 0, then in a final "collapse" phase:
1. Reduce site count back to the starting number (removing youngest sites first, or sites farthest from any initial position)
2. Apply a "target pull" force that steers surviving sites toward their nearest initial position
3. As sites approach their targets and extra sites are removed, the animation converges to the starting frame

**Implementation:**
- `SiteCollection` stores `initial_positions: Vec<Position>` at construction
- New phase type: `collapse` or `loop` — combines site removal with target-pull
- Target assignment: Hungarian algorithm for optimal matching (O(n³) but n is small at collapse time), or greedy nearest-unmatched
- Pull force: similar to centroid pull but toward assigned target position instead of cell centroid. Strength ramps up as phase progresses.
- Site removal order: remove sites that aren't matched to any initial position first

**YAML spec:**
```yaml
phases:
  - n: 25600, dt: 1    # grow
  - t: 3                # hold
  - n: 25, dt: 1        # shrink
  - loop: 2             # 2s to guide remaining sites back to initial positions
```

### Considerations
- Need smooth interpolation — don't want sites to teleport to targets
- The match between final surviving sites and initial positions may not be 1:1 if sites have drifted far; may need to allow some position discontinuity at the loop point
- Could also use this for "morph" transitions between two different site configurations
- Easing function for the pull strength (ease-in-out) would look more natural

### Expected impact
Enables seamless looping for backgrounds, screensavers, social media content. High visual value.

### Complexity
Medium. The target-pull force is straightforward (similar to centroid pull). The tricky parts are site-to-target matching and ensuring smooth convergence without jitter at the seam.

---

## Completed

### Rust-WASM Unification
Shared `voronoi-core` crate compiles to both native (CLI via `voronoi-cli`) and WASM (web via `voronoi-wasm`). Web frontend loads WASM on startup, uses it for all compute when enabled. Single-threaded WASM backend uses `CpuBackend` with `default-features = false`. All physics (steering, centroid pull, site dynamics) live in shared Rust code.

### GPU Grid Index
GPU backend (`gpu.rs`) implements grid-based expanding-ring search in WGSL compute shader, matching the CPU algorithm. Grid structure uploaded as two storage buffers (`grid_offsets`, `grid_indices`). Each GPU thread does O(√n) expanding-ring search with early exit. Available via `--gpu` flag in CLI.

### Binary Distance-Threshold Splitting
`SplitStrategy::Poisson(threshold_k, lambda)` gates exponential growth by nearest-neighbor distance. Sites only eligible to split when `nn_dist > threshold_k * sqrt(area/n)`. NN distances computed via O(n) grid-based search. Burst limiting caps buffered spawns per frame.

### Web Gallery Render Cache
LRU cache (8 entries) keyed by `imageId:seed:numSites:inversePP:scale`. Gallery switch checks cache first — on hit, reconstructs via `drawFromCellData` (~2ms) instead of full flood-fill (~200ms). Speculative pre-compute of prev/next neighbors via `requestIdleCallback`.
