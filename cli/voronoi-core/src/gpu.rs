//! GPU-based Voronoi computation using wgpu.
//!
//! Uses the cone-rendering technique: each site is rendered as an inverted cone,
//! and the depth buffer automatically finds the closest site per pixel.

use crate::{Position, Rgb, Result, VoronoiError, VoronoiResult};
use crate::voronoi::ComputeBackend;
use bytemuck::{Pod, Zeroable};

/// Vertex data for cone rendering
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    position: [f32; 2],  // Position on unit circle (or 0,0 for apex)
    z: f32,              // 0 at apex, 1 at base
}

/// Per-instance site data
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct SiteInstance {
    pos: [f32; 2],
    index: u32,
    _pad: u32,
}

const CONE_SEGMENTS: usize = 64;

/// Generate cone vertex data (triangle fan)
fn generate_cone_vertices() -> Vec<Vertex> {
    let mut vertices = Vec::with_capacity(CONE_SEGMENTS + 2);

    // Apex at center
    vertices.push(Vertex {
        position: [0.0, 0.0],
        z: 0.0,
    });

    // Base vertices around the circle
    for i in 0..=CONE_SEGMENTS {
        let angle = (i as f32 / CONE_SEGMENTS as f32) * std::f32::consts::TAU;
        vertices.push(Vertex {
            position: [angle.cos(), angle.sin()],
            z: 1.0,
        });
    }

    vertices
}

/// Generate index buffer for triangle fan
fn generate_cone_indices() -> Vec<u16> {
    let mut indices = Vec::with_capacity(CONE_SEGMENTS * 3);

    for i in 0..CONE_SEGMENTS {
        indices.push(0);  // Apex
        indices.push((i + 1) as u16);
        indices.push((i + 2) as u16);
    }

    indices
}

/// GPU backend using wgpu
pub struct GpuBackend {
    device: wgpu::Device,
    queue: wgpu::Queue,
    render_pipeline: wgpu::RenderPipeline,
    vertex_buffer: wgpu::Buffer,
    index_buffer: wgpu::Buffer,
    index_count: u32,
    uniform_buffer: wgpu::Buffer,
    uniform_bind_group: wgpu::BindGroup,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    resolution: [f32; 2],
    cone_height: f32,
    _pad: f32,
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

        // Create vertex buffer
        let vertices = generate_cone_vertices();
        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Cone Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        // Create index buffer
        let indices = generate_cone_indices();
        let index_count = indices.len() as u32;
        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Cone Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        // Create uniform buffer
        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Uniform Buffer"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Create bind group layout
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Uniform Bind Group Layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        // Create bind group
        let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Uniform Bind Group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
        });

        // Create shader module
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Voronoi Shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER_SOURCE.into()),
        });

        // Create pipeline layout
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Render Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        // Create render pipeline
        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Voronoi Render Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[
                    // Vertex buffer (per-vertex)
                    wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<Vertex>() as u64,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &[
                            wgpu::VertexAttribute {
                                offset: 0,
                                shader_location: 0,
                                format: wgpu::VertexFormat::Float32x2,
                            },
                            wgpu::VertexAttribute {
                                offset: 8,
                                shader_location: 1,
                                format: wgpu::VertexFormat::Float32,
                            },
                        ],
                    },
                    // Instance buffer (per-instance)
                    wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<SiteInstance>() as u64,
                        step_mode: wgpu::VertexStepMode::Instance,
                        attributes: &[
                            wgpu::VertexAttribute {
                                offset: 0,
                                shader_location: 2,
                                format: wgpu::VertexFormat::Float32x2,
                            },
                            wgpu::VertexAttribute {
                                offset: 8,
                                shader_location: 3,
                                format: wgpu::VertexFormat::Uint32,
                            },
                        ],
                    },
                ],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Ok(Self {
            device,
            queue,
            render_pipeline,
            vertex_buffer,
            index_buffer,
            index_count,
            uniform_buffer,
            uniform_bind_group,
        })
    }
}

// Add buffer initialization trait
use wgpu::util::DeviceExt;

const SHADER_SOURCE: &str = r#"
struct Uniforms {
    resolution: vec2<f32>,
    cone_height: f32,
    _pad: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
    @location(0) cone_vertex: vec2<f32>,
    @location(1) cone_z: f32,
    @location(2) site_pos: vec2<f32>,
    @location(3) site_index: u32,
}

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) site_index: f32,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;

    // Scale cone to cover max possible distance
    let radius = in.cone_z * uniforms.cone_height;
    let pos = in.site_pos + in.cone_vertex * radius;

    // Convert to clip space (-1 to 1)
    let clip_pos = (pos / uniforms.resolution) * 2.0 - 1.0;

    // Z is the distance from site (for depth testing)
    // Flip Y for wgpu coordinate system
    out.clip_position = vec4<f32>(clip_pos.x, -clip_pos.y, in.cone_z, 1.0);
    out.site_index = f32(in.site_index);

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Encode site index as RGB (supports up to 16M sites)
    let idx = in.site_index;
    let r = idx % 256.0;
    let g = floor(idx / 256.0) % 256.0;
    let b = floor(idx / 65536.0) % 256.0;
    return vec4<f32>(r / 255.0, g / 255.0, b / 255.0, 1.0);
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

        // Update uniforms
        let cone_height = ((width * width + height * height) as f32).sqrt();
        let uniforms = Uniforms {
            resolution: [width as f32, height as f32],
            cone_height,
            _pad: 0.0,
        };
        self.queue.write_buffer(&self.uniform_buffer, 0, bytemuck::bytes_of(&uniforms));

        // Create instance buffer with site data
        let instances: Vec<SiteInstance> = sites
            .iter()
            .enumerate()
            .map(|(i, site)| SiteInstance {
                pos: [site.x as f32, site.y as f32],
                index: i as u32,
                _pad: 0,
            })
            .collect();

        let instance_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Site Instance Buffer"),
            contents: bytemuck::cast_slice(&instances),
            usage: wgpu::BufferUsages::VERTEX,
        });

        // Create render target texture
        let render_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Voronoi Render Target"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let render_view = render_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Create depth texture
        let depth_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Depth Texture"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth32Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let depth_view = depth_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Create output buffer for reading back
        let output_buffer_size = (width * height * 4) as u64;
        let output_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Output Buffer"),
            size: output_buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        // Create command encoder and render
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Voronoi Encoder"),
        });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Voronoi Render Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &render_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Discard,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            render_pass.set_pipeline(&self.render_pipeline);
            render_pass.set_bind_group(0, &self.uniform_bind_group, &[]);
            render_pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
            render_pass.set_vertex_buffer(1, instance_buffer.slice(..));
            render_pass.set_index_buffer(self.index_buffer.slice(..), wgpu::IndexFormat::Uint16);
            render_pass.draw_indexed(0..self.index_count, 0, 0..num_sites as u32);
        }

        // Copy render target to output buffer
        encoder.copy_texture_to_buffer(
            wgpu::ImageCopyTexture {
                texture: &render_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::ImageCopyBuffer {
                buffer: &output_buffer,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(width * 4),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );

        // Submit and wait
        self.queue.submit(std::iter::once(encoder.finish()));

        // Read back the results
        let buffer_slice = output_buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
            tx.send(result).unwrap();
        });
        self.device.poll(wgpu::Maintain::Wait);
        rx.recv().unwrap().map_err(|e| VoronoiError::Gpu(format!("Buffer map failed: {:?}", e)))?;

        let data = buffer_slice.get_mapped_range();
        let pixels: &[u8] = &data;

        // Decode site indices from RGB
        let mut cell_of = vec![0i32; num_pixels];
        for i in 0..num_pixels {
            let px = i * 4;
            cell_of[i] = pixels[px] as i32
                + (pixels[px + 1] as i32) * 256
                + (pixels[px + 2] as i32) * 65536;
        }

        drop(data);
        output_buffer.unmap();

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
