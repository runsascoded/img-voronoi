import { createTwoColumnRenderer } from 'use-kbd'

export const VoronoiRenderer = createTwoColumnRenderer({
  headers: ['', '−', '+'],
  getRows: () => [
    { label: 'Sites (±50)', leftAction: 'voronoi:decrease-sites', rightAction: 'voronoi:increase-sites' },
    { label: 'Sites (×½/×2)', leftAction: 'voronoi:halve-sites', rightAction: 'voronoi:double-sites' },
    { label: 'Sites (÷φ/×φ)', leftAction: 'voronoi:golden-down', rightAction: 'voronoi:golden-up' },
  ],
})
