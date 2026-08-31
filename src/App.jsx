import './App.css'
import Hero from './Hero'
import Banner from './Banner'
import MapSection from './MapSection'
import MapIntro from './MapIntro'

function App() {
  return (
    <div className="app">
      <div className="app-inner">
        <Hero />
        <Banner />
        <MapIntro />
        <MapSection />
      </div>
    </div>
  )
}

export default App
