import { useState, useCallback } from 'react'
import Tooltip from '@mui/material/Tooltip'
import { fetchPicsumList, picsumThumbUrl, picsumImageUrl, PicsumImage } from '../external/picsum'
import { storeImageFromUrl, getImageBlob } from '../storage/ImageStorage'
import './PicsumBrowser.css'

interface PicsumBrowserProps {
  onSelectImage: (blob: Blob, basename: string, id?: string) => void
  onGalleryRefresh: () => void
}

export function PicsumBrowser({ onSelectImage, onGalleryRefresh }: PicsumBrowserProps) {
  const [images, setImages] = useState<PicsumImage[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)

  const loadPage = useCallback(async (p: number) => {
    setLoading(true)
    setError(null)
    try {
      const results = await fetchPicsumList(p)
      setImages(prev => p === 1 ? results : [...prev, ...results])
      setPage(p)
      setHasLoaded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleToggle = useCallback(() => {
    setOpen(prev => {
      const next = !prev
      if (next && !hasLoaded) loadPage(1)
      return next
    })
  }, [hasLoaded, loadPage])

  const handleSelect = useCallback(async (img: PicsumImage) => {
    setLoadingId(img.id)
    try {
      const url = picsumImageUrl(img.id, img.width, img.height)
      const stored = await storeImageFromUrl(url, `picsum-${img.id}`)
      onGalleryRefresh()
      const blob = await getImageBlob(stored.id)
      if (blob) onSelectImage(blob, stored.basename, stored.id)
    } catch (e) {
      console.warn('[Picsum] Failed to load image:', e)
    } finally {
      setLoadingId(null)
    }
  }, [onSelectImage, onGalleryRefresh])

  const handleLoadMore = useCallback(() => {
    loadPage(page + 1)
  }, [page, loadPage])

  return (
    <div className="picsum-browser">
      <button className="picsum-toggle" onClick={handleToggle} type="button">
        <span className="picsum-arrow">{open ? '▾' : '▸'}</span>
        Browse photos
      </button>
      {open && (
        <div className="picsum-content">
          {error && <div className="picsum-error">{error}</div>}
          <div className="picsum-grid">
            {images.map(img => (
              <Tooltip key={img.id} title={`${img.author} (${img.width}×${img.height})`} placement="right" arrow>
                <button
                  className={`picsum-thumb${loadingId === img.id ? ' loading' : ''}`}
                  onClick={() => handleSelect(img)}
                  type="button"
                  disabled={loadingId !== null}
                >
                  <img
                    src={picsumThumbUrl(img.id, 100)}
                    alt={img.author}
                    loading="lazy"
                  />
                  {loadingId === img.id && <span className="picsum-spinner" />}
                </button>
              </Tooltip>
            ))}
          </div>
          {hasLoaded && !loading && (
            <button className="picsum-load-more" onClick={handleLoadMore} type="button">
              Load more
            </button>
          )}
          {loading && <div className="picsum-loading">Loading...</div>}
        </div>
      )}
    </div>
  )
}
