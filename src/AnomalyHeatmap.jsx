import { useEffect, useMemo, useState } from 'react'
import { scaleDiverging } from 'd3-scale'
import { interpolateRdBu } from 'd3-scale-chromatic'
import { max } from 'd3-array'
import MatrixHeatmap from './MatrixHeatmap'
import { parseAnomalyCsv } from './anomalyData'

// Shared by the sea-level and sea-temperature heatmaps - both source CSVs
// have the exact same shape (country rows, one column per year), so this
// is one data-agnostic diverging matrix parameterized by which CSV to
// fetch and what unit to show in the tooltip. Every year present in the
// CSV is shown (e.g. sea temperature runs 1850-2025, not just the
// 1999-2023 range the timelines cover) - activeYear (the shared, timeline-
// driven year, capped at the present) greys out anything beyond it.
export default function AnomalyHeatmap({ csvUrl, unit, activeYear }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetch(csvUrl)
      .then((res) => res.text())
      .then((text) => {
        if (!cancelled) setData(parseAnomalyCsv(text))
      })
    return () => {
      cancelled = true
    }
  }, [csvUrl])

  const color = useMemo(() => {
    if (!data) return null
    const maxAbs = max(data.values, (d) => Math.abs(d.value))
    return scaleDiverging(interpolateRdBu).domain([maxAbs, 0, -maxAbs])
  }, [data])

  if (!data) return null

  return (
    <MatrixHeatmap
      years={data.years}
      countries={data.countries}
      values={data.values}
      color={(d) => color(d.value)}
      tooltip={(d) => `${d.country} ${d.year}: ${d.value > 0 ? '+' : ''}${d.value} ${unit}`}
      activeYear={activeYear}
    />
  )
}
