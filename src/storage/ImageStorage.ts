/**
 * OPFS-based image storage with thumbnails and metadata
 */

export interface StoredImage {
  id: string
  basename: string
  originalWidth: number
  originalHeight: number
  mimeType: string
  addedAt: number
}

interface ImageMetadata {
  images: StoredImage[]
}

const METADATA_FILE = 'metadata.json'
const IMAGES_DIR = 'images'
const THUMBNAILS_DIR = 'thumbnails'
const THUMBNAIL_SIZE = 80

/**
 * Get OPFS root directory for image storage
 */
async function getStorageRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle('img-voronoi', { create: true })
}

/**
 * Get or create a subdirectory
 */
async function getSubdir(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create: true })
}

/**
 * Read metadata file
 */
async function readMetadata(root: FileSystemDirectoryHandle): Promise<ImageMetadata> {
  try {
    const fileHandle = await root.getFileHandle(METADATA_FILE)
    const file = await fileHandle.getFile()
    const text = await file.text()
    return JSON.parse(text)
  } catch {
    return { images: [] }
  }
}

/**
 * Write metadata file
 */
async function writeMetadata(root: FileSystemDirectoryHandle, metadata: ImageMetadata): Promise<void> {
  const fileHandle = await root.getFileHandle(METADATA_FILE, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(metadata, null, 2))
  await writable.close()
}

/**
 * Generate a thumbnail from an image blob
 */
async function generateThumbnail(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')!

      // Calculate thumbnail dimensions maintaining aspect ratio
      const scale = Math.min(THUMBNAIL_SIZE / img.width, THUMBNAIL_SIZE / img.height)
      const width = Math.round(img.width * scale)
      const height = Math.round(img.height * scale)

      canvas.width = width
      canvas.height = height
      ctx.drawImage(img, 0, 0, width, height)

      canvas.toBlob(
        (thumbnailBlob) => {
          if (thumbnailBlob) {
            resolve(thumbnailBlob)
          } else {
            reject(new Error('Failed to generate thumbnail'))
          }
        },
        'image/jpeg',
        0.8
      )
      URL.revokeObjectURL(img.src)
    }
    img.onerror = () => {
      URL.revokeObjectURL(img.src)
      reject(new Error('Failed to load image for thumbnail'))
    }
    img.src = URL.createObjectURL(blob)
  })
}

/**
 * Generate unique ID for image
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Store a new image
 */
export async function storeImage(file: File): Promise<StoredImage> {
  const root = await getStorageRoot()
  const imagesDir = await getSubdir(root, IMAGES_DIR)
  const thumbnailsDir = await getSubdir(root, THUMBNAILS_DIR)

  // Get image dimensions
  const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      resolve({ width: img.width, height: img.height })
      URL.revokeObjectURL(img.src)
    }
    img.onerror = () => {
      URL.revokeObjectURL(img.src)
      reject(new Error('Failed to load image'))
    }
    img.src = URL.createObjectURL(file)
  })

  const id = generateId()
  const basename = file.name.replace(/\.[^/.]+$/, '') // Remove extension

  // Store original image
  const imageHandle = await imagesDir.getFileHandle(id, { create: true })
  const imageWritable = await imageHandle.createWritable()
  await imageWritable.write(file)
  await imageWritable.close()

  // Generate and store thumbnail
  const thumbnail = await generateThumbnail(file)
  const thumbnailHandle = await thumbnailsDir.getFileHandle(id, { create: true })
  const thumbnailWritable = await thumbnailHandle.createWritable()
  await thumbnailWritable.write(thumbnail)
  await thumbnailWritable.close()

  // Update metadata
  const metadata = await readMetadata(root)
  const storedImage: StoredImage = {
    id,
    basename,
    originalWidth: dimensions.width,
    originalHeight: dimensions.height,
    mimeType: file.type || 'image/png',
    addedAt: Date.now(),
  }
  metadata.images.unshift(storedImage) // Add to front (most recent first)
  await writeMetadata(root, metadata)

  return storedImage
}

/**
 * Get all stored images
 */
export async function getStoredImages(): Promise<StoredImage[]> {
  const root = await getStorageRoot()
  const metadata = await readMetadata(root)
  return metadata.images
}

/**
 * Get image blob by ID
 */
export async function getImageBlob(id: string): Promise<Blob | null> {
  try {
    const root = await getStorageRoot()
    const imagesDir = await getSubdir(root, IMAGES_DIR)
    const fileHandle = await imagesDir.getFileHandle(id)
    return await fileHandle.getFile()
  } catch {
    return null
  }
}

/**
 * Get thumbnail blob by ID
 */
export async function getThumbnailBlob(id: string): Promise<Blob | null> {
  try {
    const root = await getStorageRoot()
    const thumbnailsDir = await getSubdir(root, THUMBNAILS_DIR)
    const fileHandle = await thumbnailsDir.getFileHandle(id)
    return await fileHandle.getFile()
  } catch {
    return null
  }
}

/**
 * Update image basename
 */
export async function updateImageBasename(id: string, newBasename: string): Promise<void> {
  const root = await getStorageRoot()
  const metadata = await readMetadata(root)

  const image = metadata.images.find((img) => img.id === id)
  if (image) {
    image.basename = newBasename
    await writeMetadata(root, metadata)
  }
}

/**
 * Delete an image
 */
export async function deleteImage(id: string): Promise<void> {
  const root = await getStorageRoot()
  const imagesDir = await getSubdir(root, IMAGES_DIR)
  const thumbnailsDir = await getSubdir(root, THUMBNAILS_DIR)

  // Delete image file
  try {
    await imagesDir.removeEntry(id)
  } catch {
    // File may not exist
  }

  // Delete thumbnail
  try {
    await thumbnailsDir.removeEntry(id)
  } catch {
    // File may not exist
  }

  // Update metadata
  const metadata = await readMetadata(root)
  metadata.images = metadata.images.filter((img) => img.id !== id)
  await writeMetadata(root, metadata)
}

/**
 * Store an image from a URL (e.g. a Vite asset import).
 * Fetches the URL, creates a File, and delegates to storeImage.
 */
export async function storeImageFromUrl(url: string, basename: string): Promise<StoredImage> {
  const response = await fetch(url)
  const blob = await response.blob()
  const file = new File([blob], `${basename}.jpg`, { type: blob.type || 'image/jpeg' })
  return storeImage(file)
}

/**
 * Check if OPFS is supported
 */
export function isOPFSSupported(): boolean {
  return 'storage' in navigator && 'getDirectory' in navigator.storage
}
