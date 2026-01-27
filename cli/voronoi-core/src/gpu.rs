//! GPU-based Voronoi computation using wgpu.
//!
//! Uses a compute shader for brute-force nearest-site calculation,
//! matching the CPU algorithm exactly for bitwise identical output.

use crate::{Position, Rgb, Result, VoronoiError, VoronoiResult};
use crate::voronoi::ComputeBackend;
use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

/// Per-site data for compute shader
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct SiteData {
    x: f32,
    y: f32,
}

/// GPU backend using wgpu compute shaders
pub struct GpuBackend {
    device: wgpu::Device,
    queue: wgpu::Queue,
    compute_pipeline: wgpu::ComputePipeline,
    bind_group_layout: wgpu::BindGroupLayout,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    width: u32,
    height: u32,
    num_sites: u32,
    _pad: u32,
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

        // Create bind group layout
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Voronoi Bind Group Layout"),
            entries: &[
                // Uniforms
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // Sites buffer
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // Output buffer (cell assignments)
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        // Create shader module
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Voronoi Compute Shader"),
            source: wgpu::ShaderSource::Wgsl(COMPUTE_SHADER.into()),
        });

        // Create pipeline layout
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Voronoi Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        // Create compute pipeline
        let compute_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Voronoi Compute Pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        Ok(Self {
            device,
            queue,
            compute_pipeline,
            bind_group_layout,
        })
    }
}

const COMPUTE_SHADER: &str = r#"
struct Uniforms {
    width: u32,
    height: u32,
    num_sites: u32,
    _pad: u32,
}

struct Site {
    x: f32,
    y: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> sites: array<Site>;
@group(0) @binding(2) var<storage, read_write> output: array<i32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let x = global_id.x;
    let y = global_id.y;

    if (x >= uniforms.width || y >= uniforms.height) {
        return;
    }

    // Use pixel centers (x+0.5, y+0.5) to match CPU
    let px = f32(x) + 0.5;
    let py = f32(y) + 0.5;

    var min_dist = 3.402823e+38f; // f32::MAX approximation
    var nearest: i32 = 0;

    for (var i: u32 = 0u; i < uniforms.num_sites; i = i + 1u) {
        let site = sites[i];
        let dx = px - site.x;
        let dy = py - site.y;
        let dist = dx * dx + dy * dy;
        // Use < (not <=) so lower index wins ties (matches CPU behavior)
        if (dist < min_dist) {
            min_dist = dist;
            nearest = i32(i);
        }
    }

    let idx = y * uniforms.width + x;
    output[idx] = nearest;
}
"#;

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
        let num_pixels = (width * height) as usize;
        let num_sites = sites.len();

        // Create uniform buffer
        let uniforms = Uniforms {
            width,
            height,
            num_sites: num_sites as u32,
            _pad: 0,
        };
        let uniform_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Uniform Buffer"),
            contents: bytemuck::bytes_of(&uniforms),
            usage: wgpu::BufferUsages::UNIFORM,
        });

        // Create sites buffer
        let site_data: Vec<SiteData> = sites
            .iter()
            .map(|s| SiteData {
                x: s.x as f32,
                y: s.y as f32,
            })
            .collect();
        let sites_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Sites Buffer"),
            contents: bytemuck::cast_slice(&site_data),
            usage: wgpu::BufferUsages::STORAGE,
        });

        // Create output buffer
        let output_buffer_size = (num_pixels * std::mem::size_of::<i32>()) as u64;
        let output_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Output Buffer"),
            size: output_buffer_size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });

        // Create staging buffer for reading back
        let staging_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Staging Buffer"),
            size: output_buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        // Create bind group
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Voronoi Bind Group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: sites_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: output_buffer.as_entire_binding(),
                },
            ],
        });

        // Create command encoder
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Voronoi Encoder"),
        });

        // Dispatch compute shader
        {
            let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Voronoi Compute Pass"),
                timestamp_writes: None,
            });
            compute_pass.set_pipeline(&self.compute_pipeline);
            compute_pass.set_bind_group(0, &bind_group, &[]);

            // Dispatch enough workgroups to cover all pixels
            // Workgroup size is 16x16
            let workgroups_x = (width + 15) / 16;
            let workgroups_y = (height + 15) / 16;
            compute_pass.dispatch_workgroups(workgroups_x, workgroups_y, 1);
        }

        // Copy output to staging buffer
        encoder.copy_buffer_to_buffer(&output_buffer, 0, &staging_buffer, 0, output_buffer_size);

        // Submit and wait
        self.queue.submit(std::iter::once(encoder.finish()));

        // Read back results
        let buffer_slice = staging_buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
            tx.send(result).unwrap();
        });
        self.device.poll(wgpu::Maintain::Wait);
        rx.recv().unwrap().map_err(|e| VoronoiError::Gpu(format!("Buffer map failed: {:?}", e)))?;

        let data = buffer_slice.get_mapped_range();
        let cell_of: Vec<i32> = bytemuck::cast_slice(&data).to_vec();
        drop(data);
        staging_buffer.unmap();

        // Compute colors by averaging image pixels per cell
        let mut r_sums = vec![0u64; num_sites];
        let mut g_sums = vec![0u64; num_sites];
        let mut b_sums = vec![0u64; num_sites];
        let mut cell_areas = vec![0u32; num_sites];

        for (i, &cell) in cell_of.iter().enumerate() {
            if cell >= 0 && (cell as usize) < num_sites {
                let cell = cell as usize;
                let x = (i % width as usize) as u32;
                let y = (i / width as usize) as u32;
                let pixel = image.get_pixel(x, y);

                r_sums[cell] += pixel[0] as u64;
                g_sums[cell] += pixel[1] as u64;
                b_sums[cell] += pixel[2] as u64;
                cell_areas[cell] += 1;
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
