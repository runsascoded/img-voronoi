import Voronoi, { Diagram } from 'voronoi'
import { ChoosePoint, Position } from './ChoosePoints'
import Sobel from 'sobel'
import { createSeededRandom, randomSeed } from '../utils/random'

type RGB = [number, number, number]

export type { Position }

export type DistanceMetric = 'L1' | 'L2'

/**
 * Simple bucket queue - Map of arrays, linear scan for next bucket.
 * Optimized for Voronoi flood fill where buckets are processed in order.
 */
class BucketQueue {
  private buckets: Int32Array[]  // buckets[distSq] = flat array of [pixel, site, pixel, site, ...]
  private bucketSizes: Int32Array
  private currentBucket: number
  private maxBucket: number
  private _size: number

  constructor(maxDistSq: number) {
    this.maxBucket = maxDistSq
    this.buckets = new Array(maxDistSq + 1)
    this.bucketSizes = new Int32Array(maxDistSq + 1)
    this.currentBucket = 0
    this._size = 0
  }

  get size(): number {
    return this._size
  }

  push(priority: number, pixelIndex: number, siteIndex: number): void {
    const bucket = Math.min(Math.floor(priority), this.maxBucket)

    if (!this.buckets[bucket]) {
      this.buckets[bucket] = new Int32Array(64)
    }

    let arr = this.buckets[bucket]
    const size = this.bucketSizes[bucket]

    // Grow if needed
    if (size * 2 >= arr.length) {
      const newArr = new Int32Array(arr.length * 2)
      newArr.set(arr)
      this.buckets[bucket] = newArr
      arr = newArr
    }

    arr[size * 2] = pixelIndex
    arr[size * 2 + 1] = siteIndex
    this.bucketSizes[bucket] = size + 1
    this._size++
  }

  pop(result: { pixel: number; site: number }): boolean {
    // Find next non-empty bucket
    while (this.currentBucket <= this.maxBucket) {
      const size = this.bucketSizes[this.currentBucket]
      if (size > 0) {
        const arr = this.buckets[this.currentBucket]
        const newSize = size - 1
        result.pixel = arr[newSize * 2]
        result.site = arr[newSize * 2 + 1]
        this.bucketSizes[this.currentBucket] = newSize
        this._size--
        return true
      }
      this.currentBucket++
    }
    return false
  }
}

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
   * Compute cell colors using Euclidean distance flood fill.
   * O(pixels × log(pixels)) with the priority queue.
   */
  private cellColorsFloodFill(imgdata: Uint8ClampedArray): RGB[] {
    const { cellColors } = this.floodFillL2(imgdata)
    return cellColors
  }

  /**
   * Fast pixel-based rendering using flood fill only.
   * Skips Voronoi polygon computation for maximum performance.
   * Returns the cell membership array for hover detection.
   */
  fillVoronoiPixels(
    sites?: Position[],
    seed?: number,
    metric: DistanceMetric = 'L2'
  ): { cellOf: Int32Array; cellColors: RGB[] } | null {
    this.computeSites(sites, seed)
    if (this.sites.length === 0) return null

    const ctx = this.canvas.getContext('2d')
    if (!ctx) return null

    const imgdata = ctx.getImageData(0, 0, this.width, this.height)
    const pixels = imgdata.data

    // Compute cell membership and colors via flood fill
    const t0 = performance.now()
    const { cellOf, cellColors } = this.floodFillWithMembership(pixels, metric)
    console.log(`[flood] ${metric}: ${(performance.now() - t0).toFixed(0)}ms`)

    // Write pixels directly (optimized: avoid destructuring in hot loop)
    const numPixels = this.width * this.height
    for (let i = 0; i < numPixels; i++) {
      const cell = cellOf[i]
      if (cell >= 0) {
        const color = cellColors[cell]
        if (color) {
          const px = i * 4
          pixels[px] = color[0]
          pixels[px + 1] = color[1]
          pixels[px + 2] = color[2]
        }
      }
    }

    ctx.putImageData(imgdata, 0, 0)
    return { cellOf, cellColors }
  }

  /**
   * Euclidean (L2) flood fill using bucket queue.
   * Bucket queue gives O(1) push/pop since squared distances are integers.
   * Much faster than heap-based approach.
   */
  private floodFillL2(imgdata: Uint8ClampedArray): {
    cellOf: Int32Array
    cellColors: RGB[]
  } {
    const { width, height, sites } = this
    const numPixels = width * height
    const numSites = sites.length

    const cellOf = new Int32Array(numPixels).fill(-1)
    // Track best distance seen for each pixel (for pruning duplicates)
    const bestDist = new Float32Array(numPixels).fill(Infinity)
    const rSum = new Float64Array(numSites)
    const gSum = new Float64Array(numSites)
    const bSum = new Float64Array(numSites)
    const counts = new Uint32Array(numSites)

    // Max squared distance is diagonal of image
    const maxDistSq = width * width + height * height
    const queue = new BucketQueue(maxDistSq)
    const popResult = { pixel: 0, site: 0 }  // Reusable object to avoid allocation

    // Initialize: add all site pixels with distance 0
    for (let i = 0; i < numSites; i++) {
      const sx = sites[i].x
      const sy = sites[i].y
      const x = (sx | 0)  // Faster than Math.floor for positive numbers
      const y = (sy | 0)
      if (x >= 0 && x < width && y >= 0 && y < height) {
        const idx = y * width + x
        // Distance squared from pixel center to site
        const dx = x + 0.5 - sx
        const dy = y + 0.5 - sy
        const distSq = dx * dx + dy * dy
        if (distSq < bestDist[idx]) {
          bestDist[idx] = distSq
          queue.push(distSq, idx, i)
        }
      }
    }

    // Process pixels in order of increasing distance
    while (queue.pop(popResult)) {
      const idx = popResult.pixel
      const siteIdx = popResult.site

      // Skip if already assigned
      if (cellOf[idx] !== -1) {
        continue
      }

      // Assign to this site
      cellOf[idx] = siteIdx

      // Accumulate color
      const px = idx * 4
      rSum[siteIdx] += imgdata[px]
      gSum[siteIdx] += imgdata[px + 1]
      bSum[siteIdx] += imgdata[px + 2]
      counts[siteIdx]++

      // Add neighbors to queue
      const x = idx % width
      const y = ((idx - x) / width) | 0
      const site = sites[siteIdx]
      const sx = site.x
      const sy = site.y

      // Pre-compute pixel center offsets relative to site
      const pcx = x + 0.5 - sx  // pixel center x offset
      const pcy = y + 0.5 - sy  // pixel center y offset

      // Use 4-connected for expansion (still correct L2 since we use true Euclidean distance)
      // Right: neighbor center is at (x+1.5, y+0.5) relative to origin, so offset from site is (pcx+1, pcy)
      if (x + 1 < width) {
        const nidx = idx + 1
        if (cellOf[nidx] === -1) {
          const pdx = pcx + 1
          const distSq = pdx * pdx + pcy * pcy
          if (distSq < bestDist[nidx]) {
            bestDist[nidx] = distSq
            queue.push(distSq, nidx, siteIdx)
          }
        }
      }
      // Left: offset from site is (pcx-1, pcy)
      if (x > 0) {
        const nidx = idx - 1
        if (cellOf[nidx] === -1) {
          const pdx = pcx - 1
          const distSq = pdx * pdx + pcy * pcy
          if (distSq < bestDist[nidx]) {
            bestDist[nidx] = distSq
            queue.push(distSq, nidx, siteIdx)
          }
        }
      }
      // Down: offset from site is (pcx, pcy+1)
      if (y + 1 < height) {
        const nidx = idx + width
        if (cellOf[nidx] === -1) {
          const pdy = pcy + 1
          const distSq = pcx * pcx + pdy * pdy
          if (distSq < bestDist[nidx]) {
            bestDist[nidx] = distSq
            queue.push(distSq, nidx, siteIdx)
          }
        }
      }
      // Up: offset from site is (pcx, pcy-1)
      if (y > 0) {
        const nidx = idx - width
        if (cellOf[nidx] === -1) {
          const pdy = pcy - 1
          const distSq = pcx * pcx + pdy * pdy
          if (distSq < bestDist[nidx]) {
            bestDist[nidx] = distSq
            queue.push(distSq, nidx, siteIdx)
          }
        }
      }
    }

    // Compute average colors, with fallback for empty cells
    const cellColors: RGB[] = new Array(numSites)
    for (let i = 0; i < numSites; i++) {
      const count = counts[i]
      if (count > 0) {
        cellColors[i] = [
          (rSum[i] / count) | 0,
          (gSum[i] / count) | 0,
          (bSum[i] / count) | 0,
        ]
      } else {
        // Fallback: sample the pixel at the site location
        const x = sites[i].x | 0
        const y = sites[i].y | 0
        if (x >= 0 && x < width && y >= 0 && y < height) {
          const px = (y * width + x) * 4
          cellColors[i] = [imgdata[px], imgdata[px + 1], imgdata[px + 2]]
        } else {
          cellColors[i] = [128, 128, 128]  // Gray fallback
        }
      }
    }

    return { cellOf, cellColors }
  }

  /**
   * Manhattan (L1) flood fill using BFS.
   * Faster but produces diamond-shaped regions.
   */
  private floodFillL1(imgdata: Uint8ClampedArray): {
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

    // Use simple BFS with 4-connected neighbors
    const queue = new Int32Array(numPixels)
    let qHead = 0
    let qTail = 0

    // Initialize with seed pixels
    for (let i = 0; i < numSites; i++) {
      const x = sites[i].x | 0
      const y = sites[i].y | 0
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

    // BFS with 4-connected neighbors (L1 metric) - inlined for speed
    while (qHead < qTail) {
      const idx = queue[qHead++]
      const cell = cellOf[idx]
      const x = idx % width
      const y = ((idx - x) / width) | 0

      // Right
      if (x + 1 < width) {
        const nidx = idx + 1
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
      // Left
      if (x > 0) {
        const nidx = idx - 1
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
      // Down
      if (y + 1 < height) {
        const nidx = idx + width
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
      // Up
      if (y > 0) {
        const nidx = idx - width
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

    // Compute average colors
    const cellColors: RGB[] = new Array(numSites)
    for (let i = 0; i < numSites; i++) {
      const count = counts[i]
      if (count > 0) {
        cellColors[i] = [
          (rSum[i] / count) | 0,
          (gSum[i] / count) | 0,
          (bSum[i] / count) | 0,
        ]
      } else {
        // Fallback: sample the pixel at the site location
        const x = sites[i].x | 0
        const y = sites[i].y | 0
        if (x >= 0 && x < width && y >= 0 && y < height) {
          const px = (y * width + x) * 4
          cellColors[i] = [imgdata[px], imgdata[px + 1], imgdata[px + 2]]
        } else {
          cellColors[i] = [128, 128, 128]
        }
      }
    }

    return { cellOf, cellColors }
  }

  /**
   * Flood fill with configurable distance metric.
   */
  private floodFillWithMembership(
    imgdata: Uint8ClampedArray,
    metric: DistanceMetric = 'L2'
  ): {
    cellOf: Int32Array
    cellColors: RGB[]
  } {
    return metric === 'L1'
      ? this.floodFillL1(imgdata)
      : this.floodFillL2(imgdata)
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
