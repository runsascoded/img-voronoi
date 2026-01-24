import { createTwoColumnRenderer } from 'use-kbd'

export const SitesRenderer = createTwoColumnRenderer({
  headers: ['', '−', '+'],
  getRows: () => [
    { label: 'Sites (±50)', leftAction: 'voronoi:decrease-sites', rightAction: 'voronoi:increase-sites' },
    { label: 'Sites (×½/×2)', leftAction: 'voronoi:halve-sites', rightAction: 'voronoi:double-sites' },
    { label: 'Sites (÷φ/×φ)', leftAction: 'voronoi:golden-down', rightAction: 'voronoi:golden-up' },
    { label: 'Step fwd/back', leftAction: 'voronoi:step-backward', rightAction: 'voronoi:step-forward' },
  ],
})
