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

        // Phase 1: Assign each pixel to nearest site (parallel over rows)
        let cell_of: Vec<i32> = (0..height)
            .into_par_iter()
            .flat_map(|y| {
                let mut row = Vec::with_capacity(width as usize);
                for x in 0..width {
                    let px = x as f64;
                    let py = y as f64;

                    let mut min_dist = f64::INFINITY;
                    let mut nearest = 0i32;

                    for (i, site) in sites.iter().enumerate() {
                        let dx = px - site.x;
                        let dy = py - site.y;
                        let dist = dx * dx + dy * dy;
                        if dist < min_dist {
                            min_dist = dist;
                            nearest = i as i32;
                        }
                    }

                    row.push(nearest);
                }
                row
            })
            .collect();

        // Phase 2: Accumulate colors and areas per cell (parallel reduction)
        // We'll use thread-local accumulators then merge
        let (r_sums, g_sums, b_sums, areas) = (0..num_pixels)
            .into_par_iter()
            .fold(
                || {
                    (
                        vec![0u64; num_sites],
                        vec![0u64; num_sites],
                        vec![0u64; num_sites],
                        vec![0u32; num_sites],
                    )
                },
                |(mut r, mut g, mut b, mut a), i| {
                    let cell = cell_of[i] as usize;
                    let x = (i % width as usize) as u32;
                    let y = (i / width as usize) as u32;
                    let pixel = image.get_pixel(x, y);

                    r[cell] += pixel[0] as u64;
                    g[cell] += pixel[1] as u64;
                    b[cell] += pixel[2] as u64;
                    a[cell] += 1;

                    (r, g, b, a)
                },
            )
            .reduce(
                || {
                    (
                        vec![0u64; num_sites],
                        vec![0u64; num_sites],
                        vec![0u64; num_sites],
                        vec![0u32; num_sites],
                    )
                },
                |(mut r1, mut g1, mut b1, mut a1), (r2, g2, b2, a2)| {
                    for i in 0..num_sites {
                        r1[i] += r2[i];
                        g1[i] += g2[i];
                        b1[i] += b2[i];
                        a1[i] += a2[i];
                    }
                    (r1, g1, b1, a1)
                },
            );

        // Phase 3: Compute average colors
        let cell_colors: Vec<Rgb> = (0..num_sites)
            .map(|i| {
                let count = areas[i] as u64;
                if count > 0 {
                    [
                        (r_sums[i] / count) as u8,
                        (g_sums[i] / count) as u8,
                        (b_sums[i] / count) as u8,
                    ]
                } else {
                    [128, 128, 128]  // Default gray for empty cells
                }
            })
            .collect();

        Ok(VoronoiResult {
            cell_of,
            cell_colors,
            cell_areas: areas,
            width,
            height,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

        // Both cells should have approximately half the pixels
        let total_area: u32 = result.cell_areas.iter().sum();
        assert_eq!(total_area, 10000);
    }
}
