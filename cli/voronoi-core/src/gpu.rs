//! GPU-based Voronoi computation using wgpu.
//!
//! Uses the cone-rendering technique: each site is rendered as an inverted cone,
//! and the depth buffer automatically finds the closest site per pixel.

use crate::{Position, Rgb, Result, VoronoiError, VoronoiResult};
use crate::voronoi::ComputeBackend;

/// GPU backend using wgpu for compute shaders
pub struct GpuBackend {
    device: wgpu::Device,
    queue: wgpu::Queue,
    // TODO: Add shader pipelines, buffers, etc.
}

impl GpuBackend {
    /// Create a new GPU backend
    pub fn new() -> Result<Self> {
        let instance = wgpu::Instance::default();

        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        }))
        .ok_or_else(|| VoronoiError::Gpu("No suitable GPU adapter found".into()))?;

        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("Voronoi GPU"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: Default::default(),
            },
            None,
        ))
        .map_err(|e| VoronoiError::Gpu(format!("Failed to create device: {}", e)))?;

        Ok(Self { device, queue })
    }
}

impl ComputeBackend for GpuBackend {
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

        // TODO: Implement GPU cone rendering
        // For now, fall back to a simple CPU implementation as placeholder
        // This will be replaced with actual GPU compute

        // Placeholder: just do nearest-neighbor on CPU
        let num_pixels = (width * height) as usize;
        let num_sites = sites.len();

        let mut cell_of = vec![0i32; num_pixels];
        let mut r_sums = vec![0u64; num_sites];
        let mut g_sums = vec![0u64; num_sites];
        let mut b_sums = vec![0u64; num_sites];
        let mut cell_areas = vec![0u32; num_sites];

        for y in 0..height {
            for x in 0..width {
                let px = x as f64;
                let py = y as f64;

                let mut min_dist = f64::INFINITY;
                let mut nearest = 0usize;

                for (i, site) in sites.iter().enumerate() {
                    let dx = px - site.x;
                    let dy = py - site.y;
                    let dist = dx * dx + dy * dy;
                    if dist < min_dist {
                        min_dist = dist;
                        nearest = i;
                    }
                }

                let idx = (y * width + x) as usize;
                cell_of[idx] = nearest as i32;

                let pixel = image.get_pixel(x, y);
                r_sums[nearest] += pixel[0] as u64;
                g_sums[nearest] += pixel[1] as u64;
                b_sums[nearest] += pixel[2] as u64;
                cell_areas[nearest] += 1;
            }
        }

        let cell_colors: Vec<Rgb> = (0..num_sites)
            .map(|i| {
                let count = cell_areas[i] as u64;
                if count > 0 {
                    [
                        (r_sums[i] / count) as u8,
                        (g_sums[i] / count) as u8,
                        (b_sums[i] / count) as u8,
                    ]
                } else {
                    [128, 128, 128]
                }
            })
            .collect();

        Ok(VoronoiResult {
            cell_of,
            cell_colors,
            cell_areas,
            width,
            height,
        })
    }
}
