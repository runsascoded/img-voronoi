import { useRef, useEffect, useCallback, ChangeEvent } from 'react'
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

const DEFAULT_IMAGE_STATE: ImageState = {
  imageDataUrl: null,
  sites: [],
}

const SITES_STEP = 50
const SITES_MIN = 50
const SITES_MAX = 4000
const PHI = 1.618033988749895  // Golden ratio

export function ImageVoronoi() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const voronoiRef = useRef<VoronoiDrawer | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const seedInputRef = useRef<HTMLInputElement>(null)

  // URL params for shareable settings
  const { values, setValues } = useUrlParams({
    s: intParam(0),        // seed (default 0, omitted from URL)
    n: intParam(400),      // numSites
    h: boolParam,          // ifRGB (Get High)
    i: boolParam,          // inversePP
    d: intParam(0),        // dosage
  })

  const seed = values.s
  const numSites = values.n
  const ifRGB = values.h
  const inversePP = values.i
  const dosage = values.d

  // Session storage for large data (image + sites)
  const [imageState, setImageState] = useSessionStorageState<ImageState>('voronoi-image', {
    defaultValue: DEFAULT_IMAGE_STATE,
  })
  const { imageDataUrl, sites } = imageState

  const drawVoronoi = useCallback((
    drawer: VoronoiDrawer,
    isRGB: boolean,
    dosageVal: number,
    seedVal: number,
    existingSites?: Position[],
  ): Position[] => {
    if (isRGB) {
      drawer.rgbVoronoi(dosageVal, seedVal)
    } else {
      drawer.fillVoronoi(0, true, undefined, true, 0, existingSites, seedVal)
    }
    return drawer.getSites()
  }, [])

  const drawImg = useCallback((
    image: HTMLImageElement,
    fileChanged: boolean,
    sitesCount: number,
    isRGB: boolean,
    inversePPVal: boolean,
    dosageVal: number,
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

    return drawVoronoi(voronoiRef.current, isRGB, dosageVal, seedVal, existingSites)
  }, [drawVoronoi])

  // Load image and render on mount
  useEffect(() => {
    const loadAndDraw = (src: string, seedVal: number, existingSites?: Position[]) => {
      const image = new Image()
      image.src = src
      image.onload = () => {
        imgRef.current = image
        const newSites = drawImg(
          image,
          true,
          numSites,
          ifRGB,
          inversePP,
          dosage,
          seedVal,
          existingSites,
        )
        if (!ifRGB && (!existingSites || existingSites.length === 0)) {
          setImageState(prev => ({ ...prev, sites: newSites }))
        }
      }
    }

    if (imageDataUrl) {
      loadAndDraw(imageDataUrl, seed, !ifRGB && sites.length > 0 ? sites : undefined)
    } else {
      loadAndDraw(sampleImage, seed)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string
      const image = new Image()
      image.src = dataUrl
      image.onload = () => {
        imgRef.current = image
        const newSites = drawImg(image, true, numSites, ifRGB, inversePP, dosage, seed)
        setImageState({ imageDataUrl: dataUrl, sites: ifRGB ? [] : newSites })
      }
    }
    reader.readAsDataURL(files[0])
  }

  const handleNumSitesChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newNumSites = parseInt(e.target.value, 10)
    updateNumSites(newNumSites)
  }

  const updateNumSites = (newNumSites: number) => {
    if (imgRef.current && voronoiRef.current) {
      voronoiRef.current.numSites = newNumSites
      const newSites = drawImg(imgRef.current, false, newNumSites, ifRGB, inversePP, dosage, seed)
      setValues({ n: newNumSites })
      setImageState(prev => ({ ...prev, sites: ifRGB ? [] : newSites }))
    }
  }

  const handleRGBChange = () => {
    toggleRGB()
  }

  const toggleRGB = () => {
    const newIfRGB = !ifRGB
    if (imgRef.current) {
      const newSites = drawImg(imgRef.current, false, numSites, newIfRGB, inversePP, dosage, seed, newIfRGB ? undefined : sites)
      setValues({ h: newIfRGB })
      setImageState(prev => ({ ...prev, sites: newIfRGB ? [] : newSites }))
    }
  }

  const handleInversePPChange = () => {
    toggleInversePP()
  }

  const toggleInversePP = () => {
    const newInversePP = !inversePP
    if (imgRef.current) {
      const newSites = drawImg(imgRef.current, true, numSites, ifRGB, newInversePP, dosage, seed)
      setValues({ i: newInversePP })
      setImageState(prev => ({ ...prev, sites: ifRGB ? [] : newSites }))
    }
  }

  const handleDosageChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newDosage = parseInt(e.target.value, 10)
    if (ifRGB && imgRef.current) {
      drawImg(imgRef.current, false, numSites, ifRGB, inversePP, newDosage, seed)
    }
    setValues({ d: newDosage })
  }

  const handleSeedChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newSeed = parseInt(e.target.value, 10)
    if (isNaN(newSeed)) return
    updateSeed(newSeed)
  }

  const updateSeed = (newSeed: number) => {
    if (imgRef.current) {
      const newSites = drawImg(imgRef.current, false, numSites, ifRGB, inversePP, dosage, newSeed)
      setValues({ s: newSeed })
      setImageState(prev => ({ ...prev, sites: ifRGB ? [] : newSites }))
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
  useAction('voronoi:focus-seed', {
    label: 'Focus seed input',
    group: 'Voronoi',
    defaultBindings: ['f'],
    handler: focusSeedInput,
  })

  useAction('voronoi:toggle-rgb', {
    label: 'Toggle Get High (RGB)',
    group: 'Voronoi',
    defaultBindings: ['h'],
    handler: toggleRGB,
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
    <div className="IV">
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
              checked={ifRGB}
              onChange={handleRGBChange}
            />
            {' '}Get High
          </label>
        </div>

        <div className="control-wrapper">
          <label className="control-label">Drug dosage</label>
          <label className="control-input control-number number">{dosage}</label>
          <input
            className="control-input control-slider slider"
            type="range"
            value={dosage}
            min="0"
            max="100"
            onChange={handleDosageChange}
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
