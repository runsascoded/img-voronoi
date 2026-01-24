/**
 * WebGL-accelerated Voronoi diagram using cone rendering.
 *
 * The technique: render each site as an inverted cone (apex at site, z increases
 * with distance). The depth buffer automatically finds the closest site per pixel.
 * Fragment shader outputs site index encoded as color.
 *
 * Reference: https://nullprogram.com/blog/2014/06/01/
 */

type RGB = [number, number, number]

interface Position {
  x: number
  y: number
}

const CONE_SEGMENTS = 64  // Triangles per cone

// Vertex shader - positions cone vertices and passes site index
const VERTEX_SHADER = `
  attribute vec2 a_coneVertex;  // Unit cone vertex (x, y on unit circle)
  attribute float a_coneZ;       // Z coordinate (0 at apex, 1 at base)
  attribute vec2 a_sitePos;      // Site position (instanced)
  attribute float a_siteIndex;   // Site index for color encoding (instanced)

  uniform vec2 u_resolution;
  uniform float u_coneHeight;    // Max distance (diagonal of image)

  varying float v_siteIndex;

  void main() {
    // Scale cone to cover max possible distance
    float radius = a_coneZ * u_coneHeight;
    vec2 pos = a_sitePos + a_coneVertex * radius;

    // Convert to clip space (-1 to 1)
    vec2 clipPos = (pos / u_resolution) * 2.0 - 1.0;

    // Z is the distance from site (for depth testing)
    // Flip Y for WebGL coordinate system
    gl_Position = vec4(clipPos.x, -clipPos.y, a_coneZ, 1.0);

    v_siteIndex = a_siteIndex;
  }
`

// Fragment shader - outputs site index as color
const FRAGMENT_SHADER = `
  precision highp float;

  varying float v_siteIndex;

  void main() {
    // Encode site index as RGB (supports up to 16M sites)
    float idx = v_siteIndex;
    float r = mod(idx, 256.0);
    float g = mod(floor(idx / 256.0), 256.0);
    float b = mod(floor(idx / 65536.0), 256.0);
    gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
  }
`

function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Failed to create shader')

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error('Shader compile error: ' + info)
  }

  return shader
}

function createProgram(gl: WebGLRenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new Error('Failed to create program')

  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error('Program link error: ' + info)
  }

  return program
}

/**
 * Generate unit cone vertices (triangle fan from apex)
 */
function generateConeGeometry(segments: number): { vertices: Float32Array; zCoords: Float32Array } {
  // Each triangle: apex + 2 base vertices
  // Total vertices: 1 (apex) + segments * 2 (but we use triangle fan, so segments + 2)
  const numVertices = segments + 2

  const vertices = new Float32Array(numVertices * 2)
  const zCoords = new Float32Array(numVertices)

  // Apex at center
  vertices[0] = 0
  vertices[1] = 0
  zCoords[0] = 0

  // Base vertices around the circle
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    const idx = (i + 1) * 2
    vertices[idx] = Math.cos(angle)
    vertices[idx + 1] = Math.sin(angle)
    zCoords[i + 1] = 1.0
  }

  return { vertices, zCoords }
}

export class VoronoiWebGL {
  private gl: WebGLRenderingContext
  private program: WebGLProgram
  private ext: ANGLE_instanced_arrays

  // Buffers
  private coneVertexBuffer: WebGLBuffer
  private coneZBuffer: WebGLBuffer
  private sitePosBuffer: WebGLBuffer
  private siteIndexBuffer: WebGLBuffer

  // Attribute locations
  private a_coneVertex: number
  private a_coneZ: number
  private a_sitePos: number
  private a_siteIndex: number

  // Uniform locations
  private u_resolution: WebGLUniformLocation
  private u_coneHeight: WebGLUniformLocation

  private coneVertexCount: number
  private width: number
  private height: number

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', {
      antialias: false,
      depth: true,
      preserveDrawingBuffer: true,
    })
    if (!gl) throw new Error('WebGL not supported')

    this.gl = gl
    this.width = canvas.width
    this.height = canvas.height

    // Get instancing extension
    const ext = gl.getExtension('ANGLE_instanced_arrays')
    if (!ext) throw new Error('ANGLE_instanced_arrays not supported')
    this.ext = ext

    // Create shaders and program
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    this.program = createProgram(gl, vertexShader, fragmentShader)

    // Get attribute locations
    this.a_coneVertex = gl.getAttribLocation(this.program, 'a_coneVertex')
    this.a_coneZ = gl.getAttribLocation(this.program, 'a_coneZ')
    this.a_sitePos = gl.getAttribLocation(this.program, 'a_sitePos')
    this.a_siteIndex = gl.getAttribLocation(this.program, 'a_siteIndex')

    // Get uniform locations
    this.u_resolution = gl.getUniformLocation(this.program, 'u_resolution')!
    this.u_coneHeight = gl.getUniformLocation(this.program, 'u_coneHeight')!

    // Create cone geometry
    const { vertices, zCoords } = generateConeGeometry(CONE_SEGMENTS)
    this.coneVertexCount = vertices.length / 2

    // Create and fill cone vertex buffer
    this.coneVertexBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.coneVertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)

    // Create and fill cone Z buffer
    this.coneZBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.coneZBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, zCoords, gl.STATIC_DRAW)

    // Create site buffers (will be filled per-render)
    this.sitePosBuffer = gl.createBuffer()!
    this.siteIndexBuffer = gl.createBuffer()!

    // Configure GL state
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LESS)
    gl.viewport(0, 0, this.width, this.height)
  }

  /**
   * Render Voronoi diagram and return cell assignments
   */
  computeCells(sites: Position[]): Int32Array {
    const { gl, ext } = this
    const numSites = sites.length

    // Prepare site data
    const sitePositions = new Float32Array(numSites * 2)
    const siteIndices = new Float32Array(numSites)

    for (let i = 0; i < numSites; i++) {
      sitePositions[i * 2] = sites[i].x
      sitePositions[i * 2 + 1] = sites[i].y
      siteIndices[i] = i
    }

    // Upload site data
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sitePosBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, sitePositions, gl.DYNAMIC_DRAW)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.siteIndexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, siteIndices, gl.DYNAMIC_DRAW)

    // Clear
    gl.clearColor(0, 0, 0, 1)
    gl.clearDepth(1.0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    // Use program
    gl.useProgram(this.program)

    // Set uniforms
    gl.uniform2f(this.u_resolution, this.width, this.height)
    const coneHeight = Math.sqrt(this.width * this.width + this.height * this.height)
    gl.uniform1f(this.u_coneHeight, coneHeight)

    // Set up cone vertex attribute
    gl.bindBuffer(gl.ARRAY_BUFFER, this.coneVertexBuffer)
    gl.enableVertexAttribArray(this.a_coneVertex)
    gl.vertexAttribPointer(this.a_coneVertex, 2, gl.FLOAT, false, 0, 0)
    ext.vertexAttribDivisorANGLE(this.a_coneVertex, 0)  // Per-vertex

    // Set up cone Z attribute
    gl.bindBuffer(gl.ARRAY_BUFFER, this.coneZBuffer)
    gl.enableVertexAttribArray(this.a_coneZ)
    gl.vertexAttribPointer(this.a_coneZ, 1, gl.FLOAT, false, 0, 0)
    ext.vertexAttribDivisorANGLE(this.a_coneZ, 0)  // Per-vertex

    // Set up site position attribute (instanced)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sitePosBuffer)
    gl.enableVertexAttribArray(this.a_sitePos)
    gl.vertexAttribPointer(this.a_sitePos, 2, gl.FLOAT, false, 0, 0)
    ext.vertexAttribDivisorANGLE(this.a_sitePos, 1)  // Per-instance

    // Set up site index attribute (instanced)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.siteIndexBuffer)
    gl.enableVertexAttribArray(this.a_siteIndex)
    gl.vertexAttribPointer(this.a_siteIndex, 1, gl.FLOAT, false, 0, 0)
    ext.vertexAttribDivisorANGLE(this.a_siteIndex, 1)  // Per-instance

    // Draw all cones in one call
    ext.drawArraysInstancedANGLE(gl.TRIANGLE_FAN, 0, this.coneVertexCount, numSites)

    // Read back pixels
    const pixels = new Uint8Array(this.width * this.height * 4)
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

    // Decode site indices from RGB (WebGL Y is flipped)
    const cellOf = new Int32Array(this.width * this.height)
    for (let i = 0; i < cellOf.length; i++) {
      const flippedI = ((this.height - 1 - Math.floor(i / this.width)) * this.width) + (i % this.width)
      const px = flippedI * 4
      cellOf[i] = pixels[px] + pixels[px + 1] * 256 + pixels[px + 2] * 65536
    }

    return cellOf
  }

  /**
   * Compute cell colors by averaging image pixels
   * Also returns cell areas (pixel counts)
   */
  computeColors(cellOf: Int32Array, imgdata: Uint8ClampedArray, numSites: number): { cellColors: RGB[]; cellAreas: Uint32Array } {
    const rSum = new Float64Array(numSites)
    const gSum = new Float64Array(numSites)
    const bSum = new Float64Array(numSites)
    const cellAreas = new Uint32Array(numSites)

    for (let i = 0; i < cellOf.length; i++) {
      const cell = cellOf[i]
      if (cell >= 0 && cell < numSites) {
        const px = i * 4
        rSum[cell] += imgdata[px]
        gSum[cell] += imgdata[px + 1]
        bSum[cell] += imgdata[px + 2]
        cellAreas[cell]++
      }
    }

    const cellColors: RGB[] = new Array(numSites)
    for (let i = 0; i < numSites; i++) {
      const count = cellAreas[i]
      if (count > 0) {
        cellColors[i] = [
          (rSum[i] / count) | 0,
          (gSum[i] / count) | 0,
          (bSum[i] / count) | 0,
        ]
      } else {
        cellColors[i] = [128, 128, 128]
      }
    }

    return { cellColors, cellAreas }
  }

  /**
   * Full Voronoi computation: cell assignment + color averaging + areas
   */
  compute(sites: Position[], imgdata: Uint8ClampedArray): { cellOf: Int32Array; cellColors: RGB[]; cellAreas: Uint32Array } {
    const cellOf = this.computeCells(sites)
    const { cellColors, cellAreas } = this.computeColors(cellOf, imgdata, sites.length)
    return { cellOf, cellColors, cellAreas }
  }

  dispose(): void {
    const { gl } = this
    gl.deleteBuffer(this.coneVertexBuffer)
    gl.deleteBuffer(this.coneZBuffer)
    gl.deleteBuffer(this.sitePosBuffer)
    gl.deleteBuffer(this.siteIndexBuffer)
    gl.deleteProgram(this.program)
  }
}
