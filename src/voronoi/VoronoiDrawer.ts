import Voronoi, { Diagram } from 'voronoi'
import { ChoosePoint, Position } from './ChoosePoints'
import Sobel from 'sobel'
import { createSeededRandom, randomSeed } from '../utils/random'

type RGB = [number, number, number]

export type { Position }

// 4-connected neighbors (dx, dy)
const NEIGHBORS = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
] as const

export interface RenderOptions {
  usePolygons?: boolean  // Use Canvas paths (slower but smoother edges)
  drawEdges?: boolean    // Draw cell boundaries
}

export class VoronoiDrawer {
  private canvas: HTMLCanvasElement
  private width: number
  private height: number
  private sob: Uint8ClampedArray
  private diagram: Diagram | null = null
  private sites: Position[] = []
  private currentSeed: number = 0
  public numSites: number
  public inversePP: boolean

  constructor(canvas: HTMLCanvasElement, numSites: number, inversePP: boolean) {
    this.canvas = canvas
    this.width = canvas.width
    this.height = canvas.height
    this.numSites = numSites
    this.inversePP = inversePP

    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2d context')

    const data = ctx.getImageData(0, 0, this.width, this.height)
    this.sob = Sobel(data)
  }

  getSites(): Position[] {
    return this.sites
  }

  getSeed(): number {
    return this.currentSeed
  }

  private generateSites(seed?: number): Position[] {
    this.currentSeed = seed ?? randomSeed()
    const random = createSeededRandom(this.currentSeed)

    const cp = new ChoosePoint(
      this.sob,
      this.canvas.width,
      this.canvas.height,
      this.numSites,
      this.inversePP,
    )
    return cp.pickPosition(random)
  }

  private computeSites(sites?: Position[], seed?: number): void {
    this.sites = (sites && sites.length > 0) ? sites : this.generateSites(seed)
  }

  private computeVoronoi(): void {
    const bbox = {
      xl: 0,
      xr: this.width,
      yt: 0,
      yb: this.height,
    }

    const voronoi = new Voronoi()
    this.diagram = voronoi.compute(this.sites, bbox)
  }

  /**
   * Compute cell colors using multi-source BFS flood fill.
   * O(pixels) instead of O(cells × pixels_per_cell × polygon_vertices)
   */
  private cellColorsFloodFill(imgdata: Uint8ClampedArray): RGB[] {
    const { width, height, sites } = this
    const numPixels = width * height
    const numSites = sites.length

    // Cell membership for each pixel (-1 = unvisited)
    const cellOf = new Int32Array(numPixels).fill(-1)

    // Color accumulators per cell
    const rSum = new Float64Array(numSites)
    const gSum = new Float64Array(numSites)
    const bSum = new Float64Array(numSites)
    const counts = new Uint32Array(numSites)

    // BFS queue: store pixel indices
    // Use a circular buffer for efficiency
    const queue = new Int32Array(numPixels)
    let qHead = 0
    let qTail = 0

    // Initialize: seed pixels
    for (let i = 0; i < numSites; i++) {
      const x = Math.floor(sites[i].x)
      const y = Math.floor(sites[i].y)
      if (x >= 0 && x < width && y >= 0 && y < height) {
        const idx = y * width + x
        if (cellOf[idx] === -1) {
          cellOf[idx] = i
          queue[qTail++] = idx

          // Accumulate color
          const px = idx * 4
          rSum[i] += imgdata[px]
          gSum[i] += imgdata[px + 1]
          bSum[i] += imgdata[px + 2]
          counts[i]++
        }
      }
    }

    // BFS
    while (qHead < qTail) {
      const idx = queue[qHead++]
      const cell = cellOf[idx]
      const x = idx % width
      const y = (idx - x) / width

      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const nidx = ny * width + nx
          if (cellOf[nidx] === -1) {
            cellOf[nidx] = cell
            queue[qTail++] = nidx

            // Accumulate color
            const px = nidx * 4
            rSum[cell] += imgdata[px]
            gSum[cell] += imgdata[px + 1]
            bSum[cell] += imgdata[px + 2]
            counts[cell]++
          }
        }
      }
    }

    // Compute average colors
    const cellColors: RGB[] = new Array(numSites)
    for (let i = 0; i < numSites; i++) {
      const count = counts[i]
      if (count > 0) {
        cellColors[i] = [
          Math.floor(rSum[i] / count),
          Math.floor(gSum[i] / count),
          Math.floor(bSum[i] / count),
        ]
      } else {
        cellColors[i] = [0, 0, 0]
      }
    }

    return cellColors
  }

  /**
   * Fast pixel-based rendering using flood fill only.
   * Skips Voronoi polygon computation for maximum performance.
   * Returns the cell membership array for edge detection if needed.
   */
  fillVoronoiPixels(sites?: Position[], seed?: number): Int32Array | null {
    this.computeSites(sites, seed)
    if (this.sites.length === 0) return null

    const ctx = this.canvas.getContext('2d')
    if (!ctx) return null

    const imgdata = ctx.getImageData(0, 0, this.width, this.height)
    const pixels = imgdata.data

    // Compute cell membership and colors via flood fill
    const { cellOf, cellColors } = this.floodFillWithMembership(pixels)

    // Write pixels directly
    const numPixels = this.width * this.height
    for (let i = 0; i < numPixels; i++) {
      const cell = cellOf[i]
      if (cell >= 0 && cellColors[cell]) {
        const [r, g, b] = cellColors[cell]
        const px = i * 4
        pixels[px] = r
        pixels[px + 1] = g
        pixels[px + 2] = b
        // alpha stays the same
      }
    }

    ctx.putImageData(imgdata, 0, 0)
    return cellOf
  }

  /**
   * Flood fill that returns both cell membership and colors.
   */
  private floodFillWithMembership(imgdata: Uint8ClampedArray): {
    cellOf: Int32Array
    cellColors: RGB[]
  } {
    const { width, height, sites } = this
    const numPixels = width * height
    const numSites = sites.length

    const cellOf = new Int32Array(numPixels).fill(-1)
    const rSum = new Float64Array(numSites)
    const gSum = new Float64Array(numSites)
    const bSum = new Float64Array(numSites)
    const counts = new Uint32Array(numSites)

    const queue = new Int32Array(numPixels)
    let qHead = 0
    let qTail = 0

    // Initialize with seed pixels
    for (let i = 0; i < numSites; i++) {
      const x = Math.floor(sites[i].x)
      const y = Math.floor(sites[i].y)
      if (x >= 0 && x < width && y >= 0 && y < height) {
        const idx = y * width + x
        if (cellOf[idx] === -1) {
          cellOf[idx] = i
          queue[qTail++] = idx
          const px = idx * 4
          rSum[i] += imgdata[px]
          gSum[i] += imgdata[px + 1]
          bSum[i] += imgdata[px + 2]
          counts[i]++
        }
      }
    }

    // BFS
    while (qHead < qTail) {
      const idx = queue[qHead++]
      const cell = cellOf[idx]
      const x = idx % width
      const y = (idx - x) / width

      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const nidx = ny * width + nx
          if (cellOf[nidx] === -1) {
            cellOf[nidx] = cell
            queue[qTail++] = nidx
            const px = nidx * 4
            rSum[cell] += imgdata[px]
            gSum[cell] += imgdata[px + 1]
            bSum[cell] += imgdata[px + 2]
            counts[cell]++
          }
        }
      }
    }

    // Compute average colors
    const cellColors: RGB[] = new Array(numSites)
    for (let i = 0; i < numSites; i++) {
      const count = counts[i]
      if (count > 0) {
        cellColors[i] = [
          Math.floor(rSum[i] / count),
          Math.floor(gSum[i] / count),
          Math.floor(bSum[i] / count),
        ]
      } else {
        cellColors[i] = [0, 0, 0]
      }
    }

    return { cellOf, cellColors }
  }

  /**
   * Original polygon-based rendering (slower but smoother edges).
   */
  fillVoronoi(sites?: Position[], seed?: number): void {
    this.computeSites(sites, seed)
    if (this.sites.length === 0) return

    // Compute Voronoi diagram for polygon rendering
    this.computeVoronoi()
    if (!this.diagram) return

    const ctx = this.canvas.getContext('2d')
    if (!ctx) return

    const imgdata = ctx.getImageData(0, 0, this.width, this.height).data

    // Use flood fill for O(pixels) color computation
    const cellColors = this.cellColorsFloodFill(imgdata)

    // Build site coordinate -> index map for O(1) lookup
    const siteIndexMap = new Map<string, number>()
    for (let i = 0; i < this.sites.length; i++) {
      siteIndexMap.set(`${this.sites[i].x},${this.sites[i].y}`, i)
    }

    ctx.clearRect(0, 0, this.width, this.height)

    // Render using Voronoi polygon boundaries
    for (let i = 0; i < this.diagram.cells.length; i++) {
      const cell = this.diagram.cells[i]
      const siteKey = `${cell.site.x},${cell.site.y}`
      const siteIndex = siteIndexMap.get(siteKey)
      if (siteIndex === undefined || !cellColors[siteIndex]) continue

      const [r, g, b] = cellColors[siteIndex]
      ctx.beginPath()

      const edges = cell.halfedges
      if (edges.length === 0) continue

      let va = edges[0].getStartpoint()
      ctx.moveTo(va.x, va.y)

      for (let j = 1; j < edges.length; j++) {
        va = edges[j].getStartpoint()
        ctx.lineTo(va.x, va.y)
      }

      ctx.closePath()
      const color = `rgb(${r}, ${g}, ${b})`
      ctx.fillStyle = color
      ctx.strokeStyle = color
      ctx.stroke()
      ctx.fill()
    }
  }

  /**
   * Generate uniformly distributed random sites (no edge weighting).
   * Much faster than edge-weighted sampling for animation.
   */
  generateUniformSites(count: number, seed?: number): Position[] {
    this.currentSeed = seed ?? randomSeed()
    const random = createSeededRandom(this.currentSeed)

    const sites: Position[] = []
    for (let i = 0; i < count; i++) {
      sites.push({
        x: random() * this.width,
        y: random() * this.height,
      })
    }
    this.sites = sites
    return sites
  }
}
