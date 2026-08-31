import { useEffect, useRef, useState } from 'react'
import { scaleBand } from 'd3-scale'

const MARGIN = { top: 8, right: 8, bottom: 60, left: 190 }
const MIN_LABEL_SPACING_PX = 16
const DOT_DIAMETER_PX = 2
const DOT_GAP_PX = 2
const DOTS_PER_COLUMN = 3
const GREYED_OUT_FILL = '#d4d4d4'
const DOT_FILL = '#2a2a2a'

// Country x year matrix like MatrixHeatmap, but isotype style: each cell
// draws one small circle per unit of "count" instead of a single
// color-coded mark, filling top-to-bottom in columns of 3 before starting
// a new column, with the whole cluster centered within the cell.
export default function IsotypeMatrix({ years, countries, values, activeYear }) {
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

  const availableWidth = Math.max(size.width - MARGIN.left - MARGIN.right, years.length)
  const availableHeight = Math.max(size.height - MARGIN.top - MARGIN.bottom, countries.length)
  const cellWidth = availableWidth / years.length
  const cellHeight = availableHeight / countries.length

  const maxLabels = Math.max(1, Math.floor(availableWidth / MIN_LABEL_SPACING_PX))
  const labelStep = Math.max(1, Math.ceil(years.length / maxLabels))
  const shownYearLabels = years.filter((_, i) => i % labelStep === 0)

  const x = scaleBand().domain(years).range([0, availableWidth])
  const y = scaleBand().domain(countries).range([0, availableHeight])
  const axisY = availableHeight + 6

  const dotDiameter = DOT_DIAMETER_PX
  const step = dotDiameter + DOT_GAP_PX

  return (
    <div className="heatmap-scroll" ref={wrapRef}>
      <svg width={size.width} height={size.height}>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {values.map((d) => {
            if (d.count <= 0) return null
            const greyed = activeYear != null && d.year > activeYear
            const numCols = Math.ceil(d.count / DOTS_PER_COLUMN)
            const rowsInLastFullColumn = Math.min(d.count, DOTS_PER_COLUMN)
            const clusterWidth = numCols * step - DOT_GAP_PX
            const clusterHeight = rowsInLastFullColumn * step - DOT_GAP_PX
            const clusterX = x(d.year) + cellWidth / 2 - clusterWidth / 2
            const clusterY = y(d.country) + cellHeight / 2 - clusterHeight / 2
            return Array.from({ length: d.count }, (_, i) => {
              const col = Math.floor(i / DOTS_PER_COLUMN)
              const row = i % DOTS_PER_COLUMN
              const cx = clusterX + dotDiameter / 2 + col * step
              const cy = clusterY + dotDiameter / 2 + row * step
              return (
                <circle
                  key={`${d.country}-${d.year}-${i}`}
                  cx={cx}
                  cy={cy}
                  r={dotDiameter / 2}
                  fill={greyed ? GREYED_OUT_FILL : DOT_FILL}
                >
                  <title>{`${d.country} ${d.year}: ${d.count} station${d.count === 1 ? '' : 's'}`}</title>
                </circle>
              )
            })
          })}
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
