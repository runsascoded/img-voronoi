//! Voronoi animation CLI
//!
//! Renders deterministic, frame-rate-independent Voronoi animations.

use std::path::PathBuf;
use std::time::{Duration, Instant};
use clap::{Parser, ValueEnum};
use indicatif::{ProgressBar, ProgressStyle};

use voronoi_core::{CpuBackend, SiteCollection, ComputeBackend, Position};

#[cfg(feature = "gpu")]
use voronoi_core::GpuBackend;

#[derive(Debug, Clone, Copy, ValueEnum)]
enum OutputFormat {
    Mp4,
    Gif,
}

#[derive(Parser, Debug)]
#[command(name = "voronoi")]
#[command(about = "Render Voronoi animations", long_about = None)]
#[command(arg_required_else_help = true)]
struct Args {
    /// Input image path
    #[arg(short, long)]
    input: PathBuf,

    /// Output file path
    #[arg(short, long)]
    output: Option<PathBuf>,

    /// Output format
    #[arg(short, long, value_enum, default_value = "mp4")]
    format: OutputFormat,

    /// Starting number of sites
    #[arg(long, default_value = "25")]
    sites_start: usize,

    /// Ending number of sites
    #[arg(long, default_value = "1000")]
    sites_end: usize,

    /// Doubling time in seconds (for gradual site changes)
    #[arg(long, default_value = "2.0")]
    doubling_time: f64,

    /// Animation speed (pixels per second)
    #[arg(long, default_value = "15.0")]
    speed: f64,

    /// Duration in seconds
    #[arg(long, default_value = "10.0")]
    duration: f64,

    /// Frames per second
    #[arg(long, default_value = "30")]
    fps: u32,

    /// Random seed for reproducibility
    #[arg(long, default_value = "0")]
    seed: u64,

    /// Use GPU acceleration (if available)
    #[arg(long)]
    gpu: bool,

    /// Run benchmark comparing CPU vs GPU performance
    #[arg(long)]
    benchmark: bool,

    /// Number of frames to render in benchmark mode
    #[arg(long, default_value = "10")]
    bench_frames: usize,

    /// Number of sites to use in benchmark mode
    #[arg(long, default_value = "500")]
    bench_sites: usize,

    /// Render a single frame (PNG) instead of animation
    #[arg(long)]
    single_frame: bool,
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    // Load input image
    println!("Loading image: {:?}", args.input);
    let image = image::open(&args.input)?.to_rgb8();
    let (width, height) = image.dimensions();
    println!("Image size: {}x{}", width, height);

    // Run benchmark mode if requested
    if args.benchmark {
        return run_benchmark(&image, &args);
    }

    // Require output path for normal rendering
    let output = args.output.as_ref()
        .ok_or_else(|| anyhow::anyhow!("Output path required (use -o/--output)"))?;

    // Create backend
    #[cfg(feature = "gpu")]
    let mut backend: Box<dyn ComputeBackend> = if args.gpu {
        println!("Using GPU backend (wgpu)");
        match GpuBackend::new() {
            Ok(gpu) => Box::new(gpu),
            Err(e) => {
                eprintln!("Warning: GPU initialization failed: {}. Falling back to CPU.", e);
                Box::new(CpuBackend::new())
            }
        }
    } else {
        println!("Using CPU backend (Rayon)");
        Box::new(CpuBackend::new())
    };

    #[cfg(not(feature = "gpu"))]
    let mut backend: Box<dyn ComputeBackend> = {
        if args.gpu {
            eprintln!("Warning: GPU feature not enabled. Using CPU backend.");
        } else {
            println!("Using CPU backend (Rayon)");
        }
        Box::new(CpuBackend::new())
    };

    // Single frame mode: render one frame and save as PNG
    if args.single_frame {
        let sites = SiteCollection::random(args.sites_start, width as f64, height as f64, args.seed);
        println!("Rendering single frame with {} sites (seed: {})", args.sites_start, args.seed);

        let positions = sites.positions();
        let result = backend.compute(&image, &positions)?;
        let frame_image = result.to_image();
        frame_image.save(output)?;

        println!("Output saved to: {:?}", output);
        return Ok(());
    }

    // Initialize sites with seeded RNG for reproducibility
    let mut sites = SiteCollection::random(args.sites_start, width as f64, height as f64, args.seed);
    println!("Using seed: {}", args.seed);
    let target_sites = args.sites_end;

    // Calculate frame timing
    let total_frames = (args.duration * args.fps as f64) as usize;
    let dt = 1.0 / args.fps as f64;

    println!(
        "Rendering {} frames at {} fps ({:.1}s duration)",
        total_frames, args.fps, args.duration
    );
    println!(
        "Sites: {} → {} (doubling time: {:.1}s)",
        args.sites_start, args.sites_end, args.doubling_time
    );

    // Set up progress bar
    let progress = ProgressBar::new(total_frames as u64);
    progress.set_style(
        ProgressStyle::default_bar()
            .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {pos}/{len} ({eta})")?
            .progress_chars("#>-"),
    );

    // Render frames
    let mut frames: Vec<image::RgbImage> = Vec::with_capacity(total_frames);

    for _frame in 0..total_frames {
        // Step physics
        sites.step(args.speed, dt, width as f64, height as f64);

        // Compute Voronoi
        let positions = sites.positions();
        let result = backend.compute(&image, &positions)?;

        // Gradually adjust site count
        let (_, _) = sites.adjust_count(
            target_sites,
            args.doubling_time,
            dt,
            Some(&result.cell_areas),
        );

        // Render frame
        let frame_image = result.to_image();
        frames.push(frame_image);

        progress.inc(1);
    }

    progress.finish_with_message("Rendering complete");

    // Encode output
    match args.format {
        OutputFormat::Gif => {
            encode_gif(output, &frames, args.fps)?;
        }
        OutputFormat::Mp4 => {
            encode_mp4(output, &frames, args.fps, width, height)?;
        }
    }

    println!("Output saved to: {:?}", output);
    Ok(())
}

/// Benchmark CPU vs GPU performance
fn run_benchmark(image: &image::RgbImage, args: &Args) -> anyhow::Result<()> {
    let (width, height) = image.dimensions();
    let num_frames = args.bench_frames;
    let num_sites = args.bench_sites;

    println!("\n=== Voronoi Benchmark ===");
    println!("Image: {}x{}", width, height);
    println!("Sites: {}", num_sites);
    println!("Frames: {}", num_frames);
    println!();

    // Generate fixed positions for fair comparison
    let sites = SiteCollection::random(num_sites, width as f64, height as f64, args.seed);
    let positions: Vec<Position> = sites.positions();

    // Benchmark CPU
    println!("Benchmarking CPU (Rayon)...");
    let cpu_time = benchmark_backend(&mut CpuBackend::new(), image, &positions, num_frames)?;
    let cpu_fps = num_frames as f64 / cpu_time.as_secs_f64();
    println!(
        "  CPU: {:?} total, {:.2} fps, {:.2} ms/frame",
        cpu_time,
        cpu_fps,
        cpu_time.as_secs_f64() * 1000.0 / num_frames as f64
    );

    // Benchmark GPU (if available)
    #[cfg(feature = "gpu")]
    {
        println!("Benchmarking GPU (wgpu)...");
        match GpuBackend::new() {
            Ok(mut gpu) => {
                let gpu_time = benchmark_backend(&mut gpu, image, &positions, num_frames)?;
                let gpu_fps = num_frames as f64 / gpu_time.as_secs_f64();
                println!(
                    "  GPU: {:?} total, {:.2} fps, {:.2} ms/frame",
                    gpu_time,
                    gpu_fps,
                    gpu_time.as_secs_f64() * 1000.0 / num_frames as f64
                );

                // Summary
                println!();
                println!("=== Summary ===");
                let speedup = cpu_time.as_secs_f64() / gpu_time.as_secs_f64();
                if speedup > 1.0 {
                    println!("GPU is {:.2}x faster than CPU", speedup);
                } else {
                    println!("CPU is {:.2}x faster than GPU", 1.0 / speedup);
                }
            }
            Err(e) => {
                eprintln!("  GPU initialization failed: {}", e);
            }
        }
    }

    #[cfg(not(feature = "gpu"))]
    {
        println!("GPU benchmark skipped (gpu feature not enabled)");
    }

    Ok(())
}

/// Benchmark a single backend
fn benchmark_backend(
    backend: &mut dyn ComputeBackend,
    image: &image::RgbImage,
    positions: &[Position],
    num_frames: usize,
) -> anyhow::Result<Duration> {
    // Warmup frame (GPU needs to compile shaders, etc.)
    let _ = backend.compute(image, positions)?;

    // Timed frames
    let start = Instant::now();
    for _ in 0..num_frames {
        let _ = backend.compute(image, positions)?;
    }
    Ok(start.elapsed())
}

fn encode_gif(path: &PathBuf, frames: &[image::RgbImage], fps: u32) -> anyhow::Result<()> {
    use gif::{Encoder, Frame, Repeat};
    use std::fs::File;

    let file = File::create(path)?;
    let (width, height) = frames[0].dimensions();

    let mut encoder = Encoder::new(file, width as u16, height as u16, &[])?;
    encoder.set_repeat(Repeat::Infinite)?;

    let frame_delay = (100 / fps).max(1) as u16;  // GIF delay in centiseconds

    println!("Encoding GIF ({} frames)...", frames.len());
    let progress = ProgressBar::new(frames.len() as u64);

    for frame_image in frames {
        // Convert RGB to indexed color (simple quantization)
        let mut pixels: Vec<u8> = Vec::with_capacity((width * height) as usize);
        let mut palette: Vec<[u8; 3]> = Vec::new();

        for pixel in frame_image.pixels() {
            let rgb = [pixel[0], pixel[1], pixel[2]];

            // Simple palette lookup (or add new color)
            let idx = palette.iter().position(|&c| c == rgb).unwrap_or_else(|| {
                if palette.len() < 256 {
                    palette.push(rgb);
                    palette.len() - 1
                } else {
                    // Find closest color in palette
                    palette
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, c)| {
                            let dr = c[0] as i32 - rgb[0] as i32;
                            let dg = c[1] as i32 - rgb[1] as i32;
                            let db = c[2] as i32 - rgb[2] as i32;
                            dr * dr + dg * dg + db * db
                        })
                        .map(|(i, _)| i)
                        .unwrap_or(0)
                }
            });

            pixels.push(idx as u8);
        }

        // Pad palette to power of 2
        while palette.len() < 256 {
            palette.push([0, 0, 0]);
        }

        let flat_palette: Vec<u8> = palette.iter().flat_map(|c| c.iter().copied()).collect();

        let mut frame = Frame::from_palette_pixels(width as u16, height as u16, pixels, flat_palette, None);
        frame.delay = frame_delay;

        encoder.write_frame(&frame)?;
        progress.inc(1);
    }

    progress.finish();
    Ok(())
}

fn encode_mp4(
    path: &PathBuf,
    frames: &[image::RgbImage],
    fps: u32,
    _width: u32,
    _height: u32,
) -> anyhow::Result<()> {
    // Note: ffmpeg-next requires FFmpeg to be installed
    // For now, use a simpler approach: write frames to temp dir and call ffmpeg

    use std::process::Command;
    use tempfile::tempdir;

    let temp_dir = tempdir()?;
    println!("Writing frames to temp dir...");

    let progress = ProgressBar::new(frames.len() as u64);

    for (i, frame) in frames.iter().enumerate() {
        let path = temp_dir.path().join(format!("frame_{:05}.png", i));
        frame.save(&path)?;
        progress.inc(1);
    }

    progress.finish();

    println!("Encoding MP4 with ffmpeg...");

    let status = Command::new("ffmpeg")
        .args([
            "-y",  // Overwrite output
            "-framerate", &fps.to_string(),
            "-i", &format!("{}/frame_%05d.png", temp_dir.path().display()),
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-crf", "18",  // High quality
            path.to_str().unwrap(),
        ])
        .status()?;

    if !status.success() {
        anyhow::bail!("ffmpeg encoding failed");
    }

    Ok(())
}
