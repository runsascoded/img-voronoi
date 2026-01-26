//! End-to-end tests verifying deterministic Voronoi output.
//!
//! These tests ensure that given the same seed, the CLI produces
//! identical output across runs.

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

// CPU backend tests
mod cpu {
    use super::*;

    #[test]
    fn test_100_sites_seed0() {
        let image = load_sample_image();
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 100, 0);
        let expected = load_expected("sample_100sites_seed0_cpu");
        assert_images_equal(&expected, &actual, "100_sites_seed0_cpu");
    }

    #[test]
    fn test_100_sites_seed42() {
        let image = load_sample_image();
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 100, 42);
        let expected = load_expected("sample_100sites_seed42_cpu");
        assert_images_equal(&expected, &actual, "100_sites_seed42_cpu");
    }

    #[test]
    fn test_500_sites_seed0() {
        let image = load_sample_image();
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 500, 0);
        let expected = load_expected("sample_500sites_seed0_cpu");
        assert_images_equal(&expected, &actual, "500_sites_seed0_cpu");
    }

    #[test]
    fn test_500_sites_seed123() {
        let image = load_sample_image();
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 500, 123);
        let expected = load_expected("sample_500sites_seed123_cpu");
        assert_images_equal(&expected, &actual, "500_sites_seed123_cpu");
    }

    #[test]
    fn test_1000_sites_seed0() {
        let image = load_sample_image();
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 1000, 0);
        let expected = load_expected("sample_1000sites_seed0_cpu");
        assert_images_equal(&expected, &actual, "1000_sites_seed0_cpu");
    }

    #[test]
    fn test_reproducibility() {
        // Verify same seed produces identical output across multiple runs
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
        assert_images_equal(&expected, &actual, "aurora_200sites_cpu");
    }

    #[test]
    fn test_aurora_500sites() {
        let image = load_image("aurora.jpg");
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 500, 0);
        let expected = load_expected("aurora_500sites_cpu");
        assert_images_equal(&expected, &actual, "aurora_500sites_cpu");
    }

    #[test]
    fn test_cityscape_200sites() {
        let image = load_image("cityscape.jpg");
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 200, 0);
        let expected = load_expected("cityscape_200sites_cpu");
        assert_images_equal(&expected, &actual, "cityscape_200sites_cpu");
    }

    #[test]
    fn test_cityscape_500sites() {
        let image = load_image("cityscape.jpg");
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 500, 0);
        let expected = load_expected("cityscape_500sites_cpu");
        assert_images_equal(&expected, &actual, "cityscape_500sites_cpu");
    }

    #[test]
    fn test_flowers_200sites() {
        let image = load_image("flowers.jpg");
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 200, 0);
        let expected = load_expected("flowers_200sites_cpu");
        assert_images_equal(&expected, &actual, "flowers_200sites_cpu");
    }

    #[test]
    fn test_flowers_500sites() {
        let image = load_image("flowers.jpg");
        let mut backend = CpuBackend::new();
        let actual = render_single_frame(&mut backend, &image, 500, 0);
        let expected = load_expected("flowers_500sites_cpu");
        assert_images_equal(&expected, &actual, "flowers_500sites_cpu");
    }
}

// GPU backend tests
#[cfg(feature = "gpu")]
mod gpu {
    use super::*;

    fn get_gpu_backend() -> Option<GpuBackend> {
        GpuBackend::new().ok()
    }

    #[test]
    fn test_100_sites_seed0() {
        let Some(mut backend) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let image = load_sample_image();
        let actual = render_single_frame(&mut backend, &image, 100, 0);
        let expected = load_expected("sample_100sites_seed0_gpu");
        assert_images_equal(&expected, &actual, "100_sites_seed0_gpu");
    }

    #[test]
    fn test_100_sites_seed42() {
        let Some(mut backend) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let image = load_sample_image();
        let actual = render_single_frame(&mut backend, &image, 100, 42);
        let expected = load_expected("sample_100sites_seed42_gpu");
        assert_images_equal(&expected, &actual, "100_sites_seed42_gpu");
    }

    #[test]
    fn test_500_sites_seed0() {
        let Some(mut backend) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let image = load_sample_image();
        let actual = render_single_frame(&mut backend, &image, 500, 0);
        let expected = load_expected("sample_500sites_seed0_gpu");
        assert_images_equal(&expected, &actual, "500_sites_seed0_gpu");
    }

    #[test]
    fn test_500_sites_seed123() {
        let Some(mut backend) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let image = load_sample_image();
        let actual = render_single_frame(&mut backend, &image, 500, 123);
        let expected = load_expected("sample_500sites_seed123_gpu");
        assert_images_equal(&expected, &actual, "500_sites_seed123_gpu");
    }

    #[test]
    fn test_1000_sites_seed0() {
        let Some(mut backend) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let image = load_sample_image();
        let actual = render_single_frame(&mut backend, &image, 1000, 0);
        let expected = load_expected("sample_1000sites_seed0_gpu");
        assert_images_equal(&expected, &actual, "1000_sites_seed0_gpu");
    }

    #[test]
    fn test_reproducibility() {
        let Some(mut backend) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let image = load_sample_image();

        let result1 = render_single_frame(&mut backend, &image, 200, 12345);
        let result2 = render_single_frame(&mut backend, &image, 200, 12345);

        assert_images_equal(&result1, &result2, "gpu_reproducibility");
    }

    // Stock image tests (from Unsplash)
    #[test]
    fn test_aurora_200sites() {
        let Some(mut backend) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let image = load_image("aurora.jpg");
        let actual = render_single_frame(&mut backend, &image, 200, 0);
        let expected = load_expected("aurora_200sites_gpu");
        assert_images_equal(&expected, &actual, "aurora_200sites_gpu");
    }

    #[test]
    fn test_aurora_500sites() {
        let Some(mut backend) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let image = load_image("aurora.jpg");
        let actual = render_single_frame(&mut backend, &image, 500, 0);
        let expected = load_expected("aurora_500sites_gpu");
        assert_images_equal(&expected, &actual, "aurora_500sites_gpu");
    }

    #[test]
    fn test_cityscape_200sites() {
        let Some(mut backend) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let image = load_image("cityscape.jpg");
        let actual = render_single_frame(&mut backend, &image, 200, 0);
        let expected = load_expected("cityscape_200sites_gpu");
        assert_images_equal(&expected, &actual, "cityscape_200sites_gpu");
    }

    #[test]
    fn test_cityscape_500sites() {
        let Some(mut backend) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let image = load_image("cityscape.jpg");
        let actual = render_single_frame(&mut backend, &image, 500, 0);
        let expected = load_expected("cityscape_500sites_gpu");
        assert_images_equal(&expected, &actual, "cityscape_500sites_gpu");
    }

    #[test]
    fn test_flowers_200sites() {
        let Some(mut backend) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let image = load_image("flowers.jpg");
        let actual = render_single_frame(&mut backend, &image, 200, 0);
        let expected = load_expected("flowers_200sites_gpu");
        assert_images_equal(&expected, &actual, "flowers_200sites_gpu");
    }

    #[test]
    fn test_flowers_500sites() {
        let Some(mut backend) = get_gpu_backend() else {
            eprintln!("GPU not available, skipping test");
            return;
        };
        let image = load_image("flowers.jpg");
        let actual = render_single_frame(&mut backend, &image, 500, 0);
        let expected = load_expected("flowers_500sites_gpu");
        assert_images_equal(&expected, &actual, "flowers_500sites_gpu");
    }
}
