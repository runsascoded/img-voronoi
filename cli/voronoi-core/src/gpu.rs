//! GPU-based Voronoi computation using wgpu.
//!
//! Uses a compute shader with spatial grid index for O(1)-amortized
//! nearest-site lookup per pixel, matching the CPU grid algorithm.

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

/// Grid cell offset: (start_index, count) into the flat grid_indices array
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct GridCell {
    start: u32,
    count: u32,
}

/// GPU backend using wgpu compute shaders
pub struct GpuBackend {
    device: wgpu::Device,
    queue: wgpu::Queue,
    grid_pipeline: wgpu::ComputePipeline,
    grid_bind_group_layout: wgpu::BindGroupLayout,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    width: u32,
    height: u32,
    num_sites: u32,
    grid_cols: u32,
    grid_rows: u32,
    gcell_w: f32,
    gcell_h: f32,
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

        let storage_ro = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };

        // Grid pipeline bind group layout
        let grid_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Voronoi Grid Bind Group Layout"),
            entries: &[
                // 0: Uniforms
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
                // 1: Sites
                storage_ro(1),
                // 2: Output (read_write)
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
                // 3: Grid offsets (start, count per cell)
                storage_ro(3),
                // 4: Grid indices (flat site index array)
                storage_ro(4),
            ],
        });

        let grid_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Voronoi Grid Shader"),
            source: wgpu::ShaderSource::Wgsl(GRID_SHADER.into()),
        });

        let grid_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Voronoi Grid Pipeline Layout"),
            bind_group_layouts: &[&grid_bind_group_layout],
            push_constant_ranges: &[],
        });

        let grid_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Voronoi Grid Pipeline"),
            layout: Some(&grid_pipeline_layout),
            module: &grid_shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        Ok(Self {
            device,
            queue,
            grid_pipeline,
            grid_bind_group_layout,
        })
    }
}

const GRID_SHADER: &str = r#"
struct Uniforms {
    width: u32,
    height: u32,
    num_sites: u32,
    grid_cols: u32,
    grid_rows: u32,
    gcell_w: f32,
    gcell_h: f32,
    _pad: u32,
}

struct Site {
    x: f32,
    y: f32,
}

struct GridCell {
    start: u32,
    count: u32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> sites: array<Site>;
@group(0) @binding(2) var<storage, read_write> output: array<i32>;
@group(0) @binding(3) var<storage, read> grid_offsets: array<GridCell>;
@group(0) @binding(4) var<storage, read> grid_indices: array<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let x = global_id.x;
    let y = global_id.y;

    if (x >= uniforms.width || y >= uniforms.height) {
        return;
    }

    let px = f32(x) + 0.5;
    let py = f32(y) + 0.5;

    let gc = min(u32(px / uniforms.gcell_w), uniforms.grid_cols - 1u);
    let gr = min(u32(py / uniforms.gcell_h), uniforms.grid_rows - 1u);
    let ox = px - f32(gc) * uniforms.gcell_w;
    let oy = py - f32(gr) * uniforms.gcell_h;

    var min_dist = 3.402823e+38f;
    var nearest: i32 = 0;

    for (var radius: u32 = 0u; radius < uniforms.grid_cols + uniforms.grid_rows; radius = radius + 1u) {
        let r = radius;
        // Compute ring bounds (clamped to grid)
        var r_start: u32 = 0u;
        if (gr >= r) { r_start = gr - r; }
        let r_end = min(gr + r + 1u, uniforms.grid_rows);
        var c_start: u32 = 0u;
        if (gc >= r) { c_start = gc - r; }
        let c_end = min(gc + r + 1u, uniforms.grid_cols);

        for (var ri: u32 = r_start; ri < r_end; ri = ri + 1u) {
            for (var ci: u32 = c_start; ci < c_end; ci = ci + 1u) {
                // Skip interior cells (already checked at smaller radius)
                if (radius > 0u
                    && ri > r_start && ri < r_end - 1u
                    && ci > c_start && ci < c_end - 1u) {
                    continue;
                }
                let cell_idx = ri * uniforms.grid_cols + ci;
                let cell = grid_offsets[cell_idx];
                for (var j: u32 = 0u; j < cell.count; j = j + 1u) {
                    let site_idx = grid_indices[cell.start + j];
                    let site = sites[site_idx];
                    let dx = px - site.x;
                    let dy = py - site.y;
                    let dist = dx * dx + dy * dy;
                    if (dist < min_dist) {
                        min_dist = dist;
                        nearest = i32(site_idx);
                    }
                }
            }
        }

        // Early exit: nearest site closer than any unchecked grid cell
        let rf = f32(radius);
        let min_unchecked = min(
            min(ox + rf * uniforms.gcell_w, uniforms.gcell_w * (rf + 1.0) - ox),
            min(oy + rf * uniforms.gcell_h, uniforms.gcell_h * (rf + 1.0) - oy)
        );
        if (min_dist <= min_unchecked * min_unchecked) {
            break;
        }
        // Safety: checked all grid cells
        if (r_start == 0u && c_start == 0u
            && r_end == uniforms.grid_rows && c_end == uniforms.grid_cols) {
            break;
        }
    }

    let idx = y * uniforms.width + x;
    output[idx] = nearest;
}
"#;

impl GpuBackend {
    /// Build flattened grid for GPU upload. Returns (offsets, indices, cols, rows, cell_w, cell_h).
    fn build_grid_flat(
        sites: &[Position], width: u32, height: u32,
    ) -> (Vec<GridCell>, Vec<u32>, u32, u32, f32, f32) {
        let num_sites = sites.len();
        let grid_side = (num_sites as f64).sqrt().ceil() as usize;
        let grid_cols = grid_side.max(1);
        let grid_rows = grid_side.max(1);
        let gcell_w = width as f32 / grid_cols as f32;
        let gcell_h = height as f32 / grid_rows as f32;

        // Bin sites into grid cells
        let mut cells: Vec<Vec<u32>> = vec![Vec::new(); grid_cols * grid_rows];
        for (i, site) in sites.iter().enumerate() {
            let gc = ((site.x as f32 / gcell_w) as usize).min(grid_cols - 1);
            let gr = ((site.y as f32 / gcell_h) as usize).min(grid_rows - 1);
            cells[gr * grid_cols + gc].push(i as u32);
        }

        // Flatten into offset + indices arrays
        let mut offsets = Vec::with_capacity(grid_cols * grid_rows);
        let mut indices = Vec::new();
        for cell in &cells {
            offsets.push(GridCell {
                start: indices.len() as u32,
                count: cell.len() as u32,
            });
            indices.extend_from_slice(cell);
        }

        // wgpu requires non-empty storage buffers
        if indices.is_empty() {
            indices.push(0);
        }

        (offsets, indices, grid_cols as u32, grid_rows as u32, gcell_w, gcell_h)
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
        let num_pixels = (width * height) as usize;
        let num_sites = sites.len();

        // Build grid on CPU
        let (grid_offsets, grid_indices, grid_cols, grid_rows, gcell_w, gcell_h) =
            Self::build_grid_flat(sites, width, height);

        // Create uniform buffer
        let uniforms = Uniforms {
            width,
            height,
            num_sites: num_sites as u32,
            grid_cols,
            grid_rows,
            gcell_w,
            gcell_h,
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
            .map(|s| SiteData { x: s.x as f32, y: s.y as f32 })
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

        // Create grid buffers
        let grid_offsets_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Grid Offsets Buffer"),
            contents: bytemuck::cast_slice(&grid_offsets),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let grid_indices_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Grid Indices Buffer"),
            contents: bytemuck::cast_slice(&grid_indices),
            usage: wgpu::BufferUsages::STORAGE,
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
            label: Some("Voronoi Grid Bind Group"),
            layout: &self.grid_bind_group_layout,
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
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: grid_offsets_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: grid_indices_buffer.as_entire_binding(),
                },
            ],
        });

        // Dispatch compute shader
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Voronoi Encoder"),
        });
        {
            let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Voronoi Grid Compute Pass"),
                timestamp_writes: None,
            });
            compute_pass.set_pipeline(&self.grid_pipeline);
            compute_pass.set_bind_group(0, &bind_group, &[]);
            let workgroups_x = (width + 15) / 16;
            let workgroups_y = (height + 15) / 16;
            compute_pass.dispatch_workgroups(workgroups_x, workgroups_y, 1);
        }

        // Copy output to staging buffer
        encoder.copy_buffer_to_buffer(&output_buffer, 0, &staging_buffer, 0, output_buffer_size);
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

        // CPU-side: accumulate colors, centroids, farthest point
        let img_raw = image.as_raw();
        let mut r_sums = vec![0u64; num_sites];
        let mut g_sums = vec![0u64; num_sites];
        let mut b_sums = vec![0u64; num_sites];
        let mut x_sums = vec![0u64; num_sites];
        let mut y_sums = vec![0u64; num_sites];
        let mut cell_areas = vec![0u32; num_sites];
        let mut farthest_point = Position::new(0.0, 0.0);
        let mut farthest_dist = 0.0f64;

        for (i, &cell) in cell_of.iter().enumerate() {
            if cell >= 0 && (cell as usize) < num_sites {
                let cell_usize = cell as usize;
                let x = (i % width as usize) as u32;
                let y = (i / width as usize) as u32;
                let px_offset = i * 3;

                r_sums[cell_usize] += img_raw[px_offset] as u64;
                g_sums[cell_usize] += img_raw[px_offset + 1] as u64;
                b_sums[cell_usize] += img_raw[px_offset + 2] as u64;
                x_sums[cell_usize] += 2 * x as u64 + 1;
                y_sums[cell_usize] += 2 * y as u64 + 1;
                cell_areas[cell_usize] += 1;

                let fx = x as f64 + 0.5;
                let fy = y as f64 + 0.5;
                let dx = fx - sites[cell_usize].x;
                let dy = fy - sites[cell_usize].y;
                let dist = dx * dx + dy * dy;
                if dist > farthest_dist {
                    farthest_dist = dist;
                    farthest_point = Position::new(fx, fy);
                }
            }
        }

        let mut cell_colors: Vec<Rgb> = Vec::with_capacity(num_sites);
        let mut cell_centroids: Vec<Position> = Vec::with_capacity(num_sites);
        for i in 0..num_sites {
            let count = cell_areas[i] as u64;
            if count > 0 {
                cell_colors.push([
                    (r_sums[i] / count) as u8,
                    (g_sums[i] / count) as u8,
                    (b_sums[i] / count) as u8,
                ]);
                cell_centroids.push(Position::new(
                    x_sums[i] as f64 / (2.0 * count as f64),
                    y_sums[i] as f64 / (2.0 * count as f64),
                ));
            } else {
                cell_colors.push([128, 128, 128]);
                cell_centroids.push(sites[i]);
            }
        }

        Ok(VoronoiResult {
            cell_of,
            cell_colors,
            cell_areas,
            cell_centroids,
            farthest_point,
            width,
            height,
        })
    }
}
