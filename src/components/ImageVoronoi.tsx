import { useRef, useEffect, useCallback, ChangeEvent, DragEvent, useState, MouseEvent } from 'react'
import useSessionStorageState from 'use-session-storage-state'
import { useUrlParams, intParam, boolParam, Param } from 'use-prms/hash'
import { useAction } from 'use-kbd'
import { saveAs } from 'file-saver'
import { VoronoiDrawer, Position, DistanceMetric } from '../voronoi/VoronoiDrawer'
import { VoronoiWebGL } from '../voronoi/VoronoiWebGL'
import sampleImage from '../assets/sample.jpg'
import './ImageVoronoi.css'

// Boolean param that defaults to true (param absent = true, param present = false)
const boolParamDefaultTrue: Param<boolean> = {
  encode: (value: boolean) => value ? undefined : "",
  decode: (encoded: string | undefined) => encoded === undefined,
}

type RGB = [number, number, number]

interface ImageState {
  imageDataUrl: string | null
  sites: Position[]
}

interface HistoryEntry {
  imageDataUrl: string | null
  sites: Position[]
  seed: number
  numSites: number
  inversePP: boolean
}

const DEFAULT_IMAGE_STATE: ImageState = {
  imageDataUrl: null,
  sites: [],
}

const MAX_HISTORY = 50

const SITES_STEP = 50
const SITES_MIN = 50
const SITES_MAX = 10000
const PHI = 1.618033988749895  // Golden ratio

/**
 * Split sites to increase count. Randomly selects sites to split,
 * replacing each with two sites at small offsets from the original.
 */
function splitSites(
  sites: Position[],
  targetCount: number,
  width: number,
  height: number,
): Position[] {
  if (targetCount <= sites.length) return sites

  const result = [...sites]
  const toAdd = targetCount - sites.length

  // Estimate cell radius for offset calculation
  const avgCellRadius = Math.sqrt((width * height) / sites.length) / 2
  const splitOffset = avgCellRadius * 0.3  // Split distance

  // Randomly select sites to split
  const indices = sites.map((_, i) => i)
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]]
  }

  for (let i = 0; i < toAdd; i++) {
    const srcIdx = indices[i % indices.length]
    const src = sites[srcIdx]

    // Random angle for split direction
    const angle = Math.random() * Math.PI * 2

    // Create new site at offset from source
    const newSite = {
      x: Math.max(0, Math.min(width - 1, src.x + Math.cos(angle) * splitOffset)),
      y: Math.max(0, Math.min(height - 1, src.y + Math.sin(angle) * splitOffset)),
    }
    result.push(newSite)
  }

  return result
}

/**
 * Merge sites to decrease count. Randomly removes sites.
 */
function mergeSites(sites: Position[], targetCount: number): Position[] {
  if (targetCount >= sites.length) return sites

  // Shuffle and take first targetCount
  const shuffled = [...sites]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  return shuffled.slice(0, targetCount)
}

export function ImageVoronoi() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const webglCanvasRef = useRef<HTMLCanvasElement>(null)
  const voronoiRef = useRef<VoronoiDrawer | null>(null)
  const webglRef = useRef<VoronoiWebGL | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const seedInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [webglSupported, setWebglSupported] = useState(true)  // Detect on mount

  // Animation state
  const [isPlaying, setIsPlaying] = useState(false)
  const [fps, setFps] = useState(0)
  const [usePixelRendering, setUsePixelRendering] = useState(true)
  const [useL1Metric, setUseL1Metric] = useState(false)
  const animationFrameRef = useRef<number | null>(null)
  const originalImgDataRef = useRef<ImageData | null>(null)
  const animatedSitesRef = useRef<Position[]>([])
  const velocitiesRef = useRef<Position[]>([])  // Unit vectors (magnitude 1)
  const frameCountRef = useRef(0)
  const fpsUpdateTimeRef = useRef(0)
  const lastFrameTimeRef = useRef(0)  // For delta time calculation
  const animationHistoryRef = useRef<Position[][]>([])
  const historyPositionRef = useRef(0)  // Current position in history (for stepping back)

  // Hover state for revealing original image
  const [hoveredCell, setHoveredCell] = useState<number | null>(null)
  const cellOfRef = useRef<Int32Array | null>(null)
  const cellColorsRef = useRef<RGB[] | null>(null)

  // Refs to track settings for callbacks
  const metricRef = useRef<DistanceMetric>('L2')
  const pixelRenderingRef = useRef(true)
  const webglRef2 = useRef(false)  // Track useWebGL for callbacks

  // Undo/redo history
  const historyRef = useRef<HistoryEntry[]>([])
  const historyIndexRef = useRef(-1)
  const isRestoringRef = useRef(false)

  // URL params for shareable settings
  const { values, setValues } = useUrlParams({
    s: intParam(0),        // seed (default 0, omitted from URL)
    n: intParam(400),      // numSites
    i: boolParam,          // inversePP
    v: intParam(15),       // speed (velocity, pixels/sec)
    g: boolParamDefaultTrue,  // WebGL (gpu acceleration, default true)
  })

  const seed = values.s
  const numSites = values.n
  const inversePP = values.i
  const speed = values.v
  const useWebGL = values.g

  // Session storage for large data (image + sites)
  const [imageState, setImageState] = useSessionStorageState<ImageState>('voronoi-image', {
    defaultValue: DEFAULT_IMAGE_STATE,
  })
  const { imageDataUrl, sites } = imageState

  // Push current state to history
  const pushHistory = useCallback((entry: HistoryEntry) => {
    if (isRestoringRef.current) return

    const history = historyRef.current
    const index = historyIndexRef.current

    // Remove any future history if we're not at the end
    if (index < history.length - 1) {
      history.splice(index + 1)
    }

    // Add new entry
    history.push(entry)

    // Trim old entries if we exceed max
    if (history.length > MAX_HISTORY) {
      history.shift()
    } else {
      historyIndexRef.current = history.length - 1
    }
  }, [])

  // Restore a history entry
  const restoreEntry = useCallback((entry: HistoryEntry) => {
    isRestoringRef.current = true

    // Load image and redraw
    const image = new Image()
    image.src = entry.imageDataUrl || sampleImage
    image.onload = () => {
      imgRef.current = image

      const canvas = canvasRef.current
      if (!canvas) return

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      canvas.height = image.height
      canvas.width = image.width
      ctx.drawImage(image, 0, 0)

      voronoiRef.current = new VoronoiDrawer(canvas, entry.numSites, entry.inversePP)
      voronoiRef.current.fillVoronoi(entry.sites, entry.seed)

      setValues({ s: entry.seed, n: entry.numSites, i: entry.inversePP })
      setImageState({ imageDataUrl: entry.imageDataUrl, sites: entry.sites })

      isRestoringRef.current = false
    }
  }, [setValues, setImageState])

  const undo = useCallback(() => {
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--
      restoreEntry(historyRef.current[historyIndexRef.current])
    }
  }, [restoreEntry])

  const redo = useCallback(() => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current++
      restoreEntry(historyRef.current[historyIndexRef.current])
    }
  }, [restoreEntry])

  // Keep refs in sync with state
  useEffect(() => {
    metricRef.current = useL1Metric ? 'L1' : 'L2'
  }, [useL1Metric])

  useEffect(() => {
    pixelRenderingRef.current = usePixelRendering
  }, [usePixelRendering])

  useEffect(() => {
    webglRef2.current = useWebGL && webglSupported
  }, [useWebGL, webglSupported])

  // Detect WebGL support on mount
  useEffect(() => {
    const testCanvas = document.createElement('canvas')
    const gl = testCanvas.getContext('webgl')
    const ext = gl?.getExtension('ANGLE_instanced_arrays')
    const supported = !!(gl && ext)
    setWebglSupported(supported)
    if (!supported) {
      console.warn('[WebGL] Not supported - falling back to CPU rendering')
    }
  }, [])

  // Helper to ensure WebGL is initialized with correct dimensions
  const ensureWebGL = useCallback((): VoronoiWebGL | null => {
    const canvas = canvasRef.current
    const webglCanvas = webglCanvasRef.current
    if (!canvas || !webglCanvas) return null

    // Reinitialize if dimensions changed
    if (!webglRef.current ||
        webglCanvas.width !== canvas.width ||
        webglCanvas.height !== canvas.height) {
      webglCanvas.width = canvas.width
      webglCanvas.height = canvas.height
      if (webglRef.current) webglRef.current.dispose()
      try {
        webglRef.current = new VoronoiWebGL(webglCanvas)
        console.log(`[WebGL] initialized ${canvas.width}x${canvas.height}`)
      } catch (e) {
        console.warn('[WebGL] initialization failed:', e)
        webglRef.current = null
      }
    }
    return webglRef.current
  }, [])

  const drawVoronoi = useCallback((
    drawer: VoronoiDrawer,
    seedVal: number,
    existingSites?: Position[],
    usePixels: boolean = true,
  ): Position[] => {
    if (usePixels) {
      // Use WebGL if enabled
      if (webglRef2.current) {
        const webgl = ensureWebGL()
        if (webgl) {
          const t0 = performance.now()
          // Use existing sites, or get from drawer if count matches, otherwise regenerate
          const existingOrCached = existingSites || drawer.getSites()
          const finalSites = existingOrCached.length === drawer.numSites
            ? existingOrCached
            : drawer.generateSites(seedVal)
          const canvas = canvasRef.current
          if (canvas) {
            const ctx = canvas.getContext('2d')
            if (ctx) {
              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
              const result = webgl.compute(finalSites, imgData.data)
              cellOfRef.current = result.cellOf
              cellColorsRef.current = result.cellColors

              // Draw the result
              drawer.drawFromCellData(result.cellOf, result.cellColors, finalSites)
              console.log(`[WebGL] ${(performance.now() - t0).toFixed(1)}ms`)
            }
          }
          return finalSites
        }
      }
      // CPU pixel rendering - also provides cell membership data for hover
      const result = drawer.fillVoronoiPixels(existingSites, seedVal, metricRef.current)
      if (result) {
        cellOfRef.current = result.cellOf
        cellColorsRef.current = result.cellColors
      }
    } else {
      // Polygon rendering - no hover support
      drawer.fillVoronoi(existingSites, seedVal)
      cellOfRef.current = null
      cellColorsRef.current = null
    }
    return drawer.getSites()
  }, [ensureWebGL])

  const drawImg = useCallback((
    image: HTMLImageElement,
    fileChanged: boolean,
    sitesCount: number,
    inversePPVal: boolean,
    seedVal: number,
    existingSites?: Position[],
    usePixels: boolean = true,
  ): Position[] => {
    const canvas = canvasRef.current
    if (!canvas) return []

    const ctx = canvas.getContext('2d')
    if (!ctx) return []

    canvas.height = image.height
    canvas.width = image.width
    ctx.drawImage(image, 0, 0)

    // Store original image data for hover reveal (before Voronoi overwrites it)
    originalImgDataRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height)

    if (fileChanged || !voronoiRef.current) {
      voronoiRef.current = new VoronoiDrawer(canvas, sitesCount, inversePPVal)
    }

    return drawVoronoi(voronoiRef.current, seedVal, existingSites, usePixels)
  }, [drawVoronoi])

  // Load image and render on mount
  useEffect(() => {
    const loadAndDraw = (src: string | null, seedVal: number, existingSites?: Position[]) => {
      const image = new Image()
      image.src = src || sampleImage
      image.onload = () => {
        imgRef.current = image
        const newSites = drawImg(image, true, numSites, inversePP, seedVal, existingSites, pixelRenderingRef.current)
        const finalSites = existingSites && existingSites.length > 0 ? existingSites : newSites
        if (!existingSites || existingSites.length === 0) {
          setImageState(prev => ({ ...prev, sites: newSites }))
        }
        // Initialize history with current state
        if (historyRef.current.length === 0) {
          pushHistory({
            imageDataUrl: src,
            sites: finalSites,
            seed: seedVal,
            numSites,
            inversePP,
          })
        }
      }
    }

    if (imageDataUrl) {
      loadAndDraw(imageDataUrl, seed, sites.length > 0 ? sites : undefined)
    } else {
      loadAndDraw(null, seed)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadImageFromFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string
      const image = new Image()
      image.src = dataUrl
      image.onload = () => {
        imgRef.current = image
        const newSites = drawImg(image, true, numSites, inversePP, seed, undefined, pixelRenderingRef.current)
        setImageState({ imageDataUrl: dataUrl, sites: newSites })
        pushHistory({ imageDataUrl: dataUrl, sites: newSites, seed, numSites, inversePP })
      }
    }
    reader.readAsDataURL(file)
  }, [drawImg, numSites, inversePP, seed, setImageState, pushHistory])

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    loadImageFromFile(files[0])
  }

  // Drag & drop handlers
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const files = e.dataTransfer.files
    if (files.length > 0) {
      loadImageFromFile(files[0])
    }
  }

  // Paste from clipboard
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            loadImageFromFile(file)
            break
          }
        }
      }
    }

    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [loadImageFromFile])

  const handleNumSitesChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newNumSites = parseInt(e.target.value, 10)
    updateNumSites(newNumSites)
  }

  const updateNumSites = (newNumSites: number, recordHistory = true) => {
    if (imgRef.current && voronoiRef.current) {
      voronoiRef.current.numSites = newNumSites
      const newSites = drawImg(imgRef.current, false, newNumSites, inversePP, seed, undefined, pixelRenderingRef.current)
      setValues({ n: newNumSites })
      setImageState(prev => ({ ...prev, sites: newSites }))
      // Clear animation history since sites changed
      animationHistoryRef.current = []
      historyPositionRef.current = 0
      if (recordHistory) {
        pushHistory({ imageDataUrl, sites: newSites, seed, numSites: newNumSites, inversePP })
      }
    }
  }

  // Scale sites using split/merge to preserve existing site positions
  const scaleSitesWithSplitMerge = useCallback((targetCount: number) => {
    const canvas = canvasRef.current
    const drawer = voronoiRef.current
    const img = imgRef.current
    if (!canvas || !drawer || !img) return

    const { width, height } = canvas
    const currentSites = drawer.getSites()

    // Use split or merge based on direction
    const newSites = targetCount > currentSites.length
      ? splitSites(currentSites, targetCount, width, height)
      : mergeSites(currentSites, targetCount)

    // Update drawer
    drawer.numSites = targetCount

    // If animating, update animation state
    if (animatedSitesRef.current.length > 0) {
      const oldAnimatedSites = animatedSitesRef.current
      const oldVelocities = velocitiesRef.current

      if (targetCount > oldAnimatedSites.length) {
        // Splitting: add new sites near existing ones
        const toAdd = targetCount - oldAnimatedSites.length
        const newAnimatedSites = [...oldAnimatedSites]
        const newVelocities = [...oldVelocities]

        const avgCellRadius = Math.sqrt((width * height) / oldAnimatedSites.length) / 2
        const splitOffset = avgCellRadius * 0.3

        const indices = oldAnimatedSites.map((_, i) => i)
        for (let i = indices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indices[i], indices[j]] = [indices[j], indices[i]]
        }

        for (let i = 0; i < toAdd; i++) {
          const srcIdx = indices[i % indices.length]
          const src = oldAnimatedSites[srcIdx]

          const angle = Math.random() * Math.PI * 2
          newAnimatedSites.push({
            x: Math.max(0, Math.min(width - 1, src.x + Math.cos(angle) * splitOffset)),
            y: Math.max(0, Math.min(height - 1, src.y + Math.sin(angle) * splitOffset)),
          })
          // New site gets similar velocity with slight variation
          const velAngle = Math.random() * Math.PI * 2
          newVelocities.push({
            x: Math.cos(velAngle),
            y: Math.sin(velAngle),
          })
        }

        animatedSitesRef.current = newAnimatedSites
        velocitiesRef.current = newVelocities
      } else {
        // Merging: remove random sites
        const shuffledIndices = oldAnimatedSites.map((_, i) => i)
        for (let i = shuffledIndices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffledIndices[i], shuffledIndices[j]] = [shuffledIndices[j], shuffledIndices[i]]
        }
        const keepIndices = new Set(shuffledIndices.slice(0, targetCount))

        animatedSitesRef.current = oldAnimatedSites.filter((_, i) => keepIndices.has(i))
        velocitiesRef.current = oldVelocities.filter((_, i) => keepIndices.has(i))
      }

      // Clear animation history since sites changed
      animationHistoryRef.current = [animatedSitesRef.current.map(s => ({ ...s }))]
      historyPositionRef.current = 0
    }

    // Draw with the new sites
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.drawImage(img, 0, 0)
      originalImgDataRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height)
    }

    // Use animated sites if available, otherwise the split/merged sites
    const sitesToDraw = animatedSitesRef.current.length > 0
      ? animatedSitesRef.current
      : newSites
    drawVoronoi(drawer, seed, sitesToDraw, pixelRenderingRef.current)

    setValues({ n: targetCount })
    setImageState(prev => ({ ...prev, sites: sitesToDraw }))
    pushHistory({ imageDataUrl, sites: sitesToDraw, seed, numSites: targetCount, inversePP })
  }, [seed, inversePP, imageDataUrl, setValues, setImageState, pushHistory, drawVoronoi])

  const handleInversePPChange = () => {
    toggleInversePP()
  }

  const toggleInversePP = () => {
    const newInversePP = !inversePP
    if (imgRef.current) {
      const newSites = drawImg(imgRef.current, true, numSites, newInversePP, seed, undefined, pixelRenderingRef.current)
      setValues({ i: newInversePP })
      setImageState(prev => ({ ...prev, sites: newSites }))
      pushHistory({ imageDataUrl, sites: newSites, seed, numSites, inversePP: newInversePP })
    }
  }

  const handleSeedChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newSeed = parseInt(e.target.value, 10)
    if (isNaN(newSeed)) return
    updateSeed(newSeed)
  }

  const updateSeed = (newSeed: number, recordHistory = true) => {
    if (imgRef.current) {
      const newSites = drawImg(imgRef.current, false, numSites, inversePP, newSeed, undefined, pixelRenderingRef.current)
      setValues({ s: newSeed })
      setImageState(prev => ({ ...prev, sites: newSites }))
      if (recordHistory) {
        pushHistory({ imageDataUrl, sites: newSites, seed: newSeed, numSites, inversePP })
      }
    }
  }

  const handleDownload = () => {
    downloadImage()
  }

  const focusSeedInput = () => {
    seedInputRef.current?.focus()
    seedInputRef.current?.select()
  }

  const downloadImage = () => {
    const canvas = canvasRef.current
    if (!canvas) return

    canvas.toBlob((blob) => {
      if (blob) {
        saveAs(blob, 'voronoi.png')
      }
    })
  }

  // Animation functions
  // Calculate max history frames based on site count (target ~2MB max)
  const getMaxHistoryFrames = useCallback(() => {
    const bytesPerSite = 20  // ~20 bytes per site in array form
    const targetBytes = 2 * 1024 * 1024  // 2MB
    const siteCount = animatedSitesRef.current.length || numSites
    return Math.max(50, Math.floor(targetBytes / (siteCount * bytesPerSite)))
  }, [numSites])

  const initializeAnimation = useCallback(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    const drawer = voronoiRef.current
    if (!canvas || !img || !drawer) return

    // Store original image data for re-rendering each frame
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, 0, 0)
    originalImgDataRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height)

    // Use the drawer's actual sites (not React state which might be stale)
    const currentSites = drawer.getSites()
    animatedSitesRef.current = currentSites.map(s => ({ ...s }))
    // Create unit velocity vectors (random direction, magnitude 1)
    velocitiesRef.current = currentSites.map(() => {
      const angle = Math.random() * Math.PI * 2
      return { x: Math.cos(angle), y: Math.sin(angle) }
    })

    // Initialize history with current state
    animationHistoryRef.current = [currentSites.map(s => ({ ...s }))]
    historyPositionRef.current = 0
  }, [numSites])

  // Render a specific frame (sites) without advancing physics
  const renderFrame = useCallback((sites: Position[]) => {
    const canvas = canvasRef.current
    const drawer = voronoiRef.current
    const originalImgData = originalImgDataRef.current
    if (!canvas || !drawer || !originalImgData) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.putImageData(originalImgData, 0, 0)

    if (pixelRenderingRef.current) {
      // Use WebGL if enabled
      if (webglRef2.current) {
        const webgl = ensureWebGL()
        if (webgl) {
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const result = webgl.compute(sites, imgData.data)
          cellOfRef.current = result.cellOf
          cellColorsRef.current = result.cellColors
          drawer.drawFromCellData(result.cellOf, result.cellColors, sites)
          return
        }
      }
      // Fall back to CPU
      const result = drawer.fillVoronoiPixels(sites, undefined, metricRef.current)
      if (result) {
        cellOfRef.current = result.cellOf
        cellColorsRef.current = result.cellColors
      }
    } else {
      drawer.fillVoronoi(sites)
    }
  }, [ensureWebGL])

  const animationStep = useCallback((saveToHistory = true) => {
    const canvas = canvasRef.current
    const drawer = voronoiRef.current
    const originalImgData = originalImgDataRef.current
    if (!canvas || !drawer || !originalImgData) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { width, height } = canvas
    const animatedSites = animatedSitesRef.current
    const velocities = velocitiesRef.current

    // Calculate delta time for frame-rate independent movement
    const now = performance.now()
    const deltaTime = lastFrameTimeRef.current > 0
      ? (now - lastFrameTimeRef.current) / 1000  // Convert to seconds
      : 1 / 60  // Default to ~60fps for first frame
    lastFrameTimeRef.current = now

    // Movement amount: speed (pixels/sec) * deltaTime (sec) = pixels
    const movement = speed * deltaTime

    // Move sites
    for (let i = 0; i < animatedSites.length; i++) {
      animatedSites[i].x += velocities[i].x * movement
      animatedSites[i].y += velocities[i].y * movement

      // Bounce off edges
      if (animatedSites[i].x < 0 || animatedSites[i].x >= width) {
        velocities[i].x *= -1
        animatedSites[i].x = Math.max(0, Math.min(width - 1, animatedSites[i].x))
      }
      if (animatedSites[i].y < 0 || animatedSites[i].y >= height) {
        velocities[i].y *= -1
        animatedSites[i].y = Math.max(0, Math.min(height - 1, animatedSites[i].y))
      }
    }

    // Save to history if enabled
    if (saveToHistory) {
      const history = animationHistoryRef.current
      const maxFrames = getMaxHistoryFrames()

      // If we stepped back and are now advancing, truncate future history
      if (historyPositionRef.current < history.length - 1) {
        history.splice(historyPositionRef.current + 1)
      }

      // Add current frame
      history.push(animatedSites.map(s => ({ ...s })))
      historyPositionRef.current = history.length - 1

      // Trim old frames if exceeding max
      if (history.length > maxFrames) {
        history.shift()
        historyPositionRef.current--
      }
    }

    // Restore original image
    ctx.putImageData(originalImgData, 0, 0)

    // Re-render Voronoi
    if (usePixelRendering) {
      // Use WebGL if enabled
      if (webglRef2.current) {
        const webgl = ensureWebGL()
        if (webgl) {
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const result = webgl.compute(animatedSites, imgData.data)
          cellOfRef.current = result.cellOf
          cellColorsRef.current = result.cellColors
          drawer.drawFromCellData(result.cellOf, result.cellColors, animatedSites)
        } else {
          // Fall back to CPU if WebGL failed
          const result = drawer.fillVoronoiPixels(animatedSites, undefined, metricRef.current)
          if (result) {
            cellOfRef.current = result.cellOf
            cellColorsRef.current = result.cellColors
          }
        }
      } else {
        const result = drawer.fillVoronoiPixels(animatedSites, undefined, metricRef.current)
        if (result) {
          cellOfRef.current = result.cellOf
          cellColorsRef.current = result.cellColors
        }
      }
    } else {
      drawer.fillVoronoi(animatedSites)
    }

    // Update FPS (reuse `now` from delta time calculation above)
    frameCountRef.current++
    const fpsNow = performance.now()
    if (fpsNow - fpsUpdateTimeRef.current >= 1000) {
      setFps(Math.round(frameCountRef.current * 1000 / (fpsNow - fpsUpdateTimeRef.current)))
      frameCountRef.current = 0
      fpsUpdateTimeRef.current = fpsNow
    }
  }, [usePixelRendering, getMaxHistoryFrames, ensureWebGL, speed])

  const animate = useCallback(() => {
    animationStep()
    animationFrameRef.current = requestAnimationFrame(animate)
  }, [animationStep])

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      // Stop
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
      setIsPlaying(false)
      setFps(0)
    } else {
      // Start
      initializeAnimation()
      fpsUpdateTimeRef.current = performance.now()
      lastFrameTimeRef.current = 0  // Reset for proper delta time on first frame
      frameCountRef.current = 0
      setIsPlaying(true)
      animationFrameRef.current = requestAnimationFrame(animate)
    }
  }, [isPlaying, initializeAnimation, animate])

  // Step backward in animation history
  const stepBackward = useCallback(() => {
    const history = animationHistoryRef.current
    if (history.length === 0 || historyPositionRef.current <= 0) return

    // Stop continuous animation if playing
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
      setIsPlaying(false)
      setFps(0)
    }

    historyPositionRef.current--
    const sites = history[historyPositionRef.current]
    animatedSitesRef.current = sites.map(s => ({ ...s }))
    renderFrame(sites)
  }, [renderFrame])

  // Step forward in animation history, or advance physics if at end
  const stepForward = useCallback(() => {
    const t0 = performance.now()

    // If no history, initialize first
    if (animationHistoryRef.current.length === 0) {
      initializeAnimation()
    }

    // Stop continuous animation if playing
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
      setIsPlaying(false)
      setFps(0)
    }

    // Re-read history after potential initialization
    const history = animationHistoryRef.current

    // If we're not at the end of history, just move forward
    if (historyPositionRef.current < history.length - 1) {
      historyPositionRef.current++
      const sites = history[historyPositionRef.current]
      animatedSitesRef.current = sites.map(s => ({ ...s }))
      renderFrame(sites)
    } else {
      // At end of history, advance physics
      animationStep(true)
    }

    console.log(`[step] ${(performance.now() - t0).toFixed(0)}ms`)
  }, [initializeAnimation, renderFrame, animationStep])

  const toggleRenderMode = useCallback(() => {
    setUsePixelRendering(prev => {
      const newValue = !prev
      // Update ref immediately so re-render uses the new mode
      pixelRenderingRef.current = newValue
      // Re-render with the new mode
      if (imgRef.current && voronoiRef.current) {
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (canvas && ctx) {
          ctx.drawImage(imgRef.current, 0, 0)
          originalImgDataRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height)
          if (newValue) {
            const result = voronoiRef.current.fillVoronoiPixels(undefined, seed, metricRef.current)
            if (result) {
              cellOfRef.current = result.cellOf
              cellColorsRef.current = result.cellColors
            }
          } else {
            voronoiRef.current.fillVoronoi(undefined, seed)
            cellOfRef.current = null
            cellColorsRef.current = null
          }
        }
      }
      return newValue
    })
  }, [seed])

  // Render with hover effect - show original image for hovered cell with border
  const renderWithHover = useCallback((hoveredCellIdx: number | null) => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    const originalImgData = originalImgDataRef.current
    const cellOf = cellOfRef.current
    const cellColors = cellColorsRef.current

    if (!canvas || !ctx || !originalImgData || !cellOf || !cellColors) return

    const { width, height } = canvas
    const numPixels = width * height

    // Create a copy of original image data to modify
    const imgData = new ImageData(
      new Uint8ClampedArray(originalImgData.data),
      width,
      height
    )
    const pixels = imgData.data

    // Color all pixels except the hovered cell
    for (let i = 0; i < numPixels; i++) {
      const cell = cellOf[i]
      if (cell >= 0 && cell !== hoveredCellIdx && cellColors[cell]) {
        const [r, g, b] = cellColors[cell]
        const px = i * 4
        pixels[px] = r
        pixels[px + 1] = g
        pixels[px + 2] = b
        // alpha stays the same
      }
    }

    // Draw black border around hovered cell (pixels near boundary)
    if (hoveredCellIdx !== null) {
      const borderWidth = 3
      for (let i = 0; i < numPixels; i++) {
        if (cellOf[i] !== hoveredCellIdx) continue

        const x = i % width
        const y = (i - x) / width

        // Check if any pixel within borderWidth is from a different cell
        let isBorder = false
        outer: for (let dy = -borderWidth; dy <= borderWidth && !isBorder; dy++) {
          for (let dx = -borderWidth; dx <= borderWidth; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const nidx = ny * width + nx
              if (cellOf[nidx] !== hoveredCellIdx) {
                isBorder = true
                break outer
              }
            }
          }
        }

        if (isBorder) {
          const px = i * 4
          pixels[px] = 0
          pixels[px + 1] = 0
          pixels[px + 2] = 0
        }
      }
    }

    ctx.putImageData(imgData, 0, 0)
  }, [])

  // Handle mouse move to detect hovered cell
  const handleCanvasMouseMove = useCallback((e: MouseEvent<HTMLCanvasElement>) => {
    if (isPlaying) return  // Don't track hover during animation

    const canvas = canvasRef.current
    const cellOf = cellOfRef.current
    if (!canvas || !cellOf) return

    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height

    const x = Math.floor((e.clientX - rect.left) * scaleX)
    const y = Math.floor((e.clientY - rect.top) * scaleY)

    if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
      const idx = y * canvas.width + x
      const cell = cellOf[idx]
      if (cell !== hoveredCell) {
        setHoveredCell(cell)
        renderWithHover(cell)
      }
    }
  }, [isPlaying, hoveredCell, renderWithHover])

  // Handle mouse leave to restore full Voronoi
  const handleCanvasMouseLeave = useCallback(() => {
    if (hoveredCell !== null) {
      setHoveredCell(null)
      renderWithHover(null)
    }
  }, [hoveredCell, renderWithHover])

  // Cleanup animation on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [])

  // Cleanup WebGL on unmount
  useEffect(() => {
    return () => {
      if (webglRef.current) {
        webglRef.current.dispose()
        webglRef.current = null
      }
    }
  }, [])

  // Keyboard shortcuts
  useAction('voronoi:undo', {
    label: 'Undo',
    group: 'Voronoi',
    defaultBindings: ['z', 'meta+z'],
    handler: undo,
  })

  useAction('voronoi:redo', {
    label: 'Redo',
    group: 'Voronoi',
    defaultBindings: ['shift+z', 'meta+shift+z'],
    handler: redo,
  })

  useAction('voronoi:focus-seed', {
    label: 'Focus seed input',
    group: 'Voronoi',
    defaultBindings: ['f'],
    handler: focusSeedInput,
  })

  useAction('voronoi:toggle-inverse', {
    label: 'Toggle Inverse PP',
    group: 'Voronoi',
    defaultBindings: ['i'],
    handler: toggleInversePP,
  })

  useAction('voronoi:toggle-play', {
    label: 'Play/Pause animation',
    group: 'Voronoi',
    defaultBindings: ['space'],
    handler: togglePlay,
  })

  useAction('voronoi:toggle-render-mode', {
    label: 'Toggle pixel/polygon rendering',
    group: 'Voronoi',
    defaultBindings: ['p'],
    handler: toggleRenderMode,
  })

  useAction('voronoi:increase-sites', {
    label: 'Increase sites (+50)',
    group: 'Sites',
    defaultBindings: [']', '='],
    handler: () => updateNumSites(Math.min(SITES_MAX, numSites + SITES_STEP)),
  })

  useAction('voronoi:decrease-sites', {
    label: 'Decrease sites (-50)',
    group: 'Sites',
    defaultBindings: ['[', '-'],
    handler: () => updateNumSites(Math.max(SITES_MIN, numSites - SITES_STEP)),
  })

  useAction('voronoi:double-sites', {
    label: 'Double sites (×2)',
    group: 'Sites',
    defaultBindings: ['}'],
    handler: () => updateNumSites(Math.min(SITES_MAX, numSites * 2)),
  })

  useAction('voronoi:halve-sites', {
    label: 'Halve sites (÷2)',
    group: 'Sites',
    defaultBindings: ['{'],
    handler: () => updateNumSites(Math.max(SITES_MIN, Math.round(numSites / 2))),
  })

  useAction('voronoi:golden-up', {
    label: 'Scale sites up (×φ) with split',
    group: 'Sites',
    defaultBindings: [')'],
    handler: () => scaleSitesWithSplitMerge(Math.min(SITES_MAX, Math.floor(numSites * PHI))),
  })

  useAction('voronoi:golden-down', {
    label: 'Scale sites down (÷φ) with merge',
    group: 'Sites',
    defaultBindings: ['('],
    handler: () => scaleSitesWithSplitMerge(Math.max(SITES_MIN, Math.ceil(numSites / PHI))),
  })

  useAction('voronoi:step-forward', {
    label: 'Step forward',
    group: 'Sites',
    defaultBindings: ['>', 'ArrowRight'],
    handler: stepForward,
  })

  useAction('voronoi:step-backward', {
    label: 'Step backward',
    group: 'Sites',
    defaultBindings: ['<', 'ArrowLeft'],
    handler: stepBackward,
  })

  useAction('voronoi:download', {
    label: 'Download image',
    group: 'Voronoi',
    defaultBindings: ['s', 'meta+s'],
    handler: downloadImage,
  })

  const toggleMetric = useCallback(() => {
    setUseL1Metric(prev => {
      const newValue = !prev
      // Update ref immediately so re-render uses the new metric
      metricRef.current = newValue ? 'L1' : 'L2'
      // Re-render with the new metric
      if (imgRef.current && voronoiRef.current) {
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (canvas && ctx) {
          ctx.drawImage(imgRef.current, 0, 0)
          originalImgDataRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const result = voronoiRef.current.fillVoronoiPixels(undefined, seed, newValue ? 'L1' : 'L2')
          if (result) {
            cellOfRef.current = result.cellOf
            cellColorsRef.current = result.cellColors
          }
        }
      }
      return newValue
    })
  }, [seed])

  useAction('voronoi:toggle-metric', {
    label: 'Toggle L1/L2 metric',
    group: 'Voronoi',
    defaultBindings: ['m'],
    handler: toggleMetric,
  })

  const toggleWebGL = useCallback(() => {
    if (!webglSupported) return
    const newValue = !useWebGL
    webglRef2.current = newValue && webglSupported
    setValues({ g: newValue })
    // Re-render with the new mode
    if (imgRef.current && voronoiRef.current) {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (canvas && ctx) {
        ctx.drawImage(imgRef.current, 0, 0)
        originalImgDataRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height)
        drawVoronoi(voronoiRef.current, seed, undefined, pixelRenderingRef.current)
      }
    }
  }, [seed, drawVoronoi, useWebGL, webglSupported, setValues])

  useAction('voronoi:toggle-webgl', {
    label: 'Toggle WebGL acceleration',
    group: 'Voronoi',
    defaultBindings: ['g'],
    handler: toggleWebGL,
  })

  return (
    <div
      className={`IV${isDragging ? ' dragging' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="nav-wrapper light-bg">
        <div className="control-wrapper">
          <label className="control-label file-label">
            Upload
            <input
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="file-input"
            />
          </label>
        </div>

        <div className="control-wrapper sites-control">
          <label className="control-label">Sites</label>
          <label className="control-input control-number number">{numSites}</label>
          <input
            className="control-input control-slider slider"
            type="range"
            value={numSites}
            min="50"
            max={SITES_MAX}
            step="50"
            onChange={handleNumSitesChange}
          />
        </div>

        <div className="control-wrapper seed-control">
          <label className="control-label">Seed</label>
          <input
            ref={seedInputRef}
            className="seed-input"
            type="number"
            min="0"
            value={seed}
            onChange={handleSeedChange}
          />
        </div>

        <div className="control-wrapper">
          <label className="selection-label">
            <input
              className="control-input checkbox"
              type="checkbox"
              checked={inversePP}
              onChange={handleInversePPChange}
            />
            {' '}Inverse PP
          </label>
        </div>

        <div className="control-wrapper">
          <button className="output-button" onClick={handleDownload}>
            Download Image
          </button>
        </div>

        <div className="control-wrapper">
          <button className="output-button" onClick={togglePlay}>
            {isPlaying ? 'Pause' : 'Play'}
          </button>
        </div>

        <div className="control-wrapper">
          <label className="selection-label">
            <input
              className="control-input checkbox"
              type="checkbox"
              checked={usePixelRendering}
              onChange={toggleRenderMode}
            />
            {' '}Pixel Mode
          </label>
        </div>

        <div className="control-wrapper">
          <label className="selection-label">
            <input
              className="control-input checkbox"
              type="checkbox"
              checked={useL1Metric}
              onChange={toggleMetric}
            />
            {' '}L1 (fast)
          </label>
        </div>

        <div className="control-wrapper">
          <label
            className="selection-label"
            title={webglSupported ? undefined : 'WebGL not supported in this browser'}
            style={webglSupported ? undefined : { opacity: 0.5, cursor: 'not-allowed' }}
          >
            <input
              className="control-input checkbox"
              type="checkbox"
              checked={useWebGL && webglSupported}
              onChange={toggleWebGL}
              disabled={!webglSupported}
            />
            {' '}WebGL{!webglSupported && ' (unsupported)'}
          </label>
        </div>

        <div className="control-wrapper speed-control">
          <label className="control-label">Speed</label>
          <label className="control-input control-number number">{speed}</label>
          <input
            className="control-input control-slider slider"
            type="range"
            value={speed}
            min="1"
            max="60"
            step="1"
            onChange={(e) => setValues({ v: parseInt(e.target.value, 10) })}
          />
        </div>

        {isPlaying && (
          <div className="control-wrapper">
            <label className="control-label fps-label">{fps} FPS</label>
          </div>
        )}
      </div>

      <div className="canvas-wrapper">
        <canvas
          className="canvas"
          ref={canvasRef}
          onMouseMove={handleCanvasMouseMove}
          onMouseLeave={handleCanvasMouseLeave}
        />
        {/* Hidden canvas for WebGL rendering */}
        <canvas
          ref={webglCanvasRef}
          style={{ display: 'none' }}
        />
      </div>
    </div>
  )
}
