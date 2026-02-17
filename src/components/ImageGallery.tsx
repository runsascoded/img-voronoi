import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useAction, useActions } from 'use-kbd'
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

const COLLAPSED_KEY = 'voronoi-gallery-collapsed'

interface ImageGalleryProps {
  onSelectImage: (blob: Blob, basename: string, id?: string) => void
  currentImageId?: string
  galleryVersion?: number
}

interface ThumbnailCache {
  [id: string]: string
}

export function ImageGallery({ onSelectImage, currentImageId, galleryVersion }: ImageGalleryProps) {
  const [images, setImages] = useState<StoredImage[]>([])
  const [thumbnails, setThumbnails] = useState<ThumbnailCache>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [isSupported] = useState(() => isOPFSSupported())
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1')
  const inputRef = useRef<HTMLInputElement>(null)

  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
      return next
    })
  }, [])

  // Load images on mount and when currentImageId changes (new image stored)
  useEffect(() => {
    if (!isSupported) return

    getStoredImages().then(setImages)
  }, [isSupported, currentImageId, galleryVersion])

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

  // Register gallery toggle shortcut
  useAction('gallery:toggle', {
    label: collapsed ? 'Expand gallery' : 'Collapse gallery',
    group: 'Gallery',
    defaultBindings: ['\\'],
    handler: toggleCollapsed,
  })

  // Gallery prev/next shortcuts
  useAction('gallery:prev', {
    label: 'Previous gallery image',
    group: 'Gallery',
    defaultBindings: ['alt+ArrowUp'],
    handler: () => {
      if (images.length === 0) return
      const idx = images.findIndex(img => img.id === currentImageId)
      const prev = idx <= 0 ? images.length - 1 : idx - 1
      handleSelect(images[prev])
    },
  })
  useAction('gallery:next', {
    label: 'Next gallery image',
    group: 'Gallery',
    defaultBindings: ['alt+ArrowDown'],
    handler: () => {
      if (images.length === 0) return
      const idx = images.findIndex(img => img.id === currentImageId)
      const next = idx < 0 || idx >= images.length - 1 ? 0 : idx + 1
      handleSelect(images[next])
    },
  })

  // Register omnibar-searchable actions for each gallery image
  const handleSelectRef = useRef(handleSelect)
  handleSelectRef.current = handleSelect
  const imageActions = useMemo(() =>
    Object.fromEntries(
      images.map(img => [
        `gallery:image:${img.id}`,
        {
          label: img.basename,
          description: `${img.originalWidth}×${img.originalHeight}`,
          group: 'Gallery',
          defaultBindings: [] as string[],
          hideFromModal: true,
          keywords: ['image', 'gallery', img.basename],
          handler: () => handleSelectRef.current(img),
        },
      ])
    ),
    [images],
  )
  useActions(imageActions)

  if (!isSupported) {
    return null
  }

  return (
    <div className={`image-gallery${collapsed ? ' collapsed' : ''}`}>
      <div className="gallery-header">
        {!collapsed && <span className="gallery-title">Gallery</span>}
        <div className="gallery-header-buttons">
          {!collapsed && (
            <Tooltip title="Refresh gallery" placement="top" arrow>
              <button className="gallery-refresh" onClick={refreshImages}>
                ↻
              </button>
            </Tooltip>
          )}
          <Tooltip title={collapsed ? 'Expand gallery' : 'Collapse gallery'} placement="right" arrow>
            <button className="gallery-toggle" onClick={toggleCollapsed}>
              {collapsed ? '›' : '‹'}
            </button>
          </Tooltip>
        </div>
      </div>
      {!collapsed && (
        <div className="gallery-items">
          {images.length === 0 && (
            <div className="gallery-empty">No images</div>
          )}
          {images.map((img) => (
            <button
              key={img.id}
              type="button"
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
                  <span
                    role="button"
                    tabIndex={-1}
                    className="gallery-delete"
                    onClick={(e) => handleDelete(e, img.id)}
                  >
                    ×
                  </span>
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
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Export a function to add image to gallery (for use in ImageVoronoi)
export { storeImage } from '../storage/ImageStorage'
