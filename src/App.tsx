import { HotkeysProvider, ShortcutsModal, Omnibar, SequenceModal, LookupModal } from 'use-kbd'
import 'use-kbd/styles.css'
import { ImageVoronoi } from './components/ImageVoronoi'
import { SitesRenderer } from './components/groupRenderers'

const GROUP_RENDERERS = {
  'Sites': SitesRenderer,
}

const GROUP_ORDER = ['Voronoi', 'Sites']

function App() {
  return (
    <HotkeysProvider>
      <ImageVoronoi />
      <ShortcutsModal groupRenderers={GROUP_RENDERERS} groupOrder={GROUP_ORDER} />
      <Omnibar />
      <LookupModal />
      <SequenceModal />
    </HotkeysProvider>
  )
}

export default App
