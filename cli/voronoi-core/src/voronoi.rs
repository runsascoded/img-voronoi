//! Voronoi computation traits and result types.

use crate::{Position, Rgb, Result};

/// Result of Voronoi computation
#[derive(Debug)]
pub struct VoronoiResult {
    /// Cell index for each pixel (row-major order)
    pub cell_of: Vec<i32>,
    /// Average color for each cell
    pub cell_colors: Vec<Rgb>,
    /// Area (pixel count) for each cell
    pub cell_areas: Vec<u32>,
    /// Image dimensions
    pub width: u32,
    pub height: u32,
}

impl VoronoiResult {
    /// Render the Voronoi diagram to an RGB image buffer
    pub fn render(&self) -> Vec<u8> {
        let mut pixels = vec![0u8; (self.width * self.height * 3) as usize];

        for (i, &cell) in self.cell_of.iter().enumerate() {
            if cell >= 0 && (cell as usize) < self.cell_colors.len() {
                let color = self.cell_colors[cell as usize];
                let px = i * 3;
                pixels[px] = color[0];
                pixels[px + 1] = color[1];
                pixels[px + 2] = color[2];
            }
        }

        pixels
    }

    /// Render to an image::RgbImage
    pub fn to_image(&self) -> image::RgbImage {
        let pixels = self.render();
        image::RgbImage::from_raw(self.width, self.height, pixels)
            .expect("Buffer size mismatch")
    }
}

/// Trait for Voronoi computation backends
pub trait ComputeBackend {
    /// Compute Voronoi diagram for given sites on an image
    fn compute(
        &mut self,
        image: &image::RgbImage,
        sites: &[Position],
    ) -> Result<VoronoiResult>;
}

/// High-level Voronoi computer that can use different backends
pub struct VoronoiComputer<B: ComputeBackend> {
    backend: B,
}

impl<B: ComputeBackend> VoronoiComputer<B> {
    pub fn new(backend: B) -> Self {
        Self { backend }
    }

    pub fn compute(
        &mut self,
        image: &image::RgbImage,
        sites: &[Position],
    ) -> Result<VoronoiResult> {
        self.backend.compute(image, sites)
    }
}
