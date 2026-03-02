import type { ScreenshotsMap } from 'scrns'

const screens: ScreenshotsMap = {
  'og-image': {
    query: '#n=1708&s=0&embed&src=https://picsum.photos/id/1043/1200/800',
    selector: '.canvas',
    width: 1200,
    height: 630,
    preScreenshotSleep: 5000,
    path: 'og-image.png',
  },
}

export default screens
