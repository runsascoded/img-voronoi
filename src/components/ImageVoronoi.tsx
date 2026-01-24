import { useRef, useEffect, useCallback, ChangeEvent, DragEvent, useState, MouseEvent } from 'react'
import useSessionStorageState from 'use-session-storage-state'
import { useUrlParams, intParam, boolParam } from 'use-prms/hash'
import { useAction } from 'use-kbd'
import { saveAs } from 'file-saver'
import { VoronoiDrawer, Position, DistanceMetric } from '../voronoi/VoronoiDrawer'
import sampleImage from '../assets/sample.jpg'
import './ImageVoronoi.css'

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

export function ImageVoronoi() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const voronoiRef = useRef<VoronoiDrawer | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const seedInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  // Animation state
  const [isPlaying, setIsPlaying] = useState(false)
  const [fps, setFps] = useState(0)
  const [usePixelRendering, setUsePixelRendering] = useState(true)
  const [useL1Metric, setUseL1Metric] = useState(false)
  const animationFrameRef = useRef<number | null>(null)
  const originalImgDataRef = useRef<ImageData | null>(null)
  const animatedSitesRef = useRef<Position[]>([])
  const velocitiesRef = useRef<Position[]>([])
  const frameCountRef = useRef(0)
  const fpsUpdateTimeRef = useRef(0)
  const animationHistoryRef = useRef<Position[][]>([])
  const historyPositionRef = useRef(0)  // Current position in history (for stepping back)

  // Hover state for revealing original image
  const [hoveredCell, setHoveredCell] = useState<number | null>(null)
  const cellOfRef = useRef<Int32Array | null>(null)
  const cellColorsRef = useRef<RGB[] | null>(null)

  // Refs to track settings for callbacks
  const metricRef = useRef<DistanceMetric>('L2')
  const pixelRenderingRef = useRef(true)

  // Undo/redo history
  const historyRef = useRef<HistoryEntry[]>([])
  const historyIndexRef = useRef(-1)
  const isRestoringRef = useRef(false)

  // URL params for shareable settings
  const { values, setValues } = useUrlParams({
    s: intParam(0),        // seed (default 0, omitted from URL)
    n: intParam(400),      // numSites
    i: boolParam,          // inversePP
  })

  const seed = values.s
  const numSites = values.n
  const inversePP = values.i

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

  const drawVoronoi = useCallback((
    drawer: VoronoiDrawer,
    seedVal: number,
    existingSites?: Position[],
    usePixels: boolean = true,
  ): Position[] => {
    if (usePixels) {
      // Pixel rendering - also provides cell membership data for hover
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
  }, [])

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
    velocitiesRef.current = currentSites.map(() => ({
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
    }))

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
      const result = drawer.fillVoronoiPixels(sites, undefined, metricRef.current)
      if (result) {
        cellOfRef.current = result.cellOf
        cellColorsRef.current = result.cellColors
      }
    } else {
      drawer.fillVoronoi(sites)
    }
  }, [])

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

    // Move sites
    for (let i = 0; i < animatedSites.length; i++) {
      animatedSites[i].x += velocities[i].x
      animatedSites[i].y += velocities[i].y

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
      const result = drawer.fillVoronoiPixels(animatedSites, undefined, metricRef.current)
      if (result) {
        cellOfRef.current = result.cellOf
        cellColorsRef.current = result.cellColors
      }
    } else {
      drawer.fillVoronoi(animatedSites)
    }

    // Update FPS
    frameCountRef.current++
    const now = performance.now()
    if (now - fpsUpdateTimeRef.current >= 1000) {
      setFps(Math.round(frameCountRef.current * 1000 / (now - fpsUpdateTimeRef.current)))
      frameCountRef.current = 0
      fpsUpdateTimeRef.current = now
    }
  }, [usePixelRendering, getMaxHistoryFrames])

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
    label: 'Scale sites up (×φ)',
    group: 'Sites',
    defaultBindings: [')'],
    handler: () => updateNumSites(Math.min(SITES_MAX, Math.floor(numSites * PHI))),
  })

  useAction('voronoi:golden-down', {
    label: 'Scale sites down (÷φ)',
    group: 'Sites',
    defaultBindings: ['('],
    handler: () => updateNumSites(Math.max(SITES_MIN, Math.ceil(numSites / PHI))),
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
      </div>
    </div>
  )
}
