import { useRef, useEffect, useCallback, ChangeEvent, DragEvent, useState, MouseEvent } from 'react'
import useSessionStorageState from 'use-session-storage-state'
import { useUrlParams, intParam, boolParam, floatParam, Param } from 'use-prms/hash'
import { useAction } from 'use-kbd'
import { saveAs } from 'file-saver'
import Tooltip from '@mui/material/Tooltip'
import { VoronoiDrawer, Position, DistanceMetric } from '../voronoi/VoronoiDrawer'
import { VoronoiWebGL } from '../voronoi/VoronoiWebGL'
import { ImageGallery, storeImage } from './ImageGallery'
import { isOPFSSupported } from '../storage/ImageStorage'
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
const SITES_MIN = 25
const SITES_MAX = 20000
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
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [webglSupported, setWebglSupported] = useState(true)  // Detect on mount

  // Animation state
  const [isPlaying, setIsPlaying] = useState(false)
  const [fps, setFps] = useState(0)
  const [usePixelRendering] = useState(true)  // Always use pixel rendering
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
  const cellAreasRef = useRef<Uint32Array | null>(null)

  // Site visualization
  const [showSites, setShowSites] = useState(false)
  const showSitesRef = useRef(false)

  // Image metadata
  const [imageFilename, setImageFilename] = useState<string | null>(null)
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null)
  const [currentImageId, setCurrentImageId] = useState<string | undefined>(undefined)

  // Image scaling - store original full-res and current scale
  const [originalDimensions, setOriginalDimensions] = useState<{ width: number; height: number } | null>(null)
  const originalImageRef = useRef<HTMLImageElement | null>(null)  // Keep full-res in memory
  const [imageScale, setImageScale] = useState(1)  // Current scale factor (1 = full res)

  // Current and target site counts for UI display during gradual growth
  const [currentSiteCount, setCurrentSiteCount] = useState(0)
  const [targetSiteCount, setTargetSiteCount] = useState(0)

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
    d: floatParam(0),      // doublingTime (seconds, 0 = instant/disabled)
  })

  const seed = values.s
  const numSites = values.n
  const inversePP = values.i
  const speed = values.v
  const useWebGL = values.g
  const doublingTime = values.d

  // Gradual growth state (for smooth site count changes)
  const targetSitesRef = useRef<number>(numSites)  // Target we're growing/shrinking toward
  const fractionalSitesRef = useRef<number>(0)     // Accumulated fractional sites

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
    pixelRenderingRef.current = usePixelRendering
  }, [usePixelRendering])

  useEffect(() => {
    webglRef2.current = useWebGL && webglSupported
  }, [useWebGL, webglSupported])

  useEffect(() => {
    showSitesRef.current = showSites
  }, [showSites])

  // Sync targetSitesRef when numSites changes from slider or other direct updates
  useEffect(() => {
    // Only sync if not in gradual mode or if we're not animating
    // (during animation, targetSitesRef is managed separately)
    if (doublingTime === 0 || !isPlaying) {
      targetSitesRef.current = numSites
    }
  }, [numSites, doublingTime, isPlaying])

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
              cellAreasRef.current = result.cellAreas

              // Draw the result
              drawer.drawFromCellData(result.cellOf, result.cellColors, finalSites)
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

  // Compute available scale options based on original dimensions
  const getScaleOptions = useCallback((origWidth: number, origHeight: number) => {
    const options: { label: string; scale: number; dims: string }[] = []

    // Full resolution
    options.push({ label: '1×', scale: 1, dims: `${origWidth}×${origHeight}` })

    // 3/4 scale if both dimensions are multiples of 4
    if (origWidth % 4 === 0 && origHeight % 4 === 0) {
      const w = Math.round(origWidth * 0.75)
      const h = Math.round(origHeight * 0.75)
      options.push({ label: '¾×', scale: 0.75, dims: `${w}×${h}` })
    }

    // Power of 2 downscales
    let scale = 0.5
    while (scale >= 0.125) {  // Down to 1/8
      const w = Math.round(origWidth * scale)
      const h = Math.round(origHeight * scale)
      if (w >= 100 && h >= 100) {  // Minimum useful size
        const label = scale === 0.5 ? '½×' : scale === 0.25 ? '¼×' : `1/${Math.round(1/scale)}×`
        options.push({ label, scale, dims: `${w}×${h}` })
      }
      scale /= 2
    }

    return options
  }, [])

  // Apply scale to the original image and redraw
  const applyImageScale = useCallback((scale: number) => {
    const origImg = originalImageRef.current
    if (!origImg) return

    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const newWidth = Math.round(origImg.width * scale)
    const newHeight = Math.round(origImg.height * scale)

    canvas.width = newWidth
    canvas.height = newHeight
    ctx.drawImage(origImg, 0, 0, newWidth, newHeight)

    // Update dimensions display
    setImageDimensions({ width: newWidth, height: newHeight })
    setImageScale(scale)

    // Store scaled image data
    originalImgDataRef.current = ctx.getImageData(0, 0, newWidth, newHeight)

    // Create scaled image element for imgRef
    const scaledImg = new Image()
    scaledImg.width = newWidth
    scaledImg.height = newHeight
    const dataUrl = canvas.toDataURL()
    scaledImg.src = dataUrl
    scaledImg.onload = () => {
      imgRef.current = scaledImg

      // Reinitialize WebGL with new dimensions
      if (webglRef.current) {
        webglRef.current.dispose()
        webglRef.current = null
      }

      // Reinitialize Voronoi drawer and redraw
      voronoiRef.current = new VoronoiDrawer(canvas, numSites, inversePP)
      const newSites = drawVoronoi(voronoiRef.current, seed, undefined, pixelRenderingRef.current)
      setImageState(prev => ({ ...prev, sites: newSites }))

      // Clear animation state since image changed
      animatedSitesRef.current = []
      velocitiesRef.current = []
      animationHistoryRef.current = []
      historyPositionRef.current = 0
    }
  }, [numSites, inversePP, seed, drawVoronoi, setImageState])

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
        // Store original full-resolution image
        originalImageRef.current = image
        setOriginalDimensions({ width: image.width, height: image.height })
        setImageScale(1)

        imgRef.current = image
        setImageDimensions({ width: image.width, height: image.height })
        if (!src) setImageFilename('sample.jpg')
        const newSites = drawImg(image, true, numSites, inversePP, seedVal, existingSites, pixelRenderingRef.current)
        setCurrentSiteCount(newSites.length)
        setTargetSiteCount(numSites)
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
      image.onload = async () => {
        // Store original full-resolution image
        originalImageRef.current = image
        setOriginalDimensions({ width: image.width, height: image.height })
        setImageScale(1)

        imgRef.current = image
        setImageFilename(file.name)
        setImageDimensions({ width: image.width, height: image.height })
        const newSites = drawImg(image, true, numSites, inversePP, seed, undefined, pixelRenderingRef.current)
        setImageState({ imageDataUrl: dataUrl, sites: newSites })
        pushHistory({ imageDataUrl: dataUrl, sites: newSites, seed, numSites, inversePP })

        // Store to OPFS if supported
        if (isOPFSSupported()) {
          try {
            const stored = await storeImage(file)
            setCurrentImageId(stored.id)
          } catch (e) {
            console.warn('[OPFS] Failed to store image:', e)
          }
        }
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

  // Request a site count change - gradual if doublingTime > 0, instant otherwise
  const requestSiteChange = useCallback((targetCount: number) => {
    targetCount = Math.max(SITES_MIN, Math.min(SITES_MAX, targetCount))
    setTargetSiteCount(targetCount)

    if (doublingTime > 0) {
      // Gradual mode: set target and let animation handle it
      targetSitesRef.current = targetCount
      fractionalSitesRef.current = 0  // Reset accumulator

      // If not animating, need to start a temporary animation loop
      // For now, just do instant change when not playing
      if (!isPlaying) {
        scaleSitesWithSplitMerge(targetCount)
        setCurrentSiteCount(targetCount)
      }
      // When playing, the animationStep will handle gradual growth
    } else {
      // Instant mode
      scaleSitesWithSplitMerge(targetCount)
      setCurrentSiteCount(targetCount)
    }
  }, [doublingTime, isPlaying, scaleSitesWithSplitMerge])

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

    // Initialize current/target site counts
    setCurrentSiteCount(currentSites.length)
    setTargetSiteCount(targetSitesRef.current)

    // Initialize history with current state
    animationHistoryRef.current = [currentSites.map(s => ({ ...s }))]
    historyPositionRef.current = 0
  }, [numSites])

  // Draw site markers and velocity vectors on the canvas
  const drawSitesOverlay = useCallback((ctx: CanvasRenderingContext2D, sites: Position[], velocities?: Position[]) => {
    if (!showSitesRef.current) return

    const velocityScale = 20  // Length of velocity arrows

    // Draw velocity vectors first (so dots are on top)
    if (velocities && velocities.length === sites.length) {
      ctx.strokeStyle = 'rgba(255, 100, 100, 0.8)'
      ctx.lineWidth = 1.5
      for (let i = 0; i < sites.length; i++) {
        const site = sites[i]
        const vel = velocities[i]
        ctx.beginPath()
        ctx.moveTo(site.x, site.y)
        ctx.lineTo(site.x + vel.x * velocityScale, site.y + vel.y * velocityScale)
        ctx.stroke()
      }
    }

    // Draw site dots
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'
    ctx.lineWidth = 1
    for (const site of sites) {
      ctx.beginPath()
      ctx.arc(site.x, site.y, 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }, [])

  // Redraw when showSites changes (if not animating)
  useEffect(() => {
    if (!isPlaying && animatedSitesRef.current.length > 0) {
      const canvas = canvasRef.current
      const drawer = voronoiRef.current
      const originalImgData = originalImgDataRef.current
      if (canvas && drawer && originalImgData) {
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.putImageData(originalImgData, 0, 0)
          if (pixelRenderingRef.current) {
            drawer.drawFromCellData(cellOfRef.current!, cellColorsRef.current!, animatedSitesRef.current)
          } else {
            drawer.fillVoronoi(animatedSitesRef.current)
          }
          drawSitesOverlay(ctx, animatedSitesRef.current, velocitiesRef.current)
        }
      }
    }
  }, [showSites, isPlaying, drawSitesOverlay])

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
          cellAreasRef.current = result.cellAreas
          drawer.drawFromCellData(result.cellOf, result.cellColors, sites)
          return
        }
      }
      // Fall back to CPU
      const result = drawer.fillVoronoiPixels(sites, undefined, metricRef.current)
      if (result) {
        cellOfRef.current = result.cellOf
        cellColorsRef.current = result.cellColors
        cellAreasRef.current = null  // CPU path doesn't compute areas yet
      }
    } else {
      drawer.fillVoronoi(sites)
    }

    // Draw site markers if enabled
    drawSitesOverlay(ctx, sites, velocitiesRef.current)
  }, [ensureWebGL, drawSitesOverlay])

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

    // Gradual growth: smoothly add/remove sites toward target
    if (doublingTime > 0 && targetSitesRef.current !== animatedSites.length) {
      const target = targetSitesRef.current
      const current = animatedSites.length
      const growing = target > current

      // Rate: sites change at ln(2)/doublingTime per site per second
      // This gives exponential growth with the specified doubling time
      const rate = Math.LN2 / doublingTime
      const expectedChange = current * rate * deltaTime

      // Accumulate fractional sites
      fractionalSitesRef.current += expectedChange

      // Snapshot cell areas at frame start (before any splits modify animatedSites.length)
      const cellAreas = cellAreasRef.current
      const areasValid = cellAreas && cellAreas.length > 0

      // Track which sites we've already split this frame (they'll have ~half their original area)
      const splitThisFrame = new Set<number>()

      // Process whole sites
      while (fractionalSitesRef.current >= 1) {
        fractionalSitesRef.current -= 1

        if (growing && animatedSites.length < target) {
          // Split: pick site with largest cell area (among original sites not yet split)
          let srcIdx = 0
          if (areasValid) {
            // Find site with maximum area that hasn't been split this frame
            // Only consider original sites (indices < cellAreas.length)
            let maxArea = -1
            for (let i = 0; i < cellAreas.length; i++) {
              if (!splitThisFrame.has(i) && cellAreas[i] > maxArea) {
                maxArea = cellAreas[i]
                srcIdx = i
              }
            }
            // If all original sites were split, pick from newly added ones randomly
            if (maxArea < 0) {
              srcIdx = Math.floor(Math.random() * animatedSites.length)
            }
            splitThisFrame.add(srcIdx)
          } else {
            // Fallback to random if areas not available
            srcIdx = Math.floor(Math.random() * animatedSites.length)
          }
          const src = animatedSites[srcIdx]

          // New site starts at exactly the same position
          animatedSites.push({ x: src.x, y: src.y })

          // Give parent and child diverging velocities
          const divergeAngle = Math.random() * Math.PI * 2
          const divergeX = Math.cos(divergeAngle)
          const divergeY = Math.sin(divergeAngle)

          // Child gets velocity pointing in diverge direction
          velocities.push({ x: divergeX, y: divergeY })
          // Parent gets velocity pointing opposite
          velocities[srcIdx] = { x: -divergeX, y: -divergeY }
        } else if (!growing && animatedSites.length > target) {
          // Merge: remove site with smallest cell area
          const cellAreas = cellAreasRef.current
          let removeIdx = 0
          if (cellAreas && cellAreas.length === animatedSites.length) {
            // Find site with minimum area
            let minArea = cellAreas[0]
            for (let i = 1; i < cellAreas.length; i++) {
              if (cellAreas[i] < minArea) {
                minArea = cellAreas[i]
                removeIdx = i
              }
            }
          } else {
            // Fallback to random if areas not available
            removeIdx = Math.floor(Math.random() * animatedSites.length)
          }
          animatedSites.splice(removeIdx, 1)
          velocities.splice(removeIdx, 1)
        }
      }

      // Update drawer's numSites to match current animated count
      if (drawer.numSites !== animatedSites.length) {
        drawer.numSites = animatedSites.length
        setCurrentSiteCount(animatedSites.length)
        // Only update URL when we reach the target (avoid throttling warnings)
        if (animatedSites.length === target) {
          setValues({ n: animatedSites.length })
        }
      }

      // Clear fractional accumulator when target reached
      if (animatedSites.length === target) {
        fractionalSitesRef.current = 0
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
          cellAreasRef.current = result.cellAreas
          drawer.drawFromCellData(result.cellOf, result.cellColors, animatedSites)
        } else {
          // Fall back to CPU if WebGL failed
          const result = drawer.fillVoronoiPixels(animatedSites, undefined, metricRef.current)
          if (result) {
            cellOfRef.current = result.cellOf
            cellColorsRef.current = result.cellColors
            cellAreasRef.current = null
          }
        }
      } else {
        const result = drawer.fillVoronoiPixels(animatedSites, undefined, metricRef.current)
        if (result) {
          cellOfRef.current = result.cellOf
          cellColorsRef.current = result.cellColors
          cellAreasRef.current = null
        }
      }
    } else {
      drawer.fillVoronoi(animatedSites)
    }

    // Draw site markers if enabled
    drawSitesOverlay(ctx, animatedSites, velocities)

    // Update FPS (reuse `now` from delta time calculation above)
    frameCountRef.current++
    const fpsNow = performance.now()
    if (fpsNow - fpsUpdateTimeRef.current >= 1000) {
      setFps(Math.round(frameCountRef.current * 1000 / (fpsNow - fpsUpdateTimeRef.current)))
      frameCountRef.current = 0
      fpsUpdateTimeRef.current = fpsNow
    }
  }, [usePixelRendering, getMaxHistoryFrames, ensureWebGL, speed, doublingTime, setValues, drawSitesOverlay])

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
    handler: () => requestSiteChange(Math.min(SITES_MAX, targetSitesRef.current * 2)),
  })

  useAction('voronoi:halve-sites', {
    label: 'Halve sites (÷2)',
    group: 'Sites',
    defaultBindings: ['{'],
    handler: () => requestSiteChange(Math.max(SITES_MIN, Math.round(targetSitesRef.current / 2))),
  })

  useAction('voronoi:golden-up', {
    label: 'Scale sites up (×φ)',
    group: 'Sites',
    defaultBindings: [')'],
    handler: () => requestSiteChange(Math.floor(targetSitesRef.current * PHI)),
  })

  useAction('voronoi:golden-down', {
    label: 'Scale sites down (÷φ)',
    group: 'Sites',
    defaultBindings: ['('],
    handler: () => requestSiteChange(Math.ceil(targetSitesRef.current / PHI)),
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

  const triggerUpload = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  useAction('voronoi:upload', {
    label: 'Upload image',
    group: 'Voronoi',
    defaultBindings: ['u'],
    handler: triggerUpload,
  })

  // Handle selecting an image from the gallery
  const handleSelectFromGallery = useCallback((blob: Blob, basename: string, id?: string) => {
    if (id) setCurrentImageId(id)

    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.src = url
    image.onload = () => {
      // Store original full-resolution image
      originalImageRef.current = image
      setOriginalDimensions({ width: image.width, height: image.height })
      setImageScale(1)

      imgRef.current = image
      setImageFilename(basename)
      setImageDimensions({ width: image.width, height: image.height })

      // Convert blob to data URL for session storage
      const reader = new FileReader()
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string
        const newSites = drawImg(image, true, numSites, inversePP, seed, undefined, pixelRenderingRef.current)
        setImageState({ imageDataUrl: dataUrl, sites: newSites })
        pushHistory({ imageDataUrl: dataUrl, sites: newSites, seed, numSites, inversePP })
        URL.revokeObjectURL(url)
      }
      reader.readAsDataURL(blob)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
    }
  }, [drawImg, numSites, inversePP, seed, setImageState, pushHistory])


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

  // SVG icons
  const PlayIcon = () => (
    <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
  )
  const PauseIcon = () => (
    <svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
  )
  const DownloadIcon = () => (
    <svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg>
  )
  const UploadIcon = () => (
    <svg viewBox="0 0 24 24"><path d="M5 4h14v2H5V4zm0 10h4v6h6v-6h4l-7-7-7 7z"/></svg>
  )
  const StepBackIcon = () => (
    <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
  )
  const StepForwardIcon = () => (
    <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
  )

  // Format sites display: show "current→target" when growing, otherwise just the number
  const sitesDisplay = currentSiteCount !== targetSiteCount
    ? <><span className="sites-current">{currentSiteCount}</span><span className="sites-arrow">→</span><span className="sites-target">{targetSiteCount}</span></>
    : <span>{numSites}</span>

  return (
    <>
      <ImageGallery
        onSelectImage={handleSelectFromGallery}
        currentImageId={currentImageId}
      />
      <div
        className={`IV${isDragging ? ' dragging' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="canvas-container">
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

      <div className="controls-wrapper">
        {/* Image metadata */}
        {imageDimensions && (
          <div className="control-group image-info">
            <span className="image-meta">
              {imageFilename && <span className="image-filename">{imageFilename}</span>}
              <span className="image-dims">{imageDimensions.width}×{imageDimensions.height}</span>
              <span className="image-pixels">{(imageDimensions.width * imageDimensions.height / 1e6).toFixed(2)}MP</span>
            </span>
            {originalDimensions && originalDimensions.width > 400 && (
              <Tooltip title="Downscale image for better performance" arrow>
                <select
                  className="scale-select"
                  value={imageScale}
                  onChange={(e) => applyImageScale(parseFloat(e.target.value))}
                >
                  {getScaleOptions(originalDimensions.width, originalDimensions.height).map(opt => (
                    <option key={opt.scale} value={opt.scale}>
                      {opt.label} ({opt.dims})
                    </option>
                  ))}
                </select>
              </Tooltip>
            )}
          </div>
        )}

        {/* Playback controls */}
        <div className="control-group">
          <Tooltip title="Step backward (<)" arrow>
            <button className="icon-button" onClick={stepBackward}>
              <StepBackIcon />
            </button>
          </Tooltip>
          <Tooltip title={isPlaying ? 'Pause (Space)' : 'Play (Space)'} arrow>
            <button className="icon-button" onClick={togglePlay}>
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>
          </Tooltip>
          <Tooltip title="Step forward (>)" arrow>
            <button className="icon-button" onClick={stepForward}>
              <StepForwardIcon />
            </button>
          </Tooltip>
          {isPlaying && <span className="fps-display">{fps} fps</span>}
        </div>

        {/* Sites slider */}
        <Tooltip title="Number of Voronoi sites" arrow>
          <div className="control-group slider-group">
            <label className="control-label">Sites</label>
            <input
              className="control-slider"
              type="range"
              value={numSites}
              min={SITES_MIN}
              max={SITES_MAX}
              step="25"
              onChange={handleNumSitesChange}
            />
            <span className="control-number sites-display">{sitesDisplay}</span>
          </div>
        </Tooltip>

        {/* Speed slider */}
        <Tooltip title="Animation speed (pixels/sec)" arrow>
          <div className="control-group slider-group">
            <label className="control-label">Speed</label>
            <input
              className="control-slider"
              type="range"
              value={speed}
              min="1"
              max="60"
              step="1"
              onChange={(e) => setValues({ v: parseInt(e.target.value, 10) })}
            />
            <span className="control-number">{speed}</span>
          </div>
        </Tooltip>

        {/* 2× Time slider */}
        <Tooltip title="Doubling time for gradual site changes (0 = instant)" arrow>
          <div className="control-group slider-group">
            <label className="control-label">2× Time</label>
            <input
              className="control-slider"
              type="range"
              value={doublingTime}
              min="0"
              max="10"
              step="0.5"
              onChange={(e) => setValues({ d: parseFloat(e.target.value) })}
            />
            <span className="control-number">{doublingTime > 0 ? `${doublingTime}s` : 'off'}</span>
          </div>
        </Tooltip>

        {/* Seed input */}
        <Tooltip title="Random seed for site placement (F to focus)" arrow>
          <div className="control-group">
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
        </Tooltip>

        {/* Checkboxes */}
        <Tooltip title="Bias initial site placement toward edges" arrow>
          <label className="selection-label">
            <input
              className="checkbox"
              type="checkbox"
              checked={inversePP}
              onChange={handleInversePPChange}
            />
            {' '}Edge bias
          </label>
        </Tooltip>

        <Tooltip title={webglSupported ? 'WebGL acceleration (G)' : 'WebGL not supported'} arrow>
          <label
            className="selection-label"
            style={webglSupported ? undefined : { opacity: 0.5, cursor: 'not-allowed' }}
          >
            <input
              className="checkbox"
              type="checkbox"
              checked={useWebGL && webglSupported}
              onChange={toggleWebGL}
              disabled={!webglSupported}
            />
            {' '}WebGL
          </label>
        </Tooltip>

        <Tooltip title="Show site markers and velocity vectors" arrow>
          <label className="selection-label">
            <input
              className="checkbox"
              type="checkbox"
              checked={showSites}
              onChange={() => setShowSites(!showSites)}
            />
            {' '}Sites
          </label>
        </Tooltip>

        {/* Upload and Download */}
        <div className="control-group">
          <Tooltip title="Upload image" arrow>
            <label className="icon-button">
              <UploadIcon />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="file-input"
              />
            </label>
          </Tooltip>
          <Tooltip title="Download image (S)" arrow>
            <button className="icon-button" onClick={handleDownload}>
              <DownloadIcon />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
    </>
  )
}
