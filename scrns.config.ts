import type { ScreenshotsMap } from 'scrns'

const screens: ScreenshotsMap = {
  'og-image': {
    query: '#n=100&s=0&embed',
    selector: '.canvas',
    width: 1200,
    height: 630,
    preScreenshotSleep: 2000,
    path: 'og-image.png',
  },
}

export default screens
