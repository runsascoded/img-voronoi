import { HotkeysProvider, ShortcutsModal, Omnibar, SequenceModal, LookupModal } from 'use-kbd'
import 'use-kbd/styles.css'
import { ImageVoronoi } from './components/ImageVoronoi'

function App() {
  return (
    <HotkeysProvider>
      <ImageVoronoi />
      <ShortcutsModal />
      <Omnibar />
      <LookupModal />
      <SequenceModal />
    </HotkeysProvider>
  )
}

export default App
