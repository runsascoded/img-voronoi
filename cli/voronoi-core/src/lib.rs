//! Core Voronoi diagram computation library.
//!
//! Provides both CPU (Rayon-parallelized) and GPU (wgpu) implementations
//! for computing Voronoi diagrams and rendering them with averaged colors.

mod site;
mod voronoi;

#[cfg(feature = "cpu")]
mod cpu;

#[cfg(feature = "gpu")]
mod gpu;

pub use site::{Position, Site, SiteCollection, SplitStrategy, Velocity};
pub use voronoi::{VoronoiComputer, VoronoiResult, ComputeBackend};

#[cfg(feature = "cpu")]
pub use cpu::CpuBackend;

#[cfg(feature = "gpu")]
pub use gpu::GpuBackend;

/// RGB color tuple
pub type Rgb = [u8; 3];

/// Error type for Voronoi operations
#[derive(Debug, thiserror::Error)]
pub enum VoronoiError {
    #[error("Image error: {0}")]
    Image(#[from] image::ImageError),

    #[error("No sites provided")]
    NoSites,

    #[cfg(feature = "gpu")]
    #[error("GPU error: {0}")]
    Gpu(String),

    #[error("Backend not available: {0}")]
    BackendUnavailable(String),
}

pub type Result<T> = std::result::Result<T, VoronoiError>;
