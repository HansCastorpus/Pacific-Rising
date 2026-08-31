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
        <h3>
          Cartography of the Pacific Ocean’s Island Nations.
          <a className="source-ref" href="#source-1">
            1
          </a>
        </h3>
      </div>
      <div className="map-intro-text">
        <p>
          This project aims to share the data showing this damage. Using data from stats.pacificdata.org, and
          as part of the Pacific Dataviz Challenge 2026, I’ve created a few visualization tools to understand
          the current impact of rising sea levels.
        </p>
        <p>
          The main one is the map below. This shows the evolution of the shorelines from 1999 to 2023. On top
          of this, a fixed data point shows the positive or negative rate of shoreline change, in meters per
          year, at each point, based on a linear regression of its historical positions. This overlap allows a
          quick overview of where land has shrunk and where it has grown. Explore the map in depth to see in
          detail where the shoreline has been receding.
        </p>
        <p>
          The goal for the future of this project is to add as many locations as possible, allowing people to
          visualise the damage and long term risk the region is facing.
        </p>
      </div>
    </div>
  )
}
