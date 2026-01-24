import { useEffect, useState, useRef, useCallback } from 'react'
import Tooltip from '@mui/material/Tooltip'
import {
  StoredImage,
  getStoredImages,
  getThumbnailBlob,
  getImageBlob,
  updateImageBasename,
  deleteImage,
  isOPFSSupported,
} from '../storage/ImageStorage'
import './ImageGallery.css'

interface ImageGalleryProps {
  onSelectImage: (blob: Blob, basename: string, id?: string) => void
  currentImageId?: string
}

interface ThumbnailCache {
  [id: string]: string
}

export function ImageGallery({ onSelectImage, currentImageId }: ImageGalleryProps) {
  const [images, setImages] = useState<StoredImage[]>([])
  const [thumbnails, setThumbnails] = useState<ThumbnailCache>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [isSupported] = useState(() => isOPFSSupported())
  const inputRef = useRef<HTMLInputElement>(null)

  // Load images on mount
  useEffect(() => {
    if (!isSupported) return

    getStoredImages().then(setImages)
  }, [isSupported])

  // Load thumbnails as images change
  useEffect(() => {
    if (!isSupported) return

    let cancelled = false

    const loadThumbnails = async () => {
      const newThumbnails: ThumbnailCache = { ...thumbnails }
      for (const img of images) {
        if (cancelled) return
        if (!newThumbnails[img.id]) {
          const blob = await getThumbnailBlob(img.id)
          if (blob && !cancelled) {
            newThumbnails[img.id] = URL.createObjectURL(blob)
          }
        }
      }
      if (!cancelled) {
        setThumbnails(newThumbnails)
      }
    }

    loadThumbnails()

    return () => {
      cancelled = true
    }
  }, [images, isSupported]) // eslint-disable-line react-hooks/exhaustive-deps

  // Focus input when editing
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  const handleSelect = useCallback(async (img: StoredImage) => {
    const blob = await getImageBlob(img.id)
    if (blob) {
      onSelectImage(blob, img.basename, img.id)
    }
  }, [onSelectImage])

  const handleStartEdit = useCallback((e: React.MouseEvent, img: StoredImage) => {
    e.stopPropagation()
    setEditingId(img.id)
    setEditValue(img.basename)
  }, [])

  const handleSaveEdit = useCallback(async () => {
    if (editingId && editValue.trim()) {
      await updateImageBasename(editingId, editValue.trim())
      setImages((prev) =>
        prev.map((img) =>
          img.id === editingId ? { ...img, basename: editValue.trim() } : img
        )
      )
    }
    setEditingId(null)
  }, [editingId, editValue])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveEdit()
    } else if (e.key === 'Escape') {
      setEditingId(null)
    }
  }, [handleSaveEdit])

  const handleDelete = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (confirm('Delete this image from gallery?')) {
      await deleteImage(id)
      setImages((prev) => prev.filter((img) => img.id !== id))
      // Revoke thumbnail URL
      if (thumbnails[id]) {
        URL.revokeObjectURL(thumbnails[id])
        setThumbnails((prev) => {
          const { [id]: _, ...rest } = prev
          return rest
        })
      }
    }
  }, [thumbnails])

  const refreshImages = useCallback(async () => {
    const imgs = await getStoredImages()
    setImages(imgs)
  }, [])

  if (!isSupported) {
    return null // OPFS not supported, don't show gallery
  }

  if (images.length === 0) {
    return null // No images stored yet
  }

  return (
    <div className="image-gallery">
      <div className="gallery-header">
        <span className="gallery-title">Gallery</span>
        <Tooltip title="Refresh gallery" placement="top" arrow>
          <button className="gallery-refresh" onClick={refreshImages}>
            ↻
          </button>
        </Tooltip>
      </div>
      <div className="gallery-items">
        {images.map((img) => (
          <div
            key={img.id}
            className={`gallery-item ${currentImageId === img.id ? 'active' : ''}`}
            onClick={() => handleSelect(img)}
          >
            <div className="gallery-thumbnail">
              {thumbnails[img.id] ? (
                <img src={thumbnails[img.id]} alt={img.basename} />
              ) : (
                <div className="thumbnail-placeholder">...</div>
              )}
              <Tooltip title="Delete" placement="top" arrow>
                <button
                  className="gallery-delete"
                  onClick={(e) => handleDelete(e, img.id)}
                >
                  ×
                </button>
              </Tooltip>
            </div>
            <div className="gallery-info">
              {editingId === img.id ? (
                <input
                  ref={inputRef}
                  className="gallery-edit-input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={handleSaveEdit}
                  onKeyDown={handleKeyDown}
                />
              ) : (
                <Tooltip title="Click to edit name" placement="bottom" arrow>
                  <span
                    className="gallery-basename"
                    onClick={(e) => handleStartEdit(e, img)}
                  >
                    {img.basename}
                  </span>
                </Tooltip>
              )}
              <span className="gallery-dims">
                {img.originalWidth}×{img.originalHeight}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Export a function to add image to gallery (for use in ImageVoronoi)
export { storeImage } from '../storage/ImageStorage'
