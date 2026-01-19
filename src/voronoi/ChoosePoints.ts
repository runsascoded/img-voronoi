export interface Position {
  x: number
  y: number
}

export type RandomFn = () => number

export class ChoosePoint {
  private imgData: number[]
  private n: number
  private width: number
  private height: number

  constructor(
    imgData: Uint8ClampedArray,
    width: number,
    height: number,
    n: number,
    inversePP: boolean,
  ) {
    this.imgData = new Array(width * height)
    this.n = n
    this.width = width
    this.height = height

    for (let i = 0; i < imgData.length; i += 4) {
      this.imgData[i / 4] = imgData[i] + 1
    }

    if (inversePP) {
      for (let i = 0; i < this.imgData.length; i++) {
        this.imgData[i] = 257 - this.imgData[i]
      }
    }
  }

  private scaleDown(ind: number): void {
    this.imgData[ind] = 0
    const weight = this.imgData[ind]
    const y = Math.floor(ind / this.width)
    const x = ind % this.width
    const radius = Math.max(Math.log2(weight) + 1, 1)

    for (let i = y - radius; i <= y + radius; i++) {
      for (let j = x - radius; j <= x + radius; j++) {
        if (i >= 0 && j >= 0 && j < this.width && i < this.height) {
          const pos = i * this.width + j
          this.imgData[pos] /= 2
        }
      }
    }
  }

  pickPosition(random: RandomFn = Math.random): Position[] {
    const choices = new Set<string>()
    const positions: Position[] = []

    while (positions.length < this.n) {
      const selected = Math.floor(random() * this.imgData.length)
      const selectedPosVal = this.imgData[selected]

      if (random() * 256 <= selectedPosVal) {
        const x = selected % this.width
        const y = Math.floor(selected / this.width)
        const key = `${x},${y}`

        if (!choices.has(key)) {
          choices.add(key)
          positions.push({ x, y })
          this.scaleDown(selected)
        }
      }
    }

    return positions
  }
}
