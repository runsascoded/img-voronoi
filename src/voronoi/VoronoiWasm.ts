/**
 * TypeScript wrapper for the voronoi-wasm WASM module.
 * Provides a JS-friendly API around the Rust VoronoiEngine.
 */

import type { Position } from './VoronoiDrawer'

// Import from the WASM package (resolved via Vite alias)
import init, { VoronoiEngine, VoronoiFrame } from 'voronoi-wasm'

export type { VoronoiFrame }

let wasmReady = false

/** Initialize the WASM module. Call once on app startup. */
export async function initWasm(): Promise<void> {
  if (wasmReady) return
  await init()
  wasmReady = true
}

/** Check if WASM module is initialized. */
export function isWasmReady(): boolean {
  return wasmReady
}

export interface WasmComputeResult {
  cellOf: Int32Array
  cellColors: [number, number, number][]
  cellAreas: Uint32Array
  cellCentroids: Position[]
  farthestPoint: Position
}

/** Convert Position[] to flat Float64Array [x0,y0, x1,y1, ...] */
function positionsToFlat(positions: Position[]): Float64Array {
  const flat = new Float64Array(positions.length * 2)
  for (let i = 0; i < positions.length; i++) {
    flat[i * 2] = positions[i].x
    flat[i * 2 + 1] = positions[i].y
  }
  return flat
}

/** Convert flat Float64Array to Position[] */
function flatToPositions(flat: Float64Array): Position[] {
  const positions: Position[] = []
  for (let i = 0; i < flat.length; i += 2) {
    positions.push({ x: flat[i], y: flat[i + 1] })
  }
  return positions
}

/** Parse flat RGB Uint8Array into [r,g,b][] tuples */
function flatColorsToTuples(flat: Uint8Array): [number, number, number][] {
  const tuples: [number, number, number][] = []
  for (let i = 0; i < flat.length; i += 3) {
    tuples.push([flat[i], flat[i + 1], flat[i + 2]])
  }
  return tuples
}

/**
 * High-level wrapper around the WASM VoronoiEngine.
 * Manages the lifecycle of the Rust-side engine and provides
 * JS-friendly methods for computation, physics, and site management.
 */
export class VoronoiWasm {
  private engine: VoronoiEngine

  constructor(rgbaData: Uint8ClampedArray | Uint8Array, width: number, height: number, seed: number) {
    if (!wasmReady) {
      throw new Error('WASM not initialized. Call initWasm() first.')
    }
    this.engine = new VoronoiEngine(new Uint8Array(rgbaData), width, height, seed)
  }

  /** Replace the source image. */
  setImage(rgbaData: Uint8ClampedArray | Uint8Array, width: number, height: number): void {
    this.engine.set_image(new Uint8Array(rgbaData), width, height)
  }

  /** Initialize sites from Position[] with zero velocities. */
  setSites(positions: Position[], seed: number): void {
    this.engine.set_sites(positionsToFlat(positions), seed)
  }

  /** Initialize sites from Position[] with random velocities (seeded). */
  setSitesRandomVel(positions: Position[], seed: number): void {
    this.engine.set_sites_random_vel(positionsToFlat(positions), seed)
  }

  /** Run Voronoi computation. Returns structured result. */
  compute(): WasmComputeResult {
    const frame: VoronoiFrame = this.engine.compute()
    const result: WasmComputeResult = {
      cellOf: frame.cell_of,
      cellColors: flatColorsToTuples(frame.cell_colors),
      cellAreas: frame.cell_areas,
      cellCentroids: flatToPositions(frame.cell_centroids),
      farthestPoint: { x: frame.farthest_x, y: frame.farthest_y },
    }
    frame.free()
    return result
  }

  /**
   * Advance physics by one time step.
   * Uses Ornstein-Uhlenbeck steering + centroid pull + edge bouncing.
   */
  step(speed: number, dt: number, centroids?: Position[], centroidPull: number = 0, theta: number = 3, sigma: number = 3): void {
    const centroidsFlat = centroids ? positionsToFlat(centroids) : undefined
    this.engine.step(speed, dt, centroidsFlat, centroidPull, theta, sigma)
  }

  /**
   * Gradually adjust site count toward target.
   * Returns the change in site count (positive = added, negative = removed).
   */
  adjustCount(
    target: number,
    doublingTime: number,
    dt: number,
    cellAreas?: Uint32Array,
    strategy: string = 'max',
    centroids?: Position[],
    farthestPoint?: Position,
  ): number {
    const centroidsFlat = centroids ? positionsToFlat(centroids) : undefined
    return this.engine.adjust_count(
      target,
      doublingTime,
      dt,
      cellAreas,
      strategy,
      centroidsFlat,
      farthestPoint?.x ?? Infinity,
      farthestPoint?.y ?? Infinity,
    )
  }

  /** Get current site positions. */
  getPositions(): Position[] {
    return flatToPositions(this.engine.get_positions())
  }

  /** Get current site velocities. */
  getVelocities(): Position[] {
    return flatToPositions(this.engine.get_velocities())
  }

  /** Get current site count. */
  siteCount(): number {
    return this.engine.site_count()
  }

  /** Free the WASM-side engine. Call when done. */
  dispose(): void {
    this.engine.free()
  }
}
