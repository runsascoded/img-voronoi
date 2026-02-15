//! Voronoi animation CLI
//!
//! Renders deterministic, frame-rate-independent Voronoi animations.
//!
//! ## YAML spec file
//!
//! ```yaml
//! start: 25
//! fps: 30
//! speed: 15
//! seed: 0
//! width: 1920
//! height: 1080
//! phases:
//!   - n: 25600
//!     dt: 1
//!   - t: 3          # hold
//!   - n: 25
//!     dt: 1
//! ```
//!
//! Run with: `voronoi -i img.jpg -o out.mp4 --spec anim.yaml`
//!
//! ## Inline phases
//!
//! Or use `-p` for quick inline specs:
//!
//!   voronoi -i img.jpg -o out.mp4 --sites-start 25 \
//!     -p n=25600,dt=1 -p t=3 -p n=25,dt=1
//!
//! ## Graceful interruption
//!
//! Frames are streamed to disk as they render. Press Ctrl+C to interrupt
//! and encode a partial video from frames rendered so far.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use anyhow::Context;
use clap::{Parser, ValueEnum};
use indicatif::{ProgressBar, ProgressStyle};
use serde::Deserialize;

use voronoi_core::{CpuBackend, SiteCollection, ComputeBackend, Position, SplitStrategy};

#[cfg(feature = "gpu")]
use voronoi_core::GpuBackend;

#[derive(Debug, Clone, Copy, ValueEnum)]
enum OutputFormat {
    Mp4,
    Gif,
}

/// A single animation phase (grow, shrink, or hold)
#[derive(Debug, Clone)]
struct Phase {
    /// Target site count (None = hold at current)
    target_sites: Option<usize>,
    /// Doubling/halving time in seconds
    doubling_time: f64,
    /// Phase duration in seconds
    duration: f64,
}

/// YAML spec file format
#[derive(Debug, Deserialize)]
struct AnimSpec {
    start: usize,
    #[serde(default = "default_fps")]
    fps: u32,
    #[serde(default = "default_speed")]
    speed: f64,
    #[serde(default)]
    seed: u64,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    show_sites: Option<bool>,
    #[serde(default)]
    centroid_pull: Option<f64>,
    #[serde(default)]
    split_strategy: Option<String>,
    phases: Vec<PhaseSpec>,
}

fn default_fps() -> u32 { 30 }
fn default_speed() -> f64 { 15.0 }

/// A phase in the YAML spec (provide 2 of {n, dt, t}, or just t for hold)
#[derive(Debug, Deserialize)]
struct PhaseSpec {
    /// Target site count
    n: Option<usize>,
    /// Doubling/halving time (seconds)
    dt: Option<f64>,
    /// Phase duration (seconds)
    t: Option<f64>,
}

impl PhaseSpec {
    fn to_phase(&self, current_sites: usize) -> anyhow::Result<Phase> {
        match (self.n, self.dt, self.t) {
            // n + dt -> compute duration
            (Some(target), Some(doubling_time), None) => {
                let num_doublings = (target as f64 / current_sites as f64).log2().abs();
                let duration = num_doublings * doubling_time;
                Ok(Phase { target_sites: Some(target), doubling_time, duration })
            }
            // n + t -> compute doubling time
            (Some(target), None, Some(duration)) => {
                let num_doublings = (target as f64 / current_sites as f64).log2().abs();
                let doubling_time = if num_doublings > 0.0 { duration / num_doublings } else { 1.0 };
                Ok(Phase { target_sites: Some(target), doubling_time, duration })
            }
            // just t -> hold phase
            (None, _, Some(duration)) => {
                Ok(Phase { target_sites: None, doubling_time: 1.0, duration })
            }
            // all three -> use n + dt, warn if t inconsistent
            (Some(target), Some(doubling_time), Some(duration)) => {
                let num_doublings = (target as f64 / current_sites as f64).log2().abs();
                let computed = num_doublings * doubling_time;
                if (computed - duration).abs() > 0.1 {
                    eprintln!(
                        "Warning: t={:.1}s doesn't match computed {:.1}s from n={},dt={:.1}; using t={:.1}",
                        duration, computed, target, doubling_time, duration
                    );
                }
                Ok(Phase { target_sites: Some(target), doubling_time, duration })
            }
            _ => anyhow::bail!(
                "invalid phase: provide n+dt, n+t, or just t for hold. Got: {:?}",
                self
            ),
        }
    }
}

fn load_spec(path: &PathBuf) -> anyhow::Result<AnimSpec> {
    let contents = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read spec file: {:?}", path))?;
    serde_yaml::from_str(&contents)
        .with_context(|| format!("failed to parse spec file: {:?}", path))
}

/// Parse a phase spec string like "n=25600,dt=1" or "t=5"
fn parse_phase(spec: &str, current_sites: usize) -> anyhow::Result<Phase> {
    let mut n: Option<usize> = None;
    let mut dt: Option<f64> = None;
    let mut t: Option<f64> = None;

    for part in spec.split(',') {
        let part = part.trim();
        if let Some(val) = part.strip_prefix("n=") {
            n = Some(val.parse().context("invalid n")?);
        } else if let Some(val) = part.strip_prefix("dt=") {
            dt = Some(val.parse().context("invalid dt")?);
        } else if let Some(val) = part.strip_prefix("t=") {
            t = Some(val.parse().context("invalid t")?);
        } else {
            anyhow::bail!("unknown phase key in '{}' (expected n=, dt=, or t=)", part);
        }
    }

    match (n, dt, t) {
        // n + dt -> compute duration
        (Some(target), Some(doubling_time), None) => {
            let num_doublings = (target as f64 / current_sites as f64).log2().abs();
            let duration = num_doublings * doubling_time;
            Ok(Phase { target_sites: Some(target), doubling_time, duration })
        }
        // n + t -> compute doubling time
        (Some(target), None, Some(duration)) => {
            let num_doublings = (target as f64 / current_sites as f64).log2().abs();
            let doubling_time = if num_doublings > 0.0 { duration / num_doublings } else { 1.0 };
            Ok(Phase { target_sites: Some(target), doubling_time, duration })
        }
        // just t -> hold phase
        (None, _, Some(duration)) => {
            Ok(Phase { target_sites: None, doubling_time: 1.0, duration })
        }
        // all three -> use n + dt, warn if t inconsistent
        (Some(target), Some(doubling_time), Some(duration)) => {
            let num_doublings = (target as f64 / current_sites as f64).log2().abs();
            let computed = num_doublings * doubling_time;
            if (computed - duration).abs() > 0.1 {
                eprintln!(
                    "Warning: t={:.1}s doesn't match computed {:.1}s from n={},dt={:.1}; using t={:.1}",
                    duration, computed, target, doubling_time, duration
                );
            }
            Ok(Phase { target_sites: Some(target), doubling_time, duration })
        }
        _ => anyhow::bail!(
            "invalid phase '{}': provide n+dt, n+t, or just t for hold",
            spec
        ),
    }
}

/// Resolve target dimensions from spec and CLI overrides.
/// CLI args take precedence over spec values.
/// If only one dimension is given, the other is computed to preserve aspect ratio.
fn resolve_dimensions(
    orig_w: u32,
    orig_h: u32,
    spec_w: Option<u32>,
    spec_h: Option<u32>,
    cli_w: Option<u32>,
    cli_h: Option<u32>,
) -> (u32, u32) {
    let w = cli_w.or(spec_w);
    let h = cli_h.or(spec_h);
    let (rw, rh) = match (w, h) {
        (Some(tw), Some(th)) => (tw, th),
        (Some(tw), None) => {
            let th = (orig_h as f64 * tw as f64 / orig_w as f64).round() as u32;
            (tw, th)
        }
        (None, Some(th)) => {
            let tw = (orig_w as f64 * th as f64 / orig_h as f64).round() as u32;
            (tw, th)
        }
        (None, None) => (orig_w, orig_h),
    };
    // x264 requires even dimensions
    (rw & !1, rh & !1)
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

    /// Ending number of sites (legacy single-phase mode)
    #[arg(long, default_value = "1000")]
    sites_end: usize,

    /// Doubling time in seconds (legacy single-phase mode)
    #[arg(long, default_value = "2.0")]
    doubling_time: f64,

    /// Animation speed (pixels per second)
    #[arg(long, default_value = "15.0")]
    speed: f64,

    /// Duration in seconds (legacy single-phase mode)
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

    /// Animation phase: n=<sites>,dt=<secs> | n=<sites>,t=<secs> | t=<secs> (hold)
    #[arg(short = 'p', long = "phase")]
    phase: Vec<String>,

    /// YAML spec file for animation phases
    #[arg(long)]
    spec: Option<PathBuf>,

    /// Output image width (scales input; preserves aspect ratio if only one dim given)
    #[arg(long)]
    width: Option<u32>,

    /// Output image height (scales input; preserves aspect ratio if only one dim given)
    #[arg(long)]
    height: Option<u32>,

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

    /// Draw site positions as dots on each frame
    #[arg(long)]
    show_sites: bool,

    /// Centroid pull strength (0=disabled, ~1-10 steers sites toward cell centers)
    #[arg(long, default_value = "0.0")]
    centroid_pull: f64,

    /// Growth strategy: max | weighted | isolated | centroid | farthest
    #[arg(long, default_value = "max")]
    split_strategy: String,

    /// Use legacy multi-pass compute (for benchmarking vs merged single-pass)
    #[arg(long)]
    multi_pass: bool,
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    // Set up SIGINT handler
    let interrupted = Arc::new(AtomicBool::new(false));
    {
        let interrupted = interrupted.clone();
        ctrlc::set_handler(move || {
            interrupted.store(true, Ordering::SeqCst);
        }).expect("Failed to set Ctrl-C handler");
    }

    // Load spec file early (if provided) so we can use it for dimensions and phases
    let spec = args.spec.as_ref().map(load_spec).transpose()?;

    // Load input image
    println!("Loading image: {:?}", args.input);
    let mut image = image::open(&args.input)?.to_rgb8();
    let (orig_w, orig_h) = image.dimensions();

    // Resolve target dimensions (CLI overrides spec)
    let (spec_w, spec_h) = spec.as_ref().map_or((None, None), |s| (s.width, s.height));
    let (target_w, target_h) = resolve_dimensions(orig_w, orig_h, spec_w, spec_h, args.width, args.height);

    if (target_w, target_h) != (orig_w, orig_h) {
        println!("Resizing {}x{} -> {}x{}", orig_w, orig_h, target_w, target_h);
        image = image::imageops::resize(&image, target_w, target_h, image::imageops::FilterType::Lanczos3);
    }

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
    let make_cpu = || -> Box<dyn ComputeBackend> {
        if args.multi_pass {
            println!("Using CPU backend (Rayon, multi-pass)");
            Box::new(CpuBackend::new_multi_pass())
        } else {
            println!("Using CPU backend (Rayon, merged)");
            Box::new(CpuBackend::new())
        }
    };

    #[cfg(feature = "gpu")]
    let mut backend: Box<dyn ComputeBackend> = if args.gpu {
        println!("Using GPU backend (wgpu)");
        match GpuBackend::new() {
            Ok(gpu) => Box::new(gpu),
            Err(e) => {
                eprintln!("Warning: GPU initialization failed: {}. Falling back to CPU.", e);
                make_cpu()
            }
        }
    } else {
        make_cpu()
    };

    #[cfg(not(feature = "gpu"))]
    let mut backend: Box<dyn ComputeBackend> = {
        if args.gpu {
            eprintln!("Warning: GPU feature not enabled. Using CPU backend.");
        }
        make_cpu()
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

    // Build phases from spec file, inline -p args, or legacy args
    // Parse split strategy (CLI overrides spec)
    let cli_split_strategy: SplitStrategy = args.split_strategy.parse()
        .map_err(|e: String| anyhow::anyhow!(e))?;

    let (sites_start, fps, speed, seed, show_sites, centroid_pull, split_strategy, phases) = if let Some(ref spec) = spec {
        let mut phases = Vec::new();
        let mut current = spec.start;
        for ps in &spec.phases {
            let phase = ps.to_phase(current)?;
            if let Some(target) = phase.target_sites {
                current = target;
            }
            phases.push(phase);
        }
        let show = args.show_sites || spec.show_sites.unwrap_or(false);
        let pull = if args.centroid_pull != 0.0 { args.centroid_pull } else { spec.centroid_pull.unwrap_or(0.0) };
        let strategy = if args.split_strategy != "max" {
            cli_split_strategy
        } else {
            spec.split_strategy.as_ref()
                .map(|s| s.parse::<SplitStrategy>())
                .transpose()
                .map_err(|e| anyhow::anyhow!(e))?
                .unwrap_or(cli_split_strategy)
        };
        (spec.start, spec.fps, spec.speed, spec.seed, show, pull, strategy, phases)
    } else if !args.phase.is_empty() {
        let mut phases = Vec::new();
        let mut current = args.sites_start;
        for spec in &args.phase {
            let phase = parse_phase(spec, current)?;
            if let Some(target) = phase.target_sites {
                current = target;
            }
            phases.push(phase);
        }
        (args.sites_start, args.fps, args.speed, args.seed, args.show_sites, args.centroid_pull, cli_split_strategy, phases)
    } else {
        // Legacy single-phase mode
        let phases = vec![Phase {
            target_sites: Some(args.sites_end),
            doubling_time: args.doubling_time,
            duration: args.duration,
        }];
        (args.sites_start, args.fps, args.speed, args.seed, args.show_sites, args.centroid_pull, cli_split_strategy, phases)
    };

    // Initialize sites with seeded RNG for reproducibility
    let mut sites = SiteCollection::random(sites_start, width as f64, height as f64, seed);
    println!("Using seed: {}", seed);

    let total_duration: f64 = phases.iter().map(|p| p.duration).sum();
    let total_frames: usize = phases.iter()
        .map(|p| (p.duration * fps as f64).round() as usize)
        .sum();
    let dt = 1.0 / fps as f64;

    println!(
        "Rendering {} frames at {} fps ({:.1}s duration, {} phase{})",
        total_frames, fps, total_duration,
        phases.len(), if phases.len() == 1 { "" } else { "s" }
    );

    // Print phase summary
    let mut phase_start_sites = sites_start;
    for (i, phase) in phases.iter().enumerate() {
        match phase.target_sites {
            Some(target) => {
                let direction = if target > phase_start_sites { "grow" } else { "shrink" };
                println!(
                    "  Phase {}: {} {} -> {} sites over {:.1}s (dt={:.1}s)",
                    i + 1, direction, phase_start_sites, target, phase.duration, phase.doubling_time
                );
                phase_start_sites = target;
            }
            None => {
                println!(
                    "  Phase {}: hold {} sites for {:.1}s",
                    i + 1, phase_start_sites, phase.duration
                );
            }
        }
    }

    // Set up progress bar
    let progress = ProgressBar::new(total_frames as u64);
    progress.set_style(
        ProgressStyle::default_bar()
            .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {pos}/{len} ({eta})")?
            .progress_chars("#>-"),
    );

    // Spawn encoder process, pipe raw frames into it
    let mut encoder = spawn_encoder(output, &args.format, width, height, fps)?;
    let mut frames_rendered: usize = 0;
    let render_start = Instant::now();

    // Per-frame timing data: (frame_index, site_count, ms)
    let mut frame_timings: Vec<(usize, usize, f64)> = Vec::with_capacity(total_frames);

    // Render frames, piping each directly into the encoder
    'render: for phase in &phases {
        let phase_frames = (phase.duration * fps as f64).round() as usize;
        let target = phase.target_sites.unwrap_or(sites.len());

        // Reset fractional accumulator at phase boundary for clean transitions
        sites.fractional_sites = 0.0;

        for _ in 0..phase_frames {
            // Check for interrupt
            if interrupted.load(Ordering::Relaxed) {
                progress.abandon_with_message("Interrupted");
                eprintln!(
                    "Interrupted after {} of {} frames, finalizing partial output...",
                    frames_rendered, total_frames
                );
                break 'render;
            }

            let frame_start = Instant::now();
            let n_sites = sites.len();

            // Compute Voronoi (before step, so we have centroids for steering)
            let positions = sites.positions();
            let result = backend.compute(&image, &positions)?;

            // Step physics (with centroid pull if enabled)
            sites.step(
                speed, dt, width as f64, height as f64,
                Some(&result.cell_centroids), centroid_pull,
            );

            // Gradually adjust site count (skip if hold or already at target)
            if target != sites.len() {
                sites.adjust_count(
                    target,
                    phase.doubling_time,
                    dt,
                    Some(&result.cell_areas),
                    split_strategy,
                    Some(&result.cell_centroids),
                    Some(result.farthest_point),
                );
            }

            // Render frame, optionally with site markers
            let mut frame_image = result.to_image();
            if show_sites {
                draw_sites(&mut frame_image, &positions);
            }
            encoder.write_frame(frame_image.as_raw())?;

            let frame_ms = frame_start.elapsed().as_secs_f64() * 1000.0;
            frame_timings.push((frames_rendered, n_sites, frame_ms));
            frames_rendered += 1;

            progress.inc(1);
        }
    }

    if frames_rendered == 0 {
        eprintln!("No frames rendered.");
        return Ok(());
    }

    if !interrupted.load(Ordering::Relaxed) {
        progress.finish_with_message("Rendering complete");
    }

    // Close stdin to signal EOF, wait for encoder to finish
    let status_msg = encoder.finish()?;

    let total_wall = render_start.elapsed();
    let avg_fps = frames_rendered as f64 / total_wall.as_secs_f64();

    let partial = if interrupted.load(Ordering::Relaxed) { "partial" } else { "complete" };
    println!(
        "Output saved to: {:?} ({} frames, {}{})",
        output, frames_rendered, partial, status_msg
    );
    println!(
        "Render time: {:.1}s wall, {:.2} fps avg",
        total_wall.as_secs_f64(), avg_fps,
    );

    // Print timing summary by site-count buckets
    if !frame_timings.is_empty() {
        println!("\nFrame timing by site count:");
        println!("{:>8} {:>8} {:>8} {:>8} {:>6}", "sites", "frames", "avg_ms", "max_ms", "fps");

        // Bucket by powers of 2
        let mut buckets: std::collections::BTreeMap<usize, Vec<f64>> = std::collections::BTreeMap::new();
        for &(_, n_sites, ms) in &frame_timings {
            let bucket = if n_sites == 0 { 0 } else { 1 << ((n_sites as f64).log2().floor() as u32) };
            buckets.entry(bucket).or_default().push(ms);
        }
        for (bucket, times) in &buckets {
            let count = times.len();
            let avg = times.iter().sum::<f64>() / count as f64;
            let max = times.iter().cloned().fold(0.0f64, f64::max);
            let fps = 1000.0 / avg;
            println!("{:>8} {:>8} {:>8.1} {:>8.1} {:>6.1}", bucket, count, avg, max, fps);
        }
    }
    Ok(())
}

/// Draw 3x3 black dots at each site position
fn draw_sites(image: &mut image::RgbImage, sites: &[Position]) {
    let (w, h) = (image.width() as i32, image.height() as i32);
    for site in sites {
        let cx = site.x as i32;
        let cy = site.y as i32;
        for dy in -1..=1 {
            for dx in -1..=1 {
                let px = cx + dx;
                let py = cy + dy;
                if px >= 0 && px < w && py >= 0 && py < h {
                    image.put_pixel(px as u32, py as u32, image::Rgb([0, 0, 0]));
                }
            }
        }
    }
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

/// Streaming frame encoder — pipes raw RGB data directly into ffmpeg or GIF encoder.
/// No temp files, no frame accumulation in memory.
enum FrameEncoder {
    Mp4 {
        child: std::process::Child,
    },
    Gif {
        encoder: gif::Encoder<std::fs::File>,
        width: u16,
        height: u16,
        frame_delay: u16,
    },
}

impl FrameEncoder {
    /// Write one frame's raw RGB pixel data
    fn write_frame(&mut self, rgb_data: &[u8]) -> anyhow::Result<()> {
        match self {
            FrameEncoder::Mp4 { child } => {
                use std::io::Write;
                let stdin = child.stdin.as_mut()
                    .ok_or_else(|| anyhow::anyhow!("ffmpeg stdin closed"))?;
                stdin.write_all(rgb_data)
                    .context("failed to write frame to ffmpeg")?;
            }
            FrameEncoder::Gif { encoder, width, height, frame_delay } => {
                let w = *width as u32;
                let h = *height as u32;
                let delay = *frame_delay;

                // Convert RGB to indexed color (simple quantization)
                let mut pixels: Vec<u8> = Vec::with_capacity((w * h) as usize);
                let mut palette: Vec<[u8; 3]> = Vec::new();

                for chunk in rgb_data.chunks_exact(3) {
                    let rgb = [chunk[0], chunk[1], chunk[2]];
                    let idx = palette.iter().position(|&c| c == rgb).unwrap_or_else(|| {
                        if palette.len() < 256 {
                            palette.push(rgb);
                            palette.len() - 1
                        } else {
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

                while palette.len() < 256 {
                    palette.push([0, 0, 0]);
                }
                let flat_palette: Vec<u8> = palette.iter().flat_map(|c| c.iter().copied()).collect();

                let mut frame = gif::Frame::from_palette_pixels(
                    w as u16, h as u16, pixels, flat_palette, None,
                );
                frame.delay = delay;
                encoder.write_frame(&frame)?;
            }
        }
        Ok(())
    }

    /// Close the encoder and wait for it to finish. Returns a status suffix string.
    fn finish(self) -> anyhow::Result<String> {
        match self {
            FrameEncoder::Mp4 { mut child } => {
                // Drop stdin to signal EOF
                drop(child.stdin.take());
                let status = child.wait()?;
                if !status.success() {
                    anyhow::bail!("ffmpeg exited with {}", status);
                }
                Ok(String::new())
            }
            FrameEncoder::Gif { .. } => {
                // GIF encoder flushes on drop
                Ok(String::new())
            }
        }
    }
}

/// Spawn a streaming encoder process
fn spawn_encoder(
    output: &Path,
    format: &OutputFormat,
    width: u32,
    height: u32,
    fps: u32,
) -> anyhow::Result<FrameEncoder> {
    match format {
        OutputFormat::Mp4 => {
            use std::process::{Command, Stdio};
            let child = Command::new("ffmpeg")
                .args([
                    "-y",
                    "-f", "rawvideo",
                    "-pix_fmt", "rgb24",
                    "-s", &format!("{}x{}", width, height),
                    "-r", &fps.to_string(),
                    "-i", "-", // read from stdin
                    "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
                    "-c:v", "libx264",
                    "-pix_fmt", "yuv420p",
                    "-crf", "18",
                    output.to_str().unwrap(),
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .context("failed to spawn ffmpeg")?;
            Ok(FrameEncoder::Mp4 { child })
        }
        OutputFormat::Gif => {
            use gif::{Encoder, Repeat};
            let file = std::fs::File::create(output)?;
            let mut encoder = Encoder::new(file, width as u16, height as u16, &[])?;
            encoder.set_repeat(Repeat::Infinite)?;
            let frame_delay = (100 / fps).max(1) as u16;
            Ok(FrameEncoder::Gif { encoder, width: width as u16, height: height as u16, frame_delay })
        }
    }
}
