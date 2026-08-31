import { useEffect, useRef, useState } from 'react'
import { scaleBand } from 'd3-scale'

const MARGIN = { top: 8, right: 8, bottom: 60, left: 190 }
const MIN_CELL_WIDTH = 2
const MIN_CELL_HEIGHT = 2
const MIN_LABEL_SPACING_PX = 16
const GREYED_OUT_FILL = '#d4d4d4'

// Shared grid geometry for country x year anomaly matrices - color and
// tooltip content are supplied by the caller so this stays data-agnostic.
// The container is measured via ResizeObserver on both axes, and the chart
// is drawn at exactly that size (cell width AND cell height both derived
// from the measured box) so it always fills its container instead of
// scrolling or overflowing. Year *labels* thin out as space gets tight
// (e.g. 1,2,3,4,5 -> 1,3,5 -> 1,5) so they don't overlap.
//
// activeYear ties the matrix to the shared timeline scrubber: years past it
// haven't been "reached" yet, so they're greyed out instead of colored,
// matching how the map/weather-station chart reveal data up to that year.
export default function MatrixHeatmap({ years, countries, values, color, tooltip, activeYear }) {
  const wrapRef = useRef(null)
  const [size, setSize] = useState(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  if (!size) return <div className="heatmap-scroll" ref={wrapRef} />

  const availableWidth = Math.max(size.width - MARGIN.left - MARGIN.right, MIN_CELL_WIDTH * years.length)
  const availableHeight = Math.max(size.height - MARGIN.top - MARGIN.bottom, MIN_CELL_HEIGHT * countries.length)
  const cellWidth = availableWidth / years.length
  const cellHeight = availableHeight / countries.length

  const maxLabels = Math.max(1, Math.floor(availableWidth / MIN_LABEL_SPACING_PX))
  const labelStep = Math.max(1, Math.ceil(years.length / maxLabels))
  const shownYearLabels = years.filter((_, i) => i % labelStep === 0)

  const x = scaleBand().domain(years).range([0, availableWidth])
  const y = scaleBand().domain(countries).range([0, availableHeight])
  const axisY = availableHeight + 6

  return (
    <div className="heatmap-scroll" ref={wrapRef}>
      <svg width={size.width} height={size.height}>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {values.map((d) => (
            <rect
              key={`${d.country}-${d.year}`}
              x={x(d.year)}
              y={y(d.country)}
              width={cellWidth}
              height={cellHeight}
              fill={activeYear != null && d.year > activeYear ? GREYED_OUT_FILL : color(d)}
            >
              <title>{tooltip(d)}</title>
            </rect>
          ))}
          {countries.map((country) => (
            <text key={country} x={-6} y={y(country) + y.bandwidth() / 2} className="heatmap-row-label">
              {country}
            </text>
          ))}
          {shownYearLabels.map((year) => (
            <text
              key={year}
              x={x(year) + cellWidth / 2}
              y={axisY}
              className="heatmap-col-label"
              transform={`rotate(-60, ${x(year) + cellWidth / 2}, ${axisY})`}
            >
              {year}
            </text>
          ))}
        </g>
      </svg>
    </div>
  )
}
