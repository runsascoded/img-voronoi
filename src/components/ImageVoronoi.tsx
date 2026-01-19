import { useRef, useEffect, useCallback, ChangeEvent } from 'react'
import useSessionStorageState from 'use-session-storage-state'
import { saveAs } from 'file-saver'
import { VoronoiDrawer, Position } from '../voronoi/VoronoiDrawer'
import sampleImage from '../assets/sample.jpg'
import './ImageVoronoi.css'

interface DiagramState {
  imageDataUrl: string | null
  sites: Position[]
  numSites: number
  ifRGB: boolean
  inversePP: boolean
  dosage: number
}

const DEFAULT_STATE: DiagramState = {
  imageDataUrl: null,
  sites: [],
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

  const { imageDataUrl, sites, numSites, ifRGB, inversePP, dosage } = state

  const drawVoronoi = useCallback((
    drawer: VoronoiDrawer,
    isRGB: boolean,
    dosageVal: number,
    existingSites?: Position[],
  ): Position[] => {
    if (isRGB) {
      // RGB mode generates new random sites for each channel - can't reuse sites
      drawer.rgbVoronoi(dosageVal)
    } else {
      drawer.fillVoronoi(0, true, undefined, true, 0, existingSites)
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

    return drawVoronoi(voronoiRef.current, isRGB, dosageVal, existingSites)
  }, [drawVoronoi])

  // Load image and render on mount or when state changes
  useEffect(() => {
    const loadAndDraw = (src: string, existingSites?: Position[]) => {
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
          existingSites,
        )
        // Only update sites if we generated new ones
        if (!existingSites || existingSites.length === 0) {
          setState(prev => ({ ...prev, sites: newSites }))
        }
      }
    }

    if (imageDataUrl) {
      // Restore from session storage
      loadAndDraw(imageDataUrl, sites.length > 0 ? sites : undefined)
    } else {
      // Load sample image on first visit
      loadAndDraw(sampleImage)
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
        const newSites = drawImg(image, true, numSites, ifRGB, inversePP, dosage)
        setState(prev => ({
          ...prev,
          imageDataUrl: dataUrl,
          sites: newSites,
        }))
      }
    }
    reader.readAsDataURL(files[0])
  }

  const handleNumSitesChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newNumSites = parseInt(e.target.value, 10)

    if (imgRef.current && voronoiRef.current) {
      voronoiRef.current.numSites = newNumSites
      const newSites = drawImg(imgRef.current, false, newNumSites, ifRGB, inversePP, dosage)
      setState(prev => ({ ...prev, numSites: newNumSites, sites: newSites }))
    }
  }

  const handleRGBChange = () => {
    const newIfRGB = !ifRGB

    if (imgRef.current) {
      const newSites = drawImg(imgRef.current, false, numSites, newIfRGB, inversePP, dosage, sites)
      setState(prev => ({ ...prev, ifRGB: newIfRGB, sites: newSites }))
    }
  }

  const handleInversePPChange = () => {
    const newInversePP = !inversePP

    if (imgRef.current) {
      // Changing inversePP requires regenerating sites
      const newSites = drawImg(imgRef.current, true, numSites, ifRGB, newInversePP, dosage)
      setState(prev => ({ ...prev, inversePP: newInversePP, sites: newSites }))
    }
  }

  const handleDosageChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newDosage = parseInt(e.target.value, 10)

    if (ifRGB && imgRef.current) {
      drawImg(imgRef.current, false, numSites, ifRGB, inversePP, newDosage, sites)
    }
    setState(prev => ({ ...prev, dosage: newDosage }))
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
