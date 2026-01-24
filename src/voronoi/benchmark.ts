/**
 * Standalone benchmark for Voronoi flood fill algorithms.
 * Run with: npx tsx src/voronoi/benchmark.ts
 */

type RGB = [number, number, number]

interface Position {
  x: number
  y: number
}

/**
 * Bucket queue for L2 flood fill
 */
class BucketQueue {
  private buckets: Int32Array[]
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
    const bucket = Math.min(priority | 0, this.maxBucket)

    if (!this.buckets[bucket]) {
      this.buckets[bucket] = new Int32Array(64)
    }

    let arr = this.buckets[bucket]
    const size = this.bucketSizes[bucket]

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

interface ProfiledResult {
  cellOf: Int32Array
  cellColors: RGB[]
  timing: {
    init: number
    floodFill: number
    colorAvg: number
    total: number
  }
}

/**
 * L2 flood fill with detailed profiling
 */
function floodFillL2Profiled(
  width: number,
  height: number,
  sites: Position[],
  imgdata: Uint8ClampedArray
): ProfiledResult {
  const t0 = performance.now()

  const numPixels = width * height
  const numSites = sites.length

  const cellOf = new Int32Array(numPixels).fill(-1)
  const bestDist = new Float32Array(numPixels).fill(Infinity)
  const rSum = new Float64Array(numSites)
  const gSum = new Float64Array(numSites)
  const bSum = new Float64Array(numSites)
  const counts = new Uint32Array(numSites)

  const maxDistSq = width * width + height * height
  const queue = new BucketQueue(maxDistSq)
  const popResult = { pixel: 0, site: 0 }

  for (let i = 0; i < numSites; i++) {
    const sx = sites[i].x
    const sy = sites[i].y
    const x = sx | 0
    const y = sy | 0
    if (x >= 0 && x < width && y >= 0 && y < height) {
      const idx = y * width + x
      const dx = x + 0.5 - sx
      const dy = y + 0.5 - sy
      const distSq = dx * dx + dy * dy
      if (distSq < bestDist[idx]) {
        bestDist[idx] = distSq
        queue.push(distSq, idx, i)
      }
    }
  }

  const t1 = performance.now()

  // Main flood fill loop
  while (queue.pop(popResult)) {
    const idx = popResult.pixel
    const siteIdx = popResult.site

    if (cellOf[idx] !== -1) continue

    cellOf[idx] = siteIdx

    // Color accumulation is interleaved with flood fill
    const px = idx * 4
    rSum[siteIdx] += imgdata[px]
    gSum[siteIdx] += imgdata[px + 1]
    bSum[siteIdx] += imgdata[px + 2]
    counts[siteIdx]++

    const x = idx % width
    const y = ((idx - x) / width) | 0
    const site = sites[siteIdx]
    const sx = site.x
    const sy = site.y

    const pcx = x + 0.5 - sx
    const pcy = y + 0.5 - sy

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

  const t2 = performance.now()

  // Final color averaging
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
      cellColors[i] = [128, 128, 128]
    }
  }

  const t3 = performance.now()

  return {
    cellOf,
    cellColors,
    timing: {
      init: t1 - t0,
      floodFill: t2 - t1,
      colorAvg: t3 - t2,
      total: t3 - t0,
    }
  }
}

/**
 * Naive O(pixels × sites) brute force - the baseline
 */
function naiveBruteForce(
  width: number,
  height: number,
  sites: Position[],
  imgdata: Uint8ClampedArray
): ProfiledResult {
  const t0 = performance.now()

  const numPixels = width * height
  const numSites = sites.length

  const cellOf = new Int32Array(numPixels)
  const rSum = new Float64Array(numSites)
  const gSum = new Float64Array(numSites)
  const bSum = new Float64Array(numSites)
  const counts = new Uint32Array(numSites)

  const t1 = performance.now()

  // For each pixel, find closest site
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      const px = x + 0.5
      const py = y + 0.5

      let minDist = Infinity
      let minSite = 0

      for (let i = 0; i < numSites; i++) {
        const dx = px - sites[i].x
        const dy = py - sites[i].y
        const distSq = dx * dx + dy * dy
        if (distSq < minDist) {
          minDist = distSq
          minSite = i
        }
      }

      cellOf[idx] = minSite

      const pxIdx = idx * 4
      rSum[minSite] += imgdata[pxIdx]
      gSum[minSite] += imgdata[pxIdx + 1]
      bSum[minSite] += imgdata[pxIdx + 2]
      counts[minSite]++
    }
  }

  const t2 = performance.now()

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
      cellColors[i] = [128, 128, 128]
    }
  }

  const t3 = performance.now()

  return {
    cellOf,
    cellColors,
    timing: {
      init: t1 - t0,
      floodFill: t2 - t1,  // Actually "assignment" for brute force
      colorAvg: t3 - t2,
      total: t3 - t0,
    }
  }
}

/**
 * L2 flood fill - non-profiled version for matrix benchmark
 */
function floodFillL2(
  width: number,
  height: number,
  sites: Position[],
  imgdata: Uint8ClampedArray
): { cellOf: Int32Array; cellColors: RGB[] } {
  const numPixels = width * height
  const numSites = sites.length

  const cellOf = new Int32Array(numPixels).fill(-1)
  const bestDist = new Float32Array(numPixels).fill(Infinity)
  const rSum = new Float64Array(numSites)
  const gSum = new Float64Array(numSites)
  const bSum = new Float64Array(numSites)
  const counts = new Uint32Array(numSites)

  const maxDistSq = width * width + height * height
  const queue = new BucketQueue(maxDistSq)
  const popResult = { pixel: 0, site: 0 }

  for (let i = 0; i < numSites; i++) {
    const sx = sites[i].x
    const sy = sites[i].y
    const x = sx | 0
    const y = sy | 0
    if (x >= 0 && x < width && y >= 0 && y < height) {
      const idx = y * width + x
      const dx = x + 0.5 - sx
      const dy = y + 0.5 - sy
      const distSq = dx * dx + dy * dy
      if (distSq < bestDist[idx]) {
        bestDist[idx] = distSq
        queue.push(distSq, idx, i)
      }
    }
  }

  while (queue.pop(popResult)) {
    const idx = popResult.pixel
    const siteIdx = popResult.site

    if (cellOf[idx] !== -1) continue

    cellOf[idx] = siteIdx

    const px = idx * 4
    rSum[siteIdx] += imgdata[px]
    gSum[siteIdx] += imgdata[px + 1]
    bSum[siteIdx] += imgdata[px + 2]
    counts[siteIdx]++

    const x = idx % width
    const y = ((idx - x) / width) | 0
    const site = sites[siteIdx]
    const sx = site.x
    const sy = site.y

    const pcx = x + 0.5 - sx
    const pcy = y + 0.5 - sy

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
      cellColors[i] = [128, 128, 128]
    }
  }

  return { cellOf, cellColors }
}

/**
 * L1 flood fill using BFS
 */
function floodFillL1(
  width: number,
  height: number,
  sites: Position[],
  imgdata: Uint8ClampedArray
): { cellOf: Int32Array; cellColors: RGB[] } {
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

  while (qHead < qTail) {
    const idx = queue[qHead++]
    const cell = cellOf[idx]
    const x = idx % width
    const y = ((idx - x) / width) | 0

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
      cellColors[i] = [128, 128, 128]
    }
  }

  return { cellOf, cellColors }
}

function generateSites(width: number, height: number, count: number): Position[] {
  const sites: Position[] = []
  for (let i = 0; i < count; i++) {
    sites.push({
      x: Math.random() * width,
      y: Math.random() * height,
    })
  }
  return sites
}

function generateImageData(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.random() * 256 | 0
    data[i + 1] = Math.random() * 256 | 0
    data[i + 2] = Math.random() * 256 | 0
    data[i + 3] = 255
  }
  return data
}

function benchmarkMin(fn: () => void, iterations: number = 5): number {
  for (let i = 0; i < 2; i++) fn()
  let min = Infinity
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    fn()
    min = Math.min(min, performance.now() - start)
  }
  return min
}

function main() {
  console.log('=== PROFILING: Where is time spent? ===\n')

  const width = 1024
  const height = 682
  const numSites = 400
  const imgdata = generateImageData(width, height)
  const sites = generateSites(width, height, numSites)

  // Warmup
  for (let i = 0; i < 3; i++) {
    floodFillL2Profiled(width, height, sites, imgdata)
    naiveBruteForce(width, height, sites, imgdata)
  }

  // Profile L2 flood fill
  console.log(`L2 Flood Fill (${width}x${height}, ${numSites} sites):`)
  const l2Results: ProfiledResult[] = []
  for (let i = 0; i < 5; i++) {
    l2Results.push(floodFillL2Profiled(width, height, sites, imgdata))
  }
  const l2Avg = {
    init: l2Results.reduce((s, r) => s + r.timing.init, 0) / l2Results.length,
    floodFill: l2Results.reduce((s, r) => s + r.timing.floodFill, 0) / l2Results.length,
    colorAvg: l2Results.reduce((s, r) => s + r.timing.colorAvg, 0) / l2Results.length,
    total: l2Results.reduce((s, r) => s + r.timing.total, 0) / l2Results.length,
  }
  console.log(`  Init (arrays + queue setup):  ${l2Avg.init.toFixed(2)}ms (${(l2Avg.init / l2Avg.total * 100).toFixed(1)}%)`)
  console.log(`  Flood fill + color accum:     ${l2Avg.floodFill.toFixed(2)}ms (${(l2Avg.floodFill / l2Avg.total * 100).toFixed(1)}%)`)
  console.log(`  Final color averaging:        ${l2Avg.colorAvg.toFixed(2)}ms (${(l2Avg.colorAvg / l2Avg.total * 100).toFixed(1)}%)`)
  console.log(`  TOTAL:                        ${l2Avg.total.toFixed(2)}ms`)

  console.log('')

  // Profile naive brute force
  console.log(`Naive Brute Force O(pixels × sites):`)
  const naiveResults: ProfiledResult[] = []
  for (let i = 0; i < 5; i++) {
    naiveResults.push(naiveBruteForce(width, height, sites, imgdata))
  }
  const naiveAvg = {
    init: naiveResults.reduce((s, r) => s + r.timing.init, 0) / naiveResults.length,
    floodFill: naiveResults.reduce((s, r) => s + r.timing.floodFill, 0) / naiveResults.length,
    colorAvg: naiveResults.reduce((s, r) => s + r.timing.colorAvg, 0) / naiveResults.length,
    total: naiveResults.reduce((s, r) => s + r.timing.total, 0) / naiveResults.length,
  }
  console.log(`  Init:                         ${naiveAvg.init.toFixed(2)}ms (${(naiveAvg.init / naiveAvg.total * 100).toFixed(1)}%)`)
  console.log(`  Pixel assignment + accum:     ${naiveAvg.floodFill.toFixed(2)}ms (${(naiveAvg.floodFill / naiveAvg.total * 100).toFixed(1)}%)`)
  console.log(`  Final color averaging:        ${naiveAvg.colorAvg.toFixed(2)}ms (${(naiveAvg.colorAvg / naiveAvg.total * 100).toFixed(1)}%)`)
  console.log(`  TOTAL:                        ${naiveAvg.total.toFixed(2)}ms`)

  console.log('')
  console.log(`Speedup (naive/L2): ${(naiveAvg.total / l2Avg.total).toFixed(1)}x`)

  console.log('\n\n=== COMPARISON: L1 vs L2 vs Naive ===\n')

  const configs = [
    { width: 512, height: 341, sites: 100 },
    { width: 512, height: 341, sites: 400 },
    { width: 1024, height: 682, sites: 100 },
    { width: 1024, height: 682, sites: 400 },
    { width: 1024, height: 682, sites: 1600 },
  ]

  console.log('Config                    |     L1 |     L2 |  Naive | L2/L1 | Naive/L2')
  console.log('--------------------------|--------|--------|--------|-------|----------')

  for (const cfg of configs) {
    const img = generateImageData(cfg.width, cfg.height)
    const s = generateSites(cfg.width, cfg.height, cfg.sites)

    const l1 = benchmarkMin(() => floodFillL1(cfg.width, cfg.height, s, img))
    const l2 = benchmarkMin(() => floodFillL2(cfg.width, cfg.height, s, img))
    const naive = benchmarkMin(() => naiveBruteForce(cfg.width, cfg.height, s, img))

    const label = `${cfg.width}x${cfg.height}, ${cfg.sites} sites`.padEnd(25)
    console.log(`${label} | ${l1.toFixed(1).padStart(6)} | ${l2.toFixed(1).padStart(6)} | ${naive.toFixed(1).padStart(6)} | ${(l2/l1).toFixed(1).padStart(5)}x | ${(naive/l2).toFixed(1).padStart(8)}x`)
  }

  console.log('\n\n=== SCALING: How naive scales with sites ===\n')
  console.log('Sites |   Naive |      L2 | Naive/L2')
  console.log('------|---------|---------|----------')

  const fixedImg = generateImageData(1024, 682)
  for (const numS of [50, 100, 200, 400, 800]) {
    const s = generateSites(1024, 682, numS)
    const l2Time = benchmarkMin(() => floodFillL2(1024, 682, s, fixedImg))
    const naiveTime = benchmarkMin(() => naiveBruteForce(1024, 682, s, fixedImg))
    console.log(`${numS.toString().padStart(5)} | ${naiveTime.toFixed(1).padStart(7)} | ${l2Time.toFixed(1).padStart(7)} | ${(naiveTime/l2Time).toFixed(1).padStart(8)}x`)
  }
}

main()
