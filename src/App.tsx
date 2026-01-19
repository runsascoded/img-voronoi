import { HotkeysProvider, ShortcutsModal, Omnibar, SequenceModal, LookupModal } from 'use-kbd'
import 'use-kbd/styles.css'
import { ImageVoronoi } from './components/ImageVoronoi'
import { VoronoiRenderer } from './components/groupRenderers'

const GROUP_RENDERERS = {
  'Voronoi': VoronoiRenderer,
}

function App() {
  return (
    <HotkeysProvider>
      <ImageVoronoi />
      <ShortcutsModal groupRenderers={GROUP_RENDERERS} />
      <Omnibar />
      <LookupModal />
      <SequenceModal />
    </HotkeysProvider>
  )
}

export default App
