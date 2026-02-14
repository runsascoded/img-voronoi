//! CPU-based Voronoi computation using Rayon for parallelism.

use rayon::prelude::*;
use crate::{Position, Rgb, Result, VoronoiError, VoronoiResult};
use crate::voronoi::ComputeBackend;

/// CPU backend using Rayon for parallel computation
pub struct CpuBackend {
    /// Number of threads to use (0 = Rayon default)
    pub num_threads: usize,
}

impl CpuBackend {
    pub fn new() -> Self {
        Self { num_threads: 0 }
    }

    pub fn with_threads(num_threads: usize) -> Self {
        Self { num_threads }
    }
}

impl Default for CpuBackend {
    fn default() -> Self {
        Self::new()
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

        let width = image.width();
        let height = image.height();
        let num_pixels = (width * height) as usize;
        let num_sites = sites.len();

        // Build spatial grid for O(1)-amortized nearest-site lookup
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

        // Phase 1: Assign each pixel to nearest site using grid (parallel over rows)
        let grid_ref = &grid;
        let cell_of: Vec<i32> = (0..height)
            .into_par_iter()
            .flat_map(|y| {
                let py = y as f32 + 0.5;
                let gr = ((py / gcell_h) as usize).min(grid_rows - 1);
                let oy = py - gr as f32 * gcell_h;

                let mut row = Vec::with_capacity(width as usize);
                for x in 0..width {
                    let px = x as f32 + 0.5;
                    let gc = ((px / gcell_w) as usize).min(grid_cols - 1);
                    let ox = px - gc as f32 * gcell_w;

                    let mut min_dist = f32::INFINITY;
                    let mut nearest = 0i32;

                    // Search expanding rings of grid cells
                    for radius in 0u32.. {
                        let r = radius as usize;
                        let r_start = gr.saturating_sub(r);
                        let r_end = (gr + r + 1).min(grid_rows);
                        let c_start = gc.saturating_sub(r);
                        let c_end = (gc + r + 1).min(grid_cols);

                        for ri in r_start..r_end {
                            for ci in c_start..c_end {
                                // Skip interior cells (already checked at smaller radius)
                                if radius > 0
                                    && ri > r_start && ri < r_end - 1
                                    && ci > c_start && ci < c_end - 1
                                {
                                    continue;
                                }
                                for &site_idx in &grid_ref[ri * grid_cols + ci] {
                                    let site = &sites[site_idx as usize];
                                    let dx = px - site.x as f32;
                                    let dy = py - site.y as f32;
                                    let dist = dx * dx + dy * dy;
                                    if dist < min_dist {
                                        min_dist = dist;
                                        nearest = site_idx as i32;
                                    }
                                }
                            }
                        }

                        // Early exit: if nearest site is closer than the nearest
                        // unchecked grid cell boundary, we're done.
                        let rf = radius as f32;
                        let min_unchecked = (ox + rf * gcell_w)
                            .min(gcell_w * (rf + 1.0) - ox)
                            .min(oy + rf * gcell_h)
                            .min(gcell_h * (rf + 1.0) - oy);
                        if min_dist <= min_unchecked * min_unchecked {
                            break;
                        }
                        // Safety: checked all grid cells
                        if r_start == 0 && c_start == 0
                            && r_end == grid_rows && c_end == grid_cols
                        {
                            break;
                        }
                    }

                    row.push(nearest);
                }
                row
            })
            .collect();

        // Phase 2: Accumulate colors, positions, and areas per cell (parallel reduction)
        // Thread-local accumulators then merge
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
}
