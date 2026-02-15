//! WASM bindings for voronoi-core.
//!
//! Exposes a stateful `VoronoiEngine` that holds the image and sites,
//! returning flat typed arrays for efficient JS interop.

use wasm_bindgen::prelude::*;
use voronoi_core::{
    CpuBackend, ComputeBackend, Position, Site, SiteCollection, SplitStrategy,
    Velocity, VoronoiResult,
};

#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

/// Convert RGBA pixel data to an `image::RgbImage`.
fn rgba_to_rgb_image(rgba: &[u8], width: u32, height: u32) -> image::RgbImage {
    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
    for pixel in rgba.chunks_exact(4) {
        rgb.push(pixel[0]);
        rgb.push(pixel[1]);
        rgb.push(pixel[2]);
    }
    image::RgbImage::from_raw(width, height, rgb)
        .expect("buffer size mismatch in rgba_to_rgb_image")
}

/// Result of a single Voronoi computation frame.
/// All data is exposed as flat typed arrays for zero-copy JS access.
#[wasm_bindgen]
pub struct VoronoiFrame {
    cell_of: Vec<i32>,
    cell_colors_flat: Vec<u8>,
    cell_areas: Vec<u32>,
    cell_centroids_flat: Vec<f64>,
    farthest_x: f64,
    farthest_y: f64,
    width: u32,
    height: u32,
}

#[wasm_bindgen]
impl VoronoiFrame {
    /// Cell index for each pixel (row-major, length = width*height)
    #[wasm_bindgen(getter)]
    pub fn cell_of(&self) -> Vec<i32> {
        self.cell_of.clone()
    }

    /// Flat RGB colors per cell (length = num_cells * 3)
    #[wasm_bindgen(getter)]
    pub fn cell_colors(&self) -> Vec<u8> {
        self.cell_colors_flat.clone()
    }

    /// Pixel count per cell (length = num_cells)
    #[wasm_bindgen(getter)]
    pub fn cell_areas(&self) -> Vec<u32> {
        self.cell_areas.clone()
    }

    /// Flat [x0,y0, x1,y1, ...] centroids per cell (length = num_cells * 2)
    #[wasm_bindgen(getter)]
    pub fn cell_centroids(&self) -> Vec<f64> {
        self.cell_centroids_flat.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn farthest_x(&self) -> f64 {
        self.farthest_x
    }

    #[wasm_bindgen(getter)]
    pub fn farthest_y(&self) -> f64 {
        self.farthest_y
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
}

impl VoronoiFrame {
    fn from_result(result: VoronoiResult) -> Self {
        let cell_colors_flat: Vec<u8> = result.cell_colors.iter()
            .flat_map(|&[r, g, b]| [r, g, b])
            .collect();
        let cell_centroids_flat: Vec<f64> = result.cell_centroids.iter()
            .flat_map(|p| [p.x, p.y])
            .collect();
        Self {
            cell_of: result.cell_of,
            cell_colors_flat,
            cell_areas: result.cell_areas,
            cell_centroids_flat,
            farthest_x: result.farthest_point.x,
            farthest_y: result.farthest_point.y,
            width: result.width,
            height: result.height,
        }
    }
}

/// Stateful Voronoi computation engine.
/// Holds the source image and site collection, providing methods
/// for computation, physics stepping, and site count adjustment.
#[wasm_bindgen]
pub struct VoronoiEngine {
    image: image::RgbImage,
    width: u32,
    height: u32,
    backend: CpuBackend,
    sites: SiteCollection,
}

#[wasm_bindgen]
impl VoronoiEngine {
    /// Create a new engine from RGBA pixel data.
    #[wasm_bindgen(constructor)]
    pub fn new(rgba_data: &[u8], width: u32, height: u32, seed: u32) -> Self {
        let image = rgba_to_rgb_image(rgba_data, width, height);
        Self {
            image,
            width,
            height,
            backend: CpuBackend::new(),
            sites: SiteCollection::new(vec![], seed as u64),
        }
    }

    /// Replace the source image (e.g. on resize).
    pub fn set_image(&mut self, rgba_data: &[u8], width: u32, height: u32) {
        self.image = rgba_to_rgb_image(rgba_data, width, height);
        self.width = width;
        self.height = height;
    }

    /// Initialize sites from flat [x0,y0, x1,y1, ...] positions.
    pub fn set_sites(&mut self, positions: &[f64], seed: u32) {
        let sites: Vec<Site> = positions.chunks_exact(2)
            .map(|xy| {
                Site::new(
                    Position::new(xy[0], xy[1]),
                    Velocity::new(0.0, 1.0),
                )
            })
            .collect();
        self.sites = SiteCollection::new(sites, seed as u64);
    }

    /// Initialize sites with random velocities from flat positions.
    /// Uses the seeded RNG for deterministic velocity generation.
    pub fn set_sites_random_vel(&mut self, positions: &[f64], seed: u32) {
        self.sites = SiteCollection::random_from_positions(
            positions.chunks_exact(2)
                .map(|xy| Position::new(xy[0], xy[1]))
                .collect(),
            seed as u64,
        );
    }

    /// Run Voronoi computation on current image and sites.
    pub fn compute(&mut self) -> VoronoiFrame {
        let positions = self.sites.positions();
        let result = self.backend.compute(&self.image, &positions)
            .expect("Voronoi computation failed");
        VoronoiFrame::from_result(result)
    }

    /// Advance site physics by one time step.
    /// Uses Ornstein-Uhlenbeck steering + centroid pull + edge bouncing.
    pub fn step(
        &mut self,
        speed: f64,
        dt: f64,
        centroids: Option<Vec<f64>>,
        centroid_pull: f64,
        theta: f64,
        sigma: f64,
    ) {
        let centroid_positions: Option<Vec<Position>> = centroids.map(|flat| {
            flat.chunks_exact(2)
                .map(|xy| Position::new(xy[0], xy[1]))
                .collect()
        });

        self.sites.step(
            speed,
            dt,
            self.width as f64,
            self.height as f64,
            centroid_positions.as_deref(),
            centroid_pull,
            theta,
            sigma,
        );
    }

    /// Gradually adjust site count toward target.
    /// Returns the number of sites added (positive) or removed (negative).
    pub fn adjust_count(
        &mut self,
        target: usize,
        doubling_time: f64,
        dt: f64,
        cell_areas: Option<Vec<u32>>,
        strategy: &str,
        centroids: Option<Vec<f64>>,
        farthest_x: f64,
        farthest_y: f64,
    ) -> i32 {
        let split_strategy: SplitStrategy = strategy.parse()
            .unwrap_or(SplitStrategy::Max);

        let centroid_positions: Option<Vec<Position>> = centroids.map(|flat| {
            flat.chunks_exact(2)
                .map(|xy| Position::new(xy[0], xy[1]))
                .collect()
        });

        let farthest = if farthest_x.is_finite() && farthest_y.is_finite() {
            Some(Position::new(farthest_x, farthest_y))
        } else {
            None
        };

        let img_area = (self.width as f64) * (self.height as f64);

        let before = self.sites.len();
        self.sites.adjust_count(
            target,
            doubling_time,
            dt,
            cell_areas.as_deref(),
            split_strategy,
            centroid_positions.as_deref(),
            farthest,
            img_area,
        );
        let after = self.sites.len();
        (after as i32) - (before as i32)
    }

    /// Get current site positions as flat [x0,y0, x1,y1, ...].
    pub fn get_positions(&self) -> Vec<f64> {
        self.sites.positions().iter()
            .flat_map(|p| [p.x, p.y])
            .collect()
    }

    /// Get current site velocities as flat [vx0,vy0, vx1,vy1, ...].
    pub fn get_velocities(&self) -> Vec<f64> {
        self.sites.sites.iter()
            .flat_map(|s| [s.vel.x, s.vel.y])
            .collect()
    }

    /// Get current site count.
    pub fn site_count(&self) -> usize {
        self.sites.len()
    }
}
