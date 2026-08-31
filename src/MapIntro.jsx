// "Map intro and info" section, between the banner and the map. Height
// spec: 318pt at the 1920pt reference frame -> 16.5625vw, full width.
//
// Three-column text box: column 1 (titles) has its own 30px inner padding.
// Columns 2+3 are a single flowing two-column text block (column-count: 2),
// not two independently-authored columns. Overall padding 30px, 18px gutter
// between all columns. Column 1's width relative to the text block isn't
// specified, so it's assumed to be roughly a third of the total width.
export default function MapIntro() {
  return (
    <div className="map-intro">
      <div className="map-intro-titles">
        <h3>Cartography of the Pacific Ocean’s Island Nations.</h3>
      </div>
      <div className="map-intro-text">
        <p>
          Placeholder text. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
          incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation
          ullamco laboris nisi ut aliquip ex ea commodo consequat.
        </p>
        <p>
          Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla
          pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt
          mollit anim id est laborum.
        </p>
      </div>
    </div>
  )
}
