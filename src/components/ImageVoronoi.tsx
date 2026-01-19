import { useRef, useEffect, useCallback, ChangeEvent, DragEvent, useState } from 'react'
import useSessionStorageState from 'use-session-storage-state'
import { useUrlParams, intParam, boolParam } from 'use-prms/hash'
import { useAction } from 'use-kbd'
import { saveAs } from 'file-saver'
import { VoronoiDrawer, Position } from '../voronoi/VoronoiDrawer'
import sampleImage from '../assets/sample.jpg'
import './ImageVoronoi.css'

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
const SITES_MAX = 4000
const PHI = 1.618033988749895  // Golden ratio

export function ImageVoronoi() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const voronoiRef = useRef<VoronoiDrawer | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const seedInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)

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

  const drawVoronoi = useCallback((
    drawer: VoronoiDrawer,
    seedVal: number,
    existingSites?: Position[],
  ): Position[] => {
    drawer.fillVoronoi(existingSites, seedVal)
    return drawer.getSites()
  }, [])

  const drawImg = useCallback((
    image: HTMLImageElement,
    fileChanged: boolean,
    sitesCount: number,
    inversePPVal: boolean,
    seedVal: number,
    existingSites?: Position[],
  ): Position[] => {
    const canvas = canvasRef.current
    if (!canvas) return []

    const ctx = canvas.getContext('2d')
    if (!ctx) return []

    canvas.height = image.height
    canvas.width = image.width
    ctx.drawImage(image, 0, 0)

    if (fileChanged || !voronoiRef.current) {
      voronoiRef.current = new VoronoiDrawer(canvas, sitesCount, inversePPVal)
    }

    return drawVoronoi(voronoiRef.current, seedVal, existingSites)
  }, [drawVoronoi])

  // Load image and render on mount
  useEffect(() => {
    const loadAndDraw = (src: string | null, seedVal: number, existingSites?: Position[]) => {
      const image = new Image()
      image.src = src || sampleImage
      image.onload = () => {
        imgRef.current = image
        const newSites = drawImg(image, true, numSites, inversePP, seedVal, existingSites)
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
        const newSites = drawImg(image, true, numSites, inversePP, seed)
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
      const newSites = drawImg(imgRef.current, false, newNumSites, inversePP, seed)
      setValues({ n: newNumSites })
      setImageState(prev => ({ ...prev, sites: newSites }))
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
      const newSites = drawImg(imgRef.current, true, numSites, newInversePP, seed)
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
      const newSites = drawImg(imgRef.current, false, numSites, inversePP, newSeed)
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

  useAction('voronoi:increase-sites', {
    label: 'Increase sites (+50)',
    group: 'Voronoi',
    defaultBindings: [']', '='],
    handler: () => updateNumSites(Math.min(SITES_MAX, numSites + SITES_STEP)),
  })

  useAction('voronoi:decrease-sites', {
    label: 'Decrease sites (-50)',
    group: 'Voronoi',
    defaultBindings: ['[', '-'],
    handler: () => updateNumSites(Math.max(SITES_MIN, numSites - SITES_STEP)),
  })

  useAction('voronoi:double-sites', {
    label: 'Double sites (×2)',
    group: 'Voronoi',
    defaultBindings: ['}'],
    handler: () => updateNumSites(Math.min(SITES_MAX, numSites * 2)),
  })

  useAction('voronoi:halve-sites', {
    label: 'Halve sites (÷2)',
    group: 'Voronoi',
    defaultBindings: ['{'],
    handler: () => updateNumSites(Math.max(SITES_MIN, Math.round(numSites / 2))),
  })

  useAction('voronoi:golden-up', {
    label: 'Scale sites up (×φ)',
    group: 'Voronoi',
    defaultBindings: [')'],
    handler: () => updateNumSites(Math.min(SITES_MAX, Math.floor(numSites * PHI))),
  })

  useAction('voronoi:golden-down', {
    label: 'Scale sites down (÷φ)',
    group: 'Voronoi',
    defaultBindings: ['('],
    handler: () => updateNumSites(Math.max(SITES_MIN, Math.ceil(numSites / PHI))),
  })

  useAction('voronoi:download', {
    label: 'Download image',
    group: 'Voronoi',
    defaultBindings: ['s', 'meta+s'],
    handler: downloadImage,
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
            max="4000"
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
      </div>

      <div className="canvas-wrapper">
        <canvas className="canvas" ref={canvasRef} />
      </div>
    </div>
  )
}
