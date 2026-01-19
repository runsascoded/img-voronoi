import Voronoi, { Diagram, Vertex } from 'voronoi'
import { ChoosePoint, Position } from './ChoosePoints'
import Sobel from 'sobel'
import { createSeededRandom, deriveSeed, randomSeed } from '../utils/random'

type RGB = [number, number, number]

export type { Position }

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

  private computeVoronoi(sites?: Position[], seed?: number): void {
    this.sites = (sites && sites.length > 0) ? sites : this.generateSites(seed)

    const bbox = {
      xl: 0,
      xr: this.width,
      yt: 0,
      yb: this.height,
    }

    const voronoi = new Voronoi()
    this.diagram = voronoi.compute(this.sites, bbox)
  }

  private isPointInPoly(poly: Vertex[], x: number, y: number): boolean {
    let c = false
    for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
      if (
        ((poly[k].y <= y && y < poly[m].y) || (poly[m].y <= y && y < poly[k].y)) &&
        x < ((poly[m].x - poly[k].x) * (y - poly[k].y)) / (poly[m].y - poly[k].y) + poly[k].x
      ) {
        c = !c
      }
    }
    return c
  }

  private cellColors(imgdata: Uint8ClampedArray, channel: number, rgbAmount: number): RGB[] {
    if (!this.diagram) return []

    const cellColors: RGB[] = []

    for (let i = 0; i < this.diagram.cells.length; i++) {
      const boundaries: Vertex[] = []
      let minX = this.width
      let minY = this.height
      let maxX = 0
      let maxY = 0

      const edges = this.diagram.cells[i].halfedges
      for (let j = 0; j < edges.length; j++) {
        const va = edges[j].getStartpoint()
        boundaries.push(va)
        minX = Math.min(va.x, minX)
        maxX = Math.max(va.x, maxX)
        minY = Math.min(va.y, minY)
        maxY = Math.max(va.y, maxY)
      }

      let r = 0
      let g = 0
      let b = 0
      let count = 0
      let inside = false

      for (let k = Math.max(Math.floor(minX), 0); k < Math.min(Math.floor(maxX + 1), this.width); k++) {
        for (let j = Math.max(Math.floor(minY), 0); j < Math.min(Math.floor(maxY + 1), this.height); j++) {
          if (this.isPointInPoly(boundaries, k, j)) {
            const ind = j * this.width + k
            r += imgdata[ind * 4]
            g += imgdata[ind * 4 + 1]
            b += imgdata[ind * 4 + 2]
            count += 1
            inside = true
          } else if (inside) {
            inside = false
            break
          }
        }
      }

      r /= count
      g /= count
      b /= count

      if (channel === 0) {
        cellColors.push([Math.floor(r), Math.floor(g), Math.floor(b)])
      } else if (channel === 1) {
        cellColors.push([
          Math.floor((r * rgbAmount) / 100),
          Math.floor((g * (1 - rgbAmount / 100)) / 2),
          Math.floor((b * (1 - rgbAmount / 100)) / 2),
        ])
      } else if (channel === 2) {
        cellColors.push([
          Math.floor((r * (1 - rgbAmount / 100)) / 2),
          Math.floor((g * rgbAmount) / 100),
          Math.floor((b * (1 - rgbAmount / 100)) / 2),
        ])
      } else {
        cellColors.push([
          Math.floor((r * (1 - rgbAmount / 100)) / 2),
          Math.floor((g * (1 - rgbAmount / 100)) / 2),
          Math.floor((b * rgbAmount) / 100),
        ])
      }
    }

    return cellColors
  }

  fillVoronoi(
    channel: number,
    clear = true,
    imgdata?: Uint8ClampedArray,
    ifStroke = true,
    rgbAmount = 0,
    sites?: Position[],
    seed?: number,
  ): void {
    this.computeVoronoi(sites, seed)
    if (!this.diagram) return

    const ctx = this.canvas.getContext('2d')
    if (!ctx) return

    const data = imgdata ?? ctx.getImageData(0, 0, this.width, this.height).data
    const cellcolor = this.cellColors(data, channel, rgbAmount)

    if (clear) {
      ctx.clearRect(0, 0, this.width, this.height)
    }

    for (let i = 0; i < cellcolor.length; i++) {
      const [r, g, b] = cellcolor[i]
      ctx.beginPath()

      let va = this.diagram.cells[i].halfedges[0].getStartpoint()
      ctx.moveTo(va.x, va.y)

      for (let j = 1; j < this.diagram.cells[i].halfedges.length; j++) {
        va = this.diagram.cells[i].halfedges[j].getStartpoint()
        ctx.lineTo(va.x, va.y)
      }

      ctx.closePath()
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`

      if (ifStroke) {
        ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`
        ctx.stroke()
      }

      ctx.fill()
    }
  }

  rgbVoronoi(rgbAmount: number, seed?: number): void {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return

    // Use provided seed or generate a new one
    const baseSeed = seed ?? randomSeed()
    this.currentSeed = baseSeed

    ctx.globalCompositeOperation = 'lighter'
    const imgdata = ctx.getImageData(0, 0, this.width, this.height).data

    // Each channel gets a different seed derived from the base seed
    // This creates the chromatic aberration effect while being reproducible
    this.fillVoronoi(1, true, imgdata, false, rgbAmount, undefined, deriveSeed(baseSeed, 0))
    this.fillVoronoi(2, false, imgdata, false, rgbAmount, undefined, deriveSeed(baseSeed, 1))
    this.fillVoronoi(3, false, imgdata, false, rgbAmount, undefined, deriveSeed(baseSeed, 2))

    ctx.globalCompositeOperation = 'source-over'
  }
}
