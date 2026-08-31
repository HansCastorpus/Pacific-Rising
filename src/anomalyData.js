import { csvParseRows } from 'd3-dsv'

export const SEA_LEVEL_CSV_URL = `${import.meta.env.BASE_URL}data/sea-level-anomalies.csv`
export const SEA_TEMPERATURE_CSV_URL = `${import.meta.env.BASE_URL}data/sea-temperature-anomalies.csv`

// Shared shape used by both anomaly CSVs: a country/territory label column,
// one column per year, and a trailing "Grand Total" column and row.
export function parseAnomalyCsv(text) {
  const rows = csvParseRows(text)
  const years = rows[1].slice(1, -1).map(Number) // drop leading label column and trailing "Grand Total"
  const countries = []
  const values = []

  for (const row of rows.slice(2, -1)) {
    // rows[2..] excluding the trailing "Grand Total" row
    const country = row[0]
    countries.push(country)
    years.forEach((year, i) => {
      values.push({ country, year, value: Number(row[i + 1]) })
    })
  }

  return { years, countries, values }
}
