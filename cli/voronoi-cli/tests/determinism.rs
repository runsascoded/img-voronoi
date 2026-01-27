//! End-to-end tests verifying deterministic Voronoi output.
//!
//! These tests ensure that given the same seed, the CLI produces
//! identical output across runs. CPU and GPU backends use the same
//! algorithm and produce bitwise identical output, except in rare
//! tie-breaking cases where two sites have exactly equal distances.

use std::path::PathBuf;
use voronoi_core::{CpuBackend, ComputeBackend, SiteCollection};

#[cfg(feature = "gpu")]
use voronoi_core::GpuBackend;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn load_image(name: &str) -> image::RgbImage {
    let path = fixtures_dir().join(name);
    image::open(&path)
        .unwrap_or_else(|_| panic!("Failed to load {}", name))
        .to_rgb8()
}

fn load_sample_image() -> image::RgbImage {
    load_image("sample.jpg")
}

fn render_single_frame(
    backend: &mut dyn ComputeBackend,
    image: &image::RgbImage,
    sites: usize,
    seed: u64,
) -> image::RgbImage {
    let (width, height) = image.dimensions();
    let site_collection = SiteCollection::random(sites, width as f64, height as f64, seed);
    let positions = site_collection.positions();
    let result = backend.compute(image, &positions).expect("Compute failed");
    result.to_image()
}

fn load_expected(name: &str) -> image::RgbImage {
    let path = fixtures_dir().join(format!("{}.png", name));
    image::open(&path)
        .unwrap_or_else(|_| panic!("Failed to load expected image: {}", path.display()))
        .to_rgb8()
}

/// Assert two images are exactly equal (bitwise)
fn assert_images_equal(expected: &image::RgbImage, actual: &image::RgbImage, name: &str) {
    assert_eq!(
        expected.dimensions(),
        actual.dimensions(),
        "{}: dimensions mismatch",
        name
    );

    let expected_bytes = expected.as_raw();
    let actual_bytes = actual.as_raw();

    assert_eq!(
        expected_bytes, actual_bytes,
        "{}: pixel data mismatch",
        name
    );
}

/// Find all differing pixels between two images
fn find_differing_pixels(img1: &image::RgbImage, img2: &image::RgbImage) -> Vec<(u32, u32)> {
    assert_eq!(img1.dimensions(), img2.dimensions(), "dimensions must match");

    let (width, height) = img1.dimensions();
    let mut diffs = Vec::new();

    for y in 0..height {
        for x in 0..width {
            if img1.get_pixel(x, y) != img2.get_pixel(x, y) {
                diffs.push((x, y));
            }
        }
    }

    diffs
}

// CPU backend tests - require exact match with golden fixtures
mod cpu {
    use super::*;

    #[test]
    fn test_100_sites_seed0() {
        let image = load_sample_image();
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 100, 0);
        let expected = load_expected("sample_100sites_seed0");
        assert_images_equal(&expected, &actual, "100_sites_seed0");
    }

    #[test]
    fn test_100_sites_seed42() {
        let image = load_sample_image();
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 100, 42);
        let expected = load_expected("sample_100sites_seed42");
        assert_images_equal(&expected, &actual, "100_sites_seed42");
    }

    #[test]
    fn test_500_sites_seed0() {
        let image = load_sample_image();
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 500, 0);
        let expected = load_expected("sample_500sites_seed0");
        assert_images_equal(&expected, &actual, "500_sites_seed0");
    }

    #[test]
    fn test_500_sites_seed123() {
        let image = load_sample_image();
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 500, 123);
        let expected = load_expected("sample_500sites_seed123");
        assert_images_equal(&expected, &actual, "500_sites_seed123");
    }

    #[test]
    fn test_1000_sites_seed0() {
        let image = load_sample_image();
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 1000, 0);
        let expected = load_expected("sample_1000sites_seed0");
        assert_images_equal(&expected, &actual, "1000_sites_seed0");
    }

    #[test]
    fn test_reproducibility() {
        let image = load_sample_image();
        let mut backend = CpuBackend::new();

        let result1 = render_single_frame(&mut backend, &image, 200, 12345);
        let result2 = render_single_frame(&mut backend, &image, 200, 12345);

        assert_images_equal(&result1, &result2, "reproducibility");
    }

    #[test]
    fn test_different_seeds_produce_different_output() {
        let image = load_sample_image();
        let mut backend = CpuBackend::new();

        let result1 = render_single_frame(&mut backend, &image, 100, 0);
        let result2 = render_single_frame(&mut backend, &image, 100, 1);

        assert_ne!(
            result1.as_raw(),
            result2.as_raw(),
            "Different seeds should produce different output"
        );
    }

    // Stock image tests (from Unsplash)
    #[test]
    fn test_aurora_200sites() {
        let image = load_image("aurora.jpg");
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 200, 0);
        let expected = load_expected("aurora_200sites_cpu");
        assert_images_equal(&expected, &actual, "aurora_200sites");
    }

    #[test]
    fn test_aurora_500sites() {
        let image = load_image("aurora.jpg");
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 500, 0);
        let expected = load_expected("aurora_500sites");
        assert_images_equal(&expected, &actual, "aurora_500sites");
    }

    #[test]
    fn test_cityscape_200sites() {
        let image = load_image("cityscape.jpg");
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 200, 0);
        let expected = load_expected("cityscape_200sites");
        assert_images_equal(&expected, &actual, "cityscape_200sites");
    }

    #[test]
    fn test_cityscape_500sites() {
        let image = load_image("cityscape.jpg");
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 500, 0);
        let expected = load_expected("cityscape_500sites");
        assert_images_equal(&expected, &actual, "cityscape_500sites");
    }

    #[test]
    fn test_flowers_200sites() {
        let image = load_image("flowers.jpg");
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 200, 0);
        let expected = load_expected("flowers_200sites_cpu");
        assert_images_equal(&expected, &actual, "flowers_200sites");
    }

    #[test]
    fn test_flowers_500sites() {
        let image = load_image("flowers.jpg");
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 500, 0);
        let expected = load_expected("flowers_500sites");
        assert_images_equal(&expected, &actual, "flowers_500sites");
    }
}

// GPU backend tests
#[cfg(feature = "gpu")]
mod gpu {
    use super::*;

    fn get_gpu_backend() -> Option<GpuBackend> {
        GpuBackend::new().ok()
    }

    /// Most GPU tests produce bitwise identical output to CPU.
    #[test]
    fn test_gpu_vs_cpu_exact_match() {
        let Some(mut gpu) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let mut cpu = CpuBackend::new();

        // These configurations produce identical CPU/GPU output
        let test_cases = [
            ("sample.jpg", 100, 0),
            ("sample.jpg", 500, 0),
            ("sample.jpg", 1000, 0),
            ("aurora.jpg", 500, 0),
            ("cityscape.jpg", 200, 0),
            ("cityscape.jpg", 500, 0),
            ("flowers.jpg", 500, 0),
        ];

        for (img_name, sites, seed) in test_cases {
            let image = load_image(img_name);
            let cpu_result = render_single_frame(&mut cpu, &image, sites, seed);
            let gpu_result = render_single_frame(&mut gpu, &image, sites, seed);

            let diffs = find_differing_pixels(&cpu_result, &gpu_result);
            assert!(
                diffs.is_empty(),
                "{} {}sites seed{}: expected identical, got {} differing pixels at {:?}",
                img_name, sites, seed, diffs.len(), diffs
            );
        }
    }

    /// GPU self-consistency: same inputs always produce same output.
    #[test]
    fn test_gpu_reproducibility() {
        let Some(mut backend) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let image = load_sample_image();

        let result1 = render_single_frame(&mut backend, &image, 200, 12345);
        let result2 = render_single_frame(&mut backend, &image, 200, 12345);

        assert_images_equal(&result1, &result2, "gpu_reproducibility");
    }

    /// Document known tie-breaking cases where CPU and GPU differ.
    ///
    /// At pixel (134, 644) with 200 sites and seed 0 on a 1200x800 image,
    /// sites 3 and 105 have exactly equal squared distances in f32:
    ///   Site 3:   (185.15, 704.57), dist² = 6173.708
    ///   Site 105: (98.81, 714.50),  dist² = 6173.708
    ///
    /// Due to sub-ULP floating-point differences (likely GPU FMA instructions),
    /// CPU assigns this pixel to site 3, GPU assigns it to site 105.
    /// This is expected behavior, not a bug.
    #[test]
    fn test_gpu_vs_cpu_tiebreaker_cases() {
        let Some(mut gpu) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let mut cpu = CpuBackend::new();

        // These configurations have exactly 1 tie-breaking pixel
        let tie_cases = [
            ("aurora.jpg", 200, 0, (134, 644)),
            ("flowers.jpg", 200, 0, (134, 644)),
        ];

        for (img_name, sites, seed, expected_diff_pixel) in tie_cases {
            let image = load_image(img_name);
            let cpu_result = render_single_frame(&mut cpu, &image, sites, seed);
            let gpu_result = render_single_frame(&mut gpu, &image, sites, seed);

            let diffs = find_differing_pixels(&cpu_result, &gpu_result);

            assert_eq!(
                diffs.len(), 1,
                "{} {}sites seed{}: expected exactly 1 tie-breaking pixel, got {}",
                img_name, sites, seed, diffs.len()
            );

            assert_eq!(
                diffs[0], expected_diff_pixel,
                "{} {}sites seed{}: tie-breaking pixel at {:?}, expected {:?}",
                img_name, sites, seed, diffs[0], expected_diff_pixel
            );
        }
    }
}
