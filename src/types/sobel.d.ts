declare module 'sobel' {
  interface SobelData extends Uint8ClampedArray {
    length: number
  }

  export default function Sobel(imageData: ImageData): SobelData
}
