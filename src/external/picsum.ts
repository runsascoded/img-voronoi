export interface PicsumImage {
  id: string
  author: string
  width: number
  height: number
  url: string
  download_url: string
}

const API_BASE = 'https://picsum.photos'

export async function fetchPicsumList(page: number, limit = 30): Promise<PicsumImage[]> {
  const res = await fetch(`${API_BASE}/v2/list?page=${page}&limit=${limit}`)
  if (!res.ok) throw new Error(`Picsum API error: ${res.status}`)
  return res.json()
}

export function picsumThumbUrl(id: string, size = 100): string {
  return `${API_BASE}/id/${id}/${size}/${size}`
}

export function picsumImageUrl(id: string, w: number, h: number, maxDim = 1600): string {
  const scale = Math.min(1, maxDim / Math.max(w, h))
  const sw = Math.round(w * scale)
  const sh = Math.round(h * scale)
  return `${API_BASE}/id/${id}/${sw}/${sh}`
}
