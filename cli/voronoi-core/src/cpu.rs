//! CPU-based Voronoi computation using Rayon for parallelism.

use rayon::prelude::*;
use crate::{Position, Rgb, Result, VoronoiError, VoronoiResult};
use crate::voronoi::ComputeBackend;

/// CPU backend using Rayon for parallel computation
pub struct CpuBackend {
    /// Number of threads to use (0 = Rayon default)
    pub num_threads: usize,
    /// Use merged single-pass computation (phases 1+2+4 combined)
    pub merged: bool,
}

impl CpuBackend {
    pub fn new() -> Self {
        Self { num_threads: 0, merged: true }
    }

    pub fn with_threads(num_threads: usize) -> Self {
        Self { num_threads, merged: true }
    }

    /// Create a backend using the legacy multi-pass implementation (for benchmarking)
    pub fn new_multi_pass() -> Self {
        Self { num_threads: 0, merged: false }
    }
}

impl Default for CpuBackend {
    fn default() -> Self {
        Self::new()
    }
}

/// Per-row accumulator for the merged single-pass computation
struct RowAccum {
    r_sums: Vec<u64>,
    g_sums: Vec<u64>,
    b_sums: Vec<u64>,
    x_sums: Vec<u64>,
    y_sums: Vec<u64>,
    areas: Vec<u32>,
    farthest_pos: Position,
    farthest_dist: f64,
}

impl RowAccum {
    fn new(num_sites: usize) -> Self {
        Self {
            r_sums: vec![0u64; num_sites],
            g_sums: vec![0u64; num_sites],
            b_sums: vec![0u64; num_sites],
            x_sums: vec![0u64; num_sites],
            y_sums: vec![0u64; num_sites],
            areas: vec![0u32; num_sites],
            farthest_pos: Position::new(0.0, 0.0),
            farthest_dist: 0.0,
        }
    }

    fn merge(mut self, other: Self) -> Self {
        let n = self.r_sums.len();
        for i in 0..n {
            self.r_sums[i] += other.r_sums[i];
            self.g_sums[i] += other.g_sums[i];
            self.b_sums[i] += other.b_sums[i];
            self.x_sums[i] += other.x_sums[i];
            self.y_sums[i] += other.y_sums[i];
            self.areas[i] += other.areas[i];
        }
        if other.farthest_dist > self.farthest_dist {
            self.farthest_pos = other.farthest_pos;
            self.farthest_dist = other.farthest_dist;
        }
        self
    }
}

impl CpuBackend {
    /// Build the spatial grid for O(1)-amortized nearest-site lookup
    fn build_grid(
        sites: &[Position], width: u32, height: u32,
    ) -> (Vec<Vec<u32>>, usize, usize, f32, f32) {
        let num_sites = sites.len();
        let grid_side = (num_sites as f64).sqrt().ceil() as usize;
        let grid_cols = grid_side.max(1);
        let grid_rows = grid_side.max(1);
        let gcell_w = width as f32 / grid_cols as f32;
        let gcell_h = height as f32 / grid_rows as f32;

        let mut grid: Vec<Vec<u32>> = vec![Vec::new(); grid_cols * grid_rows];
        for (i, site) in sites.iter().enumerate() {
            let gc = ((site.x as f32 / gcell_w) as usize).min(grid_cols - 1);
            let gr = ((site.y as f32 / gcell_h) as usize).min(grid_rows - 1);
            grid[gr * grid_cols + gc].push(i as u32);
        }
        (grid, grid_cols, grid_rows, gcell_w, gcell_h)
    }

    /// Find nearest site for a pixel using expanding ring grid search.
    /// Returns (nearest_site_index, squared_distance_f32).
    #[inline]
    fn nearest_site(
        px: f32, py: f32,
        grid: &[Vec<u32>], grid_cols: usize, grid_rows: usize,
        gcell_w: f32, gcell_h: f32,
        sites: &[Position],
    ) -> (u32, f32) {
        let gc = ((px / gcell_w) as usize).min(grid_cols - 1);
        let gr = ((py / gcell_h) as usize).min(grid_rows - 1);
        let ox = px - gc as f32 * gcell_w;
        let oy = py - gr as f32 * gcell_h;

        let mut min_dist = f32::INFINITY;
        let mut nearest = 0u32;

        for radius in 0u32.. {
            let r = radius as usize;
            let r_start = gr.saturating_sub(r);
            let r_end = (gr + r + 1).min(grid_rows);
            let c_start = gc.saturating_sub(r);
            let c_end = (gc + r + 1).min(grid_cols);

            for ri in r_start..r_end {
                for ci in c_start..c_end {
                    if radius > 0
                        && ri > r_start && ri < r_end - 1
                        && ci > c_start && ci < c_end - 1
                    {
                        continue;
                    }
                    for &site_idx in &grid[ri * grid_cols + ci] {
                        let site = &sites[site_idx as usize];
                        let dx = px - site.x as f32;
                        let dy = py - site.y as f32;
                        let dist = dx * dx + dy * dy;
                        if dist < min_dist {
                            min_dist = dist;
                            nearest = site_idx;
                        }
                    }
                }
            }

            let rf = radius as f32;
            let min_unchecked = (ox + rf * gcell_w)
                .min(gcell_w * (rf + 1.0) - ox)
                .min(oy + rf * gcell_h)
                .min(gcell_h * (rf + 1.0) - oy);
            if min_dist <= min_unchecked * min_unchecked {
                break;
            }
            if r_start == 0 && c_start == 0
                && r_end == grid_rows && c_end == grid_cols
            {
                break;
            }
        }

        (nearest, min_dist)
    }

    /// Merged single-pass: nearest-site assignment + accumulation + farthest point
    fn compute_merged(
        &self,
        image: &image::RgbImage,
        sites: &[Position],
    ) -> Result<VoronoiResult> {
        let width = image.width();
        let height = image.height();
        let num_sites = sites.len();

        let (grid, grid_cols, grid_rows, gcell_w, gcell_h) =
            Self::build_grid(sites, width, height);
        let grid_ref = &grid;
        let img_raw = image.as_raw();

        // Single pass: parallel over rows, each row produces cell_of + accumulators
        let (cell_of, accum) = (0..height)
            .into_par_iter()
            .fold(
                || (Vec::with_capacity(0), RowAccum::new(num_sites)),
                |(mut cells, mut acc), y| {
                    let py = y as f32 + 0.5;
                    let row_offset = (y * width) as usize;

                    for x in 0..width {
                        let px = x as f32 + 0.5;
                        let (nearest, dist_sq) = Self::nearest_site(
                            px, py, grid_ref, grid_cols, grid_rows,
                            gcell_w, gcell_h, sites,
                        );
                        let cell = nearest as usize;

                        cells.push(nearest as i32);

                        // Accumulate color/position/area (inline Phase 2)
                        let px_offset = (row_offset + x as usize) * 3;
                        acc.r_sums[cell] += img_raw[px_offset] as u64;
                        acc.g_sums[cell] += img_raw[px_offset + 1] as u64;
                        acc.b_sums[cell] += img_raw[px_offset + 2] as u64;
                        acc.x_sums[cell] += x as u64;
                        acc.y_sums[cell] += y as u64;
                        acc.areas[cell] += 1;

                        // Track farthest point (inline Phase 4)
                        let dist_f64 = dist_sq as f64;
                        if dist_f64 > acc.farthest_dist {
                            acc.farthest_dist = dist_f64;
                            acc.farthest_pos = Position::new(
                                x as f64 + 0.5, y as f64 + 0.5,
                            );
                        }
                    }
                    (cells, acc)
                },
            )
            .reduce(
                || (Vec::new(), RowAccum::new(num_sites)),
                |(mut cells1, acc1), (cells2, acc2)| {
                    cells1.extend(cells2);
                    (cells1, acc1.merge(acc2))
                },
            );

        // Phase 3: Compute average colors and centroids (sequential, O(num_sites))
        let mut cell_colors: Vec<Rgb> = Vec::with_capacity(num_sites);
        let mut cell_centroids: Vec<Position> = Vec::with_capacity(num_sites);
        for i in 0..num_sites {
            let count = accum.areas[i] as u64;
            if count > 0 {
                cell_colors.push([
                    (accum.r_sums[i] / count) as u8,
                    (accum.g_sums[i] / count) as u8,
                    (accum.b_sums[i] / count) as u8,
                ]);
                cell_centroids.push(Position::new(
                    accum.x_sums[i] as f64 / count as f64,
                    accum.y_sums[i] as f64 / count as f64,
                ));
            } else {
                cell_colors.push([128, 128, 128]);
                cell_centroids.push(sites[i]);
            }
        }

        Ok(VoronoiResult {
            cell_of,
            cell_colors,
            cell_areas: accum.areas,
            cell_centroids,
            farthest_point: accum.farthest_pos,
            width,
            height,
        })
    }

    /// Legacy multi-pass implementation (for benchmarking comparison)
    fn compute_multi_pass(
        &self,
        image: &image::RgbImage,
        sites: &[Position],
    ) -> Result<VoronoiResult> {
        let width = image.width();
        let height = image.height();
        let num_pixels = (width * height) as usize;
        let num_sites = sites.len();

        let (grid, grid_cols, grid_rows, gcell_w, gcell_h) =
            Self::build_grid(sites, width, height);
        let grid_ref = &grid;

        // Phase 1: Assign each pixel to nearest site using grid (parallel over rows)
        let cell_of: Vec<i32> = (0..height)
            .into_par_iter()
            .flat_map(|y| {
                let py = y as f32 + 0.5;
                let mut row = Vec::with_capacity(width as usize);
                for x in 0..width {
                    let px = x as f32 + 0.5;
                    let (nearest, _dist) = Self::nearest_site(
                        px, py, grid_ref, grid_cols, grid_rows,
                        gcell_w, gcell_h, sites,
                    );
                    row.push(nearest as i32);
                }
                row
            })
            .collect();

        // Phase 2: Accumulate colors, positions, and areas per cell (parallel reduction)
        let (r_sums, g_sums, b_sums, x_sums, y_sums, areas) = (0..num_pixels)
            .into_par_iter()
            .fold(
                || {
                    (
                        vec![0u64; num_sites],
                        vec![0u64; num_sites],
                        vec![0u64; num_sites],
                        vec![0u64; num_sites],
                        vec![0u64; num_sites],
                        vec![0u32; num_sites],
                    )
                },
                |(mut r, mut g, mut b, mut cx, mut cy, mut a), i| {
                    let cell = cell_of[i] as usize;
                    let x = (i % width as usize) as u32;
                    let y = (i / width as usize) as u32;
                    let pixel = image.get_pixel(x, y);

                    r[cell] += pixel[0] as u64;
                    g[cell] += pixel[1] as u64;
                    b[cell] += pixel[2] as u64;
                    cx[cell] += x as u64;
                    cy[cell] += y as u64;
                    a[cell] += 1;

                    (r, g, b, cx, cy, a)
                },
            )
            .reduce(
                || {
                    (
                        vec![0u64; num_sites],
                        vec![0u64; num_sites],
                        vec![0u64; num_sites],
                        vec![0u64; num_sites],
                        vec![0u64; num_sites],
                        vec![0u32; num_sites],
                    )
                },
                |(mut r1, mut g1, mut b1, mut cx1, mut cy1, mut a1),
                 (r2, g2, b2, cx2, cy2, a2)| {
                    for i in 0..num_sites {
                        r1[i] += r2[i];
                        g1[i] += g2[i];
                        b1[i] += b2[i];
                        cx1[i] += cx2[i];
                        cy1[i] += cy2[i];
                        a1[i] += a2[i];
                    }
                    (r1, g1, b1, cx1, cy1, a1)
                },
            );

        // Phase 3: Compute average colors and centroids
        let mut cell_colors: Vec<Rgb> = Vec::with_capacity(num_sites);
        let mut cell_centroids: Vec<Position> = Vec::with_capacity(num_sites);
        for i in 0..num_sites {
            let count = areas[i] as u64;
            if count > 0 {
                cell_colors.push([
                    (r_sums[i] / count) as u8,
                    (g_sums[i] / count) as u8,
                    (b_sums[i] / count) as u8,
                ]);
                cell_centroids.push(Position::new(
                    x_sums[i] as f64 / count as f64,
                    y_sums[i] as f64 / count as f64,
                ));
            } else {
                cell_colors.push([128, 128, 128]);
                cell_centroids.push(sites[i]);
            }
        }

        // Phase 4: Find point furthest from any site (parallel max reduction)
        let farthest_point = (0..num_pixels)
            .into_par_iter()
            .fold(
                || (Position::new(0.0, 0.0), 0.0f64),
                |(best_pos, best_dist), i| {
                    let cell = cell_of[i] as usize;
                    let x = (i % width as usize) as f64 + 0.5;
                    let y = (i / width as usize) as f64 + 0.5;
                    let dx = x - sites[cell].x;
                    let dy = y - sites[cell].y;
                    let dist = dx * dx + dy * dy;
                    if dist > best_dist { (Position::new(x, y), dist) } else { (best_pos, best_dist) }
                },
            )
            .reduce(
                || (Position::new(0.0, 0.0), 0.0f64),
                |(p1, d1), (p2, d2)| if d1 >= d2 { (p1, d1) } else { (p2, d2) },
            )
            .0;

        Ok(VoronoiResult {
            cell_of,
            cell_colors,
            cell_areas: areas,
            cell_centroids,
            farthest_point,
            width,
            height,
        })
    }
}

impl ComputeBackend for CpuBackend {
    fn compute(
        &mut self,
        image: &image::RgbImage,
        sites: &[Position],
    ) -> Result<VoronoiResult> {
        if sites.is_empty() {
            return Err(VoronoiError::NoSites);
        }
        if self.merged {
            self.compute_merged(image, sites)
        } else {
            self.compute_multi_pass(image, sites)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::site::{Site, SiteCollection, SplitStrategy, Velocity};

    #[test]
    fn test_basic_voronoi() {
        let mut backend = CpuBackend::new();
        let image = image::RgbImage::from_pixel(100, 100, image::Rgb([255, 0, 0]));
        let sites = vec![
            Position::new(25.0, 25.0),
            Position::new(75.0, 75.0),
        ];

        let result = backend.compute(&image, &sites).unwrap();

        assert_eq!(result.width, 100);
        assert_eq!(result.height, 100);
        assert_eq!(result.cell_colors.len(), 2);
        assert_eq!(result.cell_areas.len(), 2);
        assert_eq!(result.cell_centroids.len(), 2);

        // Both cells should have approximately half the pixels
        let total_area: u32 = result.cell_areas.iter().sum();
        assert_eq!(total_area, 10000);
    }

    /// Simulate the full animation loop on a small grid to diagnose clustering.
    /// Run with: cargo test -p voronoi-core test_split_clustering -- --nocapture
    #[test]
    fn test_split_clustering() {
        let mut backend = CpuBackend::new();
        let w = 100u32;
        let h = 100u32;
        let image = image::RgbImage::from_pixel(w, h, image::Rgb([128, 128, 128]));

        // 4 sites at quadrant centers — each should have ~2500px area
        let sites_vec = vec![
            Site::new(Position::new(25.0, 25.0), Velocity::from_angle(0.5)),
            Site::new(Position::new(75.0, 25.0), Velocity::from_angle(1.5)),
            Site::new(Position::new(25.0, 75.0), Velocity::from_angle(2.5)),
            Site::new(Position::new(75.0, 75.0), Velocity::from_angle(3.5)),
        ];
        let mut sites = SiteCollection::new(sites_vec, 42);

        let target = 16;
        let dt = 1.0 / 30.0;
        let speed = 15.0;
        let doubling_time = 1.0;
        let centroid_pull = 5.0;

        for frame in 0..90 {
            let positions = sites.positions();
            let result = backend.compute(&image, &positions).unwrap();
            let areas = &result.cell_areas;

            sites.step(
                speed, dt, w as f64, h as f64,
                Some(&result.cell_centroids), centroid_pull,
            );

            let max_area = *areas.iter().max().unwrap();
            let min_nonzero = *areas.iter().filter(|&&a| a > 0).min().unwrap_or(&0);
            let num_zero = areas.iter().filter(|&&a| a == 0).count();

            eprintln!(
                "frame={:3} sites={:3} max={:5} min_nz={:5} zeros={} areas={:?}",
                frame, sites.len(), max_area, min_nonzero, num_zero, areas,
            );

            if target != sites.len() {
                let (added, _removed) = sites.adjust_count(
                    target, doubling_time, dt, Some(areas),
                    SplitStrategy::Max, Some(&result.cell_centroids),
                    Some(result.farthest_point),
                );
                if !added.is_empty() {
                    for &child_idx in &added {
                        let child = &sites.sites[child_idx];
                        eprintln!(
                            "  -> split: child idx={} at ({:.1},{:.1})",
                            child_idx, child.pos.x, child.pos.y,
                        );
                    }
                }
            }
        }

        // Final check
        let positions = sites.positions();
        let result = backend.compute(&image, &positions).unwrap();
        let max_area = *result.cell_areas.iter().max().unwrap();
        let min_nonzero = *result.cell_areas.iter().filter(|&&a| a > 0).min().unwrap_or(&1);
        let ratio = max_area as f64 / min_nonzero as f64;
        eprintln!(
            "FINAL: {} sites, max={}, min_nz={}, ratio={:.1}",
            sites.len(), max_area, min_nonzero, ratio,
        );

        // With 16 sites on 100x100, ideal area is 625.
        // Ratio should be reasonable (< 5x)
        assert!(
            ratio < 5.0,
            "Area ratio {:.1} too high: max={} min_nz={}",
            ratio, max_area, min_nonzero,
        );
    }

    /// Verify merged and multi-pass produce identical results
    #[test]
    fn test_merged_vs_multi_pass() {
        use rand::Rng;

        let w = 640u32;
        let h = 480u32;
        // Non-trivial image: gradient
        let mut img = image::RgbImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.put_pixel(x, y, image::Rgb([
                    (x * 255 / w) as u8,
                    (y * 255 / h) as u8,
                    128,
                ]));
            }
        }

        let mut rng = rand::thread_rng();
        let sites: Vec<Position> = (0..50)
            .map(|_| Position::new(
                rng.gen_range(0.0..w as f64),
                rng.gen_range(0.0..h as f64),
            ))
            .collect();

        let mut merged = CpuBackend::new();
        let mut multi = CpuBackend::new_multi_pass();

        let r_merged = merged.compute(&img, &sites).unwrap();
        let r_multi = multi.compute(&img, &sites).unwrap();

        assert_eq!(r_merged.cell_of, r_multi.cell_of, "cell_of mismatch");
        assert_eq!(r_merged.cell_colors, r_multi.cell_colors, "cell_colors mismatch");
        assert_eq!(r_merged.cell_areas, r_multi.cell_areas, "cell_areas mismatch");
        assert_eq!(r_merged.cell_centroids.len(), r_multi.cell_centroids.len());
        for (i, (a, b)) in r_merged.cell_centroids.iter()
            .zip(r_multi.cell_centroids.iter()).enumerate()
        {
            assert!(
                (a.x - b.x).abs() < 1e-10 && (a.y - b.y).abs() < 1e-10,
                "centroid[{}] mismatch: {:?} vs {:?}", i, a, b,
            );
        }
    }
}
