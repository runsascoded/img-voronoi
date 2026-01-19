import { useRef, useEffect, useCallback, ChangeEvent } from 'react'
import useSessionStorageState from 'use-session-storage-state'
import { saveAs } from 'file-saver'
import { VoronoiDrawer, Position } from '../voronoi/VoronoiDrawer'
import { randomSeed } from '../utils/random'
import sampleImage from '../assets/sample.jpg'
import './ImageVoronoi.css'

interface DiagramState {
  imageDataUrl: string | null
  sites: Position[]
  seed: number
  numSites: number
  ifRGB: boolean
  inversePP: boolean
  dosage: number
}

const DEFAULT_STATE: DiagramState = {
  imageDataUrl: null,
  sites: [],
  seed: randomSeed(),
  numSites: 400,
  ifRGB: false,
  inversePP: false,
  dosage: 0,
}

export function ImageVoronoi() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const voronoiRef = useRef<VoronoiDrawer | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  const [state, setState] = useSessionStorageState<DiagramState>('voronoi-state', {
    defaultValue: DEFAULT_STATE,
  })

  const { imageDataUrl, sites, seed, numSites, ifRGB, inversePP, dosage } = state

  const drawVoronoi = useCallback((
    drawer: VoronoiDrawer,
    isRGB: boolean,
    dosageVal: number,
    seedVal: number,
    existingSites?: Position[],
  ): Position[] => {
    if (isRGB) {
      // RGB mode uses seed to derive per-channel seeds
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

  // Load image and render on mount or when state changes
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
        // Only update sites if we generated new ones (non-RGB mode without existing sites)
        if (!ifRGB && (!existingSites || existingSites.length === 0)) {
          setState(prev => ({ ...prev, sites: newSites }))
        }
      }
    }

    if (imageDataUrl) {
      // Restore from session storage
      loadAndDraw(imageDataUrl, seed, !ifRGB && sites.length > 0 ? sites : undefined)
    } else {
      // Load sample image on first visit
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
        const newSeed = randomSeed()
        const newSites = drawImg(image, true, numSites, ifRGB, inversePP, dosage, newSeed)
        setState(prev => ({
          ...prev,
          imageDataUrl: dataUrl,
          seed: newSeed,
          sites: ifRGB ? [] : newSites,
        }))
      }
    }
    reader.readAsDataURL(files[0])
  }

  const handleNumSitesChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newNumSites = parseInt(e.target.value, 10)

    if (imgRef.current && voronoiRef.current) {
      voronoiRef.current.numSites = newNumSites
      const newSites = drawImg(imgRef.current, false, newNumSites, ifRGB, inversePP, dosage, seed)
      setState(prev => ({ ...prev, numSites: newNumSites, sites: ifRGB ? [] : newSites }))
    }
  }

  const handleRGBChange = () => {
    const newIfRGB = !ifRGB

    if (imgRef.current) {
      const newSites = drawImg(imgRef.current, false, numSites, newIfRGB, inversePP, dosage, seed, newIfRGB ? undefined : sites)
      setState(prev => ({ ...prev, ifRGB: newIfRGB, sites: newIfRGB ? [] : newSites }))
    }
  }

  const handleInversePPChange = () => {
    const newInversePP = !inversePP

    if (imgRef.current) {
      // Changing inversePP requires regenerating sites
      const newSites = drawImg(imgRef.current, true, numSites, ifRGB, newInversePP, dosage, seed)
      setState(prev => ({ ...prev, inversePP: newInversePP, sites: ifRGB ? [] : newSites }))
    }
  }

  const handleDosageChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newDosage = parseInt(e.target.value, 10)

    if (ifRGB && imgRef.current) {
      drawImg(imgRef.current, false, numSites, ifRGB, inversePP, newDosage, seed)
    }
    setState(prev => ({ ...prev, dosage: newDosage }))
  }

  const handleSeedChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newSeed = parseInt(e.target.value, 10)
    if (isNaN(newSeed)) return

    if (imgRef.current) {
      const newSites = drawImg(imgRef.current, false, numSites, ifRGB, inversePP, dosage, newSeed)
      setState(prev => ({ ...prev, seed: newSeed, sites: ifRGB ? [] : newSites }))
    }
  }

  const handleRandomizeSeed = () => {
    const newSeed = randomSeed()
    if (imgRef.current) {
      const newSites = drawImg(imgRef.current, false, numSites, ifRGB, inversePP, dosage, newSeed)
      setState(prev => ({ ...prev, seed: newSeed, sites: ifRGB ? [] : newSites }))
    }
  }

  const handleDownload = () => {
    const canvas = canvasRef.current
    if (!canvas) return

    canvas.toBlob((blob) => {
      if (blob) {
        saveAs(blob, 'voronoi.png')
      }
    })
  }

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
            className="seed-input"
            type="number"
            value={seed}
            onChange={handleSeedChange}
          />
          <button className="seed-randomize" onClick={handleRandomizeSeed} title="Randomize">
            ↻
          </button>
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
