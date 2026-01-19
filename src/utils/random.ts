/**
 * Mulberry32 - a simple, fast 32-bit seeded PRNG
 * Returns a function that generates random numbers in [0, 1)
 */
export function createSeededRandom(seed: number): () => number {
  return function() {
    let t = seed += 0x6D2B79F5
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

/**
 * Generate a random seed (small, human-friendly numbers)
 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 10000)
}
