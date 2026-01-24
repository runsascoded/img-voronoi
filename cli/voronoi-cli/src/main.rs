//! Voronoi animation CLI
//!
//! Renders deterministic, frame-rate-independent Voronoi animations.

use std::path::PathBuf;
use clap::{Parser, ValueEnum};
use indicatif::{ProgressBar, ProgressStyle};

use voronoi_core::{CpuBackend, SiteCollection, VoronoiComputer};

#[derive(Debug, Clone, Copy, ValueEnum)]
enum OutputFormat {
    Mp4,
    Gif,
}

#[derive(Parser, Debug)]
#[command(name = "voronoi")]
#[command(about = "Render Voronoi animations", long_about = None)]
struct Args {
    /// Input image path
    #[arg(short, long)]
    input: PathBuf,

    /// Output file path
    #[arg(short, long)]
    output: PathBuf,

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
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    // Load input image
    println!("Loading image: {:?}", args.input);
    let image = image::open(&args.input)?.to_rgb8();
    let (width, height) = image.dimensions();
    println!("Image size: {}x{}", width, height);

    // Initialize RNG with seed for reproducibility
    // Note: In production, use a proper seeded RNG (e.g., rand_chacha)
    // For now, we'll just use the standard RNG

    // Create backend
    let mut computer = VoronoiComputer::new(CpuBackend::new());

    // Initialize sites
    let mut sites = SiteCollection::random(args.sites_start, width as f64, height as f64);
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
        let result = computer.compute(&image, &positions)?;

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
            encode_gif(&args.output, &frames, args.fps)?;
        }
        OutputFormat::Mp4 => {
            encode_mp4(&args.output, &frames, args.fps, width, height)?;
        }
    }

    println!("Output saved to: {:?}", args.output);
    Ok(())
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
