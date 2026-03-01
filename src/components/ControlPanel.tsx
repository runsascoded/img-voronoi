import { ChangeEvent, ReactNode, Ref, SyntheticEvent, useCallback, useState } from 'react'
import Tooltip from '@mui/material/Tooltip'
import './ControlPanel.css'

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

function useSectionOpen(key: string, defaultOpen: boolean): [boolean, (e: SyntheticEvent<HTMLDetailsElement>) => void] {
  const storageKey = `voronoi-panel-${key}`
  const [isOpen, setIsOpen] = useState(() => {
    const stored = localStorage.getItem(storageKey)
    if (stored !== null) return stored === '1'
    return defaultOpen
  })
  const onToggle = useCallback((e: SyntheticEvent<HTMLDetailsElement>) => {
    const open = (e.currentTarget as HTMLDetailsElement).open
    setIsOpen(open)
    localStorage.setItem(storageKey, open ? '1' : '0')
  }, [storageKey])
  return [isOpen, onToggle]
}

interface ScaleOption {
  scale: number
  label: string
  dims: string
}

interface DisplayScaleOption {
  label: string
  value: 'auto' | number
}

export interface ControlPanelProps {
  // Collapse
  collapsed: boolean
  onToggleCollapse: () => void
  // Animation
  isPlaying: boolean
  fps: number
  speed: number
  doublingTime: number
  onTogglePlay: () => void
  onStepBackward: () => void
  onStepForward: () => void
  onSpeedChange: (speed: number) => void
  onDoublingTimeChange: (dt: number) => void
  // Sites
  numSites: number
  seed: number
  inversePP: boolean
  currentSiteCount: number
  targetSiteCount: number
  onNumSitesChange: (e: ChangeEvent<HTMLInputElement>) => void
  onSeedChange: (e: ChangeEvent<HTMLInputElement>) => void
  onInversePPChange: () => void
  seedInputRef: Ref<HTMLInputElement>
  // Physics (WASM)
  useWasm: boolean
  wasmReady: boolean
  centroidPull: number
  theta: number
  sigma: number
  onCentroidPullChange: (v: number) => void
  onThetaChange: (v: number) => void
  onSigmaChange: (v: number) => void
  // Display
  showRegions: boolean
  showEdges: boolean
  showSites: boolean
  showVectors: boolean
  onToggleRegions: () => void
  onToggleEdges: () => void
  onToggleSites: () => void
  onToggleVectors: () => void
  // Image
  imageDimensions: { width: number; height: number } | null
  imageFilename: string | null
  imageScale: number
  displayScale: 'auto' | number
  scaleOptions: ScaleOption[]
  displayScaleOptions: DisplayScaleOption[]
  filenameInputRef: Ref<HTMLInputElement>
  onFilenameChange: (name: string) => void
  onFilenameBlur: (name: string) => void
  onApplyImageScale: (scale: number) => void
  onDisplayScaleChange: (val: 'auto' | number) => void
  // Engine
  useWebGL: boolean
  webglSupported: boolean
  onToggleWebGL: () => void
  onToggleWasm: () => void
  // I/O
  downloadFormat: 'png' | 'jpeg'
  fileInputRef: Ref<HTMLInputElement>
  onDownloadFormatChange: (fmt: 'png' | 'jpeg') => void
  onFileChange: (e: ChangeEvent<HTMLInputElement>) => void
  onDownload: () => void
}

export function ControlPanel(props: ControlPanelProps) {
  const {
    collapsed, onToggleCollapse,
    isPlaying, fps, speed, doublingTime,
    onTogglePlay, onStepBackward, onStepForward, onSpeedChange, onDoublingTimeChange,
    numSites, seed, inversePP, currentSiteCount, targetSiteCount,
    onNumSitesChange, onSeedChange, onInversePPChange, seedInputRef,
    useWasm, wasmReady, centroidPull, theta, sigma,
    onCentroidPullChange, onThetaChange, onSigmaChange,
    showRegions, showEdges, showSites, showVectors,
    onToggleRegions, onToggleEdges, onToggleSites, onToggleVectors,
    imageDimensions, imageFilename, imageScale, displayScale,
    scaleOptions, displayScaleOptions, filenameInputRef,
    onFilenameChange, onFilenameBlur, onApplyImageScale, onDisplayScaleChange,
    useWebGL, webglSupported, onToggleWebGL, onToggleWasm,
    downloadFormat, fileInputRef, onDownloadFormatChange, onFileChange, onDownload,
  } = props

  const [animOpen, onAnimToggle] = useSectionOpen('animation', true)
  const [sitesOpen, onSitesToggle] = useSectionOpen('sites', true)
  const [physicsOpen, onPhysicsToggle] = useSectionOpen('physics', true)
  const [displayOpen, onDisplayToggle] = useSectionOpen('display', true)
  const [imageOpen, onImageToggle] = useSectionOpen('image', false)
  const [engineOpen, onEngineToggle] = useSectionOpen('engine', false)
  const [ioOpen, onIoToggle] = useSectionOpen('io', true)

  const sitesDisplay: ReactNode = currentSiteCount !== targetSiteCount
    ? <><span className="sites-current">{currentSiteCount}</span><span className="sites-arrow">{'\u2192'}</span><span className="sites-target">{targetSiteCount}</span></>
    : <span>{numSites}</span>

  const showPhysics = useWasm && wasmReady

  return (
    <div className={`control-panel${collapsed ? ' cp-collapsed' : ''}`}>
      <div className="cp-header">
        {!collapsed && <span className="cp-title">Controls</span>}
        <Tooltip title="Toggle controls (C)" arrow>
          <button className="cp-toggle" onClick={onToggleCollapse}>
            {collapsed ? '\u2039' : '\u203A'}
          </button>
        </Tooltip>
      </div>
      <div className="cp-sections">
        {/* Animation */}
        <details className="cp-section" open={animOpen} onToggle={onAnimToggle}>
          <summary>Animation</summary>
          <div className="cp-body">
            <div className="cp-playback">
              <Tooltip title="Step backward (<)" arrow>
                <button className="icon-button" onClick={onStepBackward}>
                  <StepBackIcon />
                </button>
              </Tooltip>
              <Tooltip title={isPlaying ? 'Pause (Space)' : 'Play (Space)'} arrow>
                <button className="icon-button" onClick={onTogglePlay}>
                  {isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>
              </Tooltip>
              <Tooltip title="Step forward (>)" arrow>
                <button className="icon-button" onClick={onStepForward}>
                  <StepForwardIcon />
                </button>
              </Tooltip>
              {isPlaying && <span className="fps-display">{fps} fps</span>}
            </div>
            <Tooltip title="Animation speed (pixels/sec)" arrow>
              <div className="slider-group">
                <label className="control-label">Speed</label>
                <input
                  className="control-slider"
                  type="range"
                  value={speed}
                  min="1"
                  max="60"
                  step="1"
                  onChange={(e) => onSpeedChange(parseInt(e.target.value, 10))}
                />
                <span className="control-number">{speed}</span>
              </div>
            </Tooltip>
            <Tooltip title="Doubling time for gradual site changes (0 = instant)" arrow>
              <div className="slider-group">
                <label className="control-label">2{'\u00d7'} Time</label>
                <input
                  className="control-slider"
                  type="range"
                  value={doublingTime}
                  min="0"
                  max="10"
                  step="0.5"
                  onChange={(e) => onDoublingTimeChange(parseFloat(e.target.value))}
                />
                <span className="control-number">{doublingTime > 0 ? `${doublingTime}s` : 'off'}</span>
              </div>
            </Tooltip>
          </div>
        </details>

        {/* Sites */}
        <details className="cp-section" open={sitesOpen} onToggle={onSitesToggle}>
          <summary>Sites</summary>
          <div className="cp-body">
            <Tooltip title="Number of Voronoi sites" arrow>
              <div className="slider-group">
                <label className="control-label">Count</label>
                <input
                  className="control-slider"
                  type="range"
                  value={numSites}
                  min="25"
                  max="20000"
                  step="25"
                  onChange={onNumSitesChange}
                />
                <span className="control-number sites-display">{sitesDisplay}</span>
              </div>
            </Tooltip>
            <Tooltip title="Random seed for site placement (F to focus)" arrow>
              <div className="control-group">
                <label className="control-label">Seed</label>
                <input
                  ref={seedInputRef}
                  className="seed-input"
                  type="number"
                  min="0"
                  value={seed}
                  onChange={onSeedChange}
                />
              </div>
            </Tooltip>
            <Tooltip title="Bias initial site placement toward edges" arrow>
              <label className="selection-label">
                <input
                  className="checkbox"
                  type="checkbox"
                  checked={inversePP}
                  onChange={onInversePPChange}
                />
                {' '}Edge bias
              </label>
            </Tooltip>
          </div>
        </details>

        {/* Physics (WASM only) */}
        {showPhysics && (
          <details className="cp-section" open={physicsOpen} onToggle={onPhysicsToggle}>
            <summary>Physics</summary>
            <div className="cp-body">
              <Tooltip title="Centroid pull — Lloyd's relaxation strength (0 = off)" arrow>
                <div className="slider-group">
                  <label className="control-label">Pull</label>
                  <input
                    className="control-slider"
                    type="range"
                    value={centroidPull}
                    min="0"
                    max="20"
                    step="0.5"
                    onChange={(e) => onCentroidPullChange(parseFloat(e.target.value))}
                  />
                  <span className="control-number">{centroidPull > 0 ? centroidPull : 'off'}</span>
                </div>
              </Tooltip>
              <Tooltip title="Mean reversion — higher = straighter paths (O-U \u03B8)" arrow>
                <div className="slider-group">
                  <label className="control-label">Drift</label>
                  <input
                    className="control-slider"
                    type="range"
                    value={theta}
                    min="0"
                    max="10"
                    step="0.5"
                    onChange={(e) => onThetaChange(parseFloat(e.target.value))}
                  />
                  <span className="control-number">{theta > 0 ? theta : 'off'}</span>
                </div>
              </Tooltip>
              <Tooltip title="Random steering — higher = more erratic turns (O-U \u03C3)" arrow>
                <div className="slider-group">
                  <label className="control-label">Wander</label>
                  <input
                    className="control-slider"
                    type="range"
                    value={sigma}
                    min="0"
                    max="10"
                    step="0.5"
                    onChange={(e) => onSigmaChange(parseFloat(e.target.value))}
                  />
                  <span className="control-number">{sigma > 0 ? sigma : 'off'}</span>
                </div>
              </Tooltip>
            </div>
          </details>
        )}

        {/* Display */}
        <details className="cp-section" open={displayOpen} onToggle={onDisplayToggle}>
          <summary>Display</summary>
          <div className="cp-body">
            <div className="cp-checks">
              <Tooltip title="Show Voronoi cell colors (R)" arrow>
                <label className="selection-label">
                  <input className="checkbox" type="checkbox" checked={showRegions} onChange={onToggleRegions} />
                  Regions
                </label>
              </Tooltip>
              <Tooltip title="Overlay cell boundary lines (E)" arrow>
                <label className="selection-label">
                  <input className="checkbox" type="checkbox" checked={showEdges} onChange={onToggleEdges} />
                  Edges
                </label>
              </Tooltip>
              <Tooltip title="Show site markers (P)" arrow>
                <label className="selection-label">
                  <input className="checkbox" type="checkbox" checked={showSites} onChange={onToggleSites} />
                  Sites
                </label>
              </Tooltip>
              <Tooltip title="Show velocity vectors (V)" arrow>
                <label className="selection-label">
                  <input className="checkbox" type="checkbox" checked={showVectors} onChange={onToggleVectors} />
                  Vectors
                </label>
              </Tooltip>
            </div>
          </div>
        </details>

        {/* Image */}
        <details className="cp-section" open={imageOpen} onToggle={onImageToggle}>
          <summary>Image</summary>
          <div className="cp-body">
            {imageDimensions && (
              <>
                <span className="image-meta">
                  <input
                    ref={filenameInputRef}
                    className="image-filename-input"
                    type="text"
                    value={imageFilename ?? 'voronoi'}
                    onChange={(e) => onFilenameChange(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    onBlur={(e) => onFilenameBlur(e.target.value.trim())}
                    title="Image name (used for downloads)"
                  />
                  <span className="image-dims">{imageDimensions.width}{'\u00d7'}{imageDimensions.height}</span>
                  <span className="image-pixels">{(imageDimensions.width * imageDimensions.height / 1e6).toFixed(2)}MP</span>
                </span>
                {scaleOptions.length > 1 && (
                  <Tooltip title="Compute scale (Shift+\u2191/\u2193, #w, #h)" arrow>
                    <select
                      className="scale-select"
                      value={imageScale}
                      onChange={(e) => { onApplyImageScale(parseFloat(e.target.value)); e.target.blur() }}
                    >
                      {scaleOptions.map(opt => (
                        <option key={opt.scale} value={opt.scale}>
                          {opt.label} ({opt.dims})
                        </option>
                      ))}
                      {!scaleOptions.some(o => Math.abs(o.scale - imageScale) < 0.001) && (
                        <option value={imageScale}>
                          {Math.round(imageScale * 100)}% ({imageDimensions.width}{'\u00d7'}{imageDimensions.height})
                        </option>
                      )}
                    </select>
                  </Tooltip>
                )}
                {displayScaleOptions.length > 1 && (
                  <Tooltip title="Display scale (Alt+Shift+\u2191/\u2193)" arrow>
                    <select
                      className="scale-select"
                      value={String(displayScale)}
                      onChange={(e) => {
                        const val = e.target.value === 'auto' ? 'auto' as const : parseFloat(e.target.value)
                        onDisplayScaleChange(val)
                        e.target.blur()
                      }}
                    >
                      {displayScaleOptions.map(opt => (
                        <option key={String(opt.value)} value={String(opt.value)}>{opt.label}</option>
                      ))}
                    </select>
                  </Tooltip>
                )}
              </>
            )}
          </div>
        </details>

        {/* Engine */}
        <details className="cp-section" open={engineOpen} onToggle={onEngineToggle}>
          <summary>Engine</summary>
          <div className="cp-body">
            <div className="cp-checks">
              <Tooltip title={webglSupported ? 'WebGL acceleration (G)' : 'WebGL not supported'} arrow>
                <label
                  className="selection-label"
                  style={webglSupported ? undefined : { opacity: 0.5, cursor: 'not-allowed' }}
                >
                  <input
                    className="checkbox"
                    type="checkbox"
                    checked={useWebGL && webglSupported}
                    onChange={onToggleWebGL}
                    disabled={!webglSupported}
                  />
                  WebGL
                </label>
              </Tooltip>
              <Tooltip title={wasmReady ? 'WASM backend — Rust compute + O-U physics (W)' : 'WASM loading...'} arrow>
                <label
                  className="selection-label"
                  style={wasmReady ? undefined : { opacity: 0.5, cursor: 'not-allowed' }}
                >
                  <input
                    className="checkbox"
                    type="checkbox"
                    checked={useWasm && wasmReady}
                    onChange={onToggleWasm}
                    disabled={!wasmReady}
                  />
                  WASM
                </label>
              </Tooltip>
            </div>
          </div>
        </details>

        {/* I/O */}
        <details className="cp-section" open={ioOpen} onToggle={onIoToggle}>
          <summary>I/O</summary>
          <div className="cp-body">
            <div className="cp-io-row">
              <Tooltip title="Upload image" arrow>
                <label className="icon-button">
                  <UploadIcon />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={onFileChange}
                    className="file-input"
                  />
                </label>
              </Tooltip>
              <Tooltip title="Download format" arrow>
                <select
                  className="format-select"
                  value={downloadFormat}
                  onChange={(e) => { onDownloadFormatChange(e.target.value as 'png' | 'jpeg'); e.target.blur() }}
                >
                  <option value="png">PNG</option>
                  <option value="jpeg">JPG</option>
                </select>
              </Tooltip>
              <Tooltip title="Download image (S)" arrow>
                <button className="icon-button" onClick={onDownload}>
                  <DownloadIcon />
                </button>
              </Tooltip>
            </div>
          </div>
        </details>
      </div>
    </div>
  )
}
