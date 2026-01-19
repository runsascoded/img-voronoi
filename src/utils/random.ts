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

/**
 * Derive multiple sub-seeds from a base seed
 * Useful for RGB mode where each channel needs a different seed
 */
export function deriveSeed(baseSeed: number, index: number): number {
  // Use a simple hash to derive deterministic sub-seeds
  let h = baseSeed ^ (index * 0x9E3779B9)
  h = Math.imul(h ^ h >>> 16, 0x85EBCA6B)
  h = Math.imul(h ^ h >>> 13, 0xC2B2AE35)
  return (h ^ h >>> 16) >>> 0
}
