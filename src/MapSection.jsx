import { useEffect, useMemo, useRef, useState } from 'react'
import { Map as MapLibreMap, Popup, AttributionControl, addProtocol, setWorkerUrl } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { csvParseRows } from 'd3-dsv'
import 'maplibre-gl/dist/maplibre-gl.css'
import FitText from './FitText'
import FitTextLine from './FitTextLine'
import FitTextBlock from './FitTextBlock'
import AnomalyHeatmap from './AnomalyHeatmap'
import IsotypeMatrix from './IsotypeMatrix'
import { SEA_LEVEL_CSV_URL, SEA_TEMPERATURE_CSV_URL, parseAnomalyCsv } from './anomalyData'

const protocol = new Protocol()
addProtocol('pmtiles', protocol.tile)

// maplibre-gl 6.x resolves its web worker from a file sitting next to its own
// module (via import.meta.url). Vite inlines maplibre into the app bundle and
// never emits that worker file, so in a production build the worker request
// hangs and no tiles are ever parsed. Point it at a vendored copy in public/
// instead. Re-copy public/maplibre-gl-worker.mjs + maplibre-gl-shared.mjs from
// node_modules/maplibre-gl/dist/ whenever maplibre-gl is upgraded.
setWorkerUrl(`${import.meta.env.BASE_URL}maplibre-gl-worker.mjs`)

const PMTILES_URL = `pmtiles://${window.location.origin}${import.meta.env.BASE_URL}tiles/coastlines.pmtiles`
const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark'

const OCEAN_COLOR = '#003153'
const LAND_COLOR = '#d9d9d9'
const URBAN_COLOR = '#a3a3a3'
const URBAN_LAYER_IDS = new Set(['landuse_residential', 'building'])
const LABEL_TEXT_COLOR = '#2a2a2a'
const LABEL_HALO_COLOR = 'rgba(255,255,255,0.85)'
const WATER_LAYER_IDS = new Set(['water', 'waterway'])

// Recolor the basemap to a dark-blue-ocean / light-grey-land palette while
// keeping every layer (and all geo names) in place.
function recolorBasemapLayers(layers) {
  return layers.map((layer) => {
    if (layer.id === 'background') {
      return { ...layer, paint: { ...layer.paint, 'background-color': LAND_COLOR } }
    }
    if (WATER_LAYER_IDS.has(layer.id)) {
      const colorKey = layer.type === 'line' ? 'line-color' : 'fill-color'
      return { ...layer, paint: { ...layer.paint, [colorKey]: OCEAN_COLOR } }
    }
    if (layer.type === 'fill') {
      const { 'fill-pattern': _pattern, ...restPaint } = layer.paint ?? {}
      const color = URBAN_LAYER_IDS.has(layer.id) ? URBAN_COLOR : LAND_COLOR
      return { ...layer, paint: { ...restPaint, 'fill-color': color } }
    }
    if (layer.type === 'symbol' && layer.paint && 'text-color' in layer.paint) {
      return {
        ...layer,
        paint: { ...layer.paint, 'text-color': LABEL_TEXT_COLOR, 'text-halo-color': LABEL_HALO_COLOR },
      }
    }
    return layer
  })
}

// AWS's public Terrarium DEM tiles - global coverage, no API key required.
const HILLSHADE_SOURCE_ID = 'terrain-dem'
const HILLSHADE_LAYER_ID = 'hillshade'
const HILLSHADE_SOURCE = {
  type: 'raster-dem',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  tileSize: 256,
  encoding: 'terrarium',
  maxzoom: 15,
}
const HILLSHADE_LAYER = {
  id: HILLSHADE_LAYER_ID,
  type: 'hillshade',
  source: HILLSHADE_SOURCE_ID,
  layout: { visibility: 'visible' },
  paint: {
    'hillshade-shadow-color': '#7a6a55',
    'hillshade-highlight-color': '#efe6d8',
    'hillshade-accent-color': '#8a7256',
    'hillshade-exaggeration': 0.3,
  },
}

// Hillshade is a raster covering the whole map extent (land and sea alike),
// so it bleeds a brown tint over the ocean. Re-paint the real water polygons
// on top of it to mask that out and keep the ocean a clean blue.
const OPENMAPTILES_SOURCE_ID = 'openmaptiles'
const OCEAN_MASK_LAYER = {
  id: 'ocean-mask',
  type: 'fill',
  source: OPENMAPTILES_SOURCE_ID,
  'source-layer': 'water',
  layout: { visibility: 'visible' },
  paint: { 'fill-color': OCEAN_COLOR },
}

const SHORELINE_MIN_YEAR = 1999
const SHORELINE_MAX_YEAR = 2023
const MANGROVE_MIN_YEAR = 2017
const TRAIL_LENGTH = 3

// Sea-temperature data goes back further than the shared timeline's range
// (1850-2025 vs. 1999-2023) - that mini-timeline shows the full historical
// scale so its extent is visible, but only the shared 1999-2023 window
// stays draggable. yearToFrac is a function declaration (hoisted), so it's
// safe to call here even though it's defined further down the file.
const SST_TIMELINE_MIN_YEAR = 1850
const SST_TIMELINE_MAX_YEAR = 2025
const SST_ACCESSIBLE_START_FRAC = yearToFrac(SHORELINE_MIN_YEAR, SST_TIMELINE_MIN_YEAR, SST_TIMELINE_MAX_YEAR)
const SST_ACCESSIBLE_END_FRAC = yearToFrac(SHORELINE_MAX_YEAR, SST_TIMELINE_MIN_YEAR, SST_TIMELINE_MAX_YEAR)

const MANGROVE_WMS_BASE =
  'https://ows.prod.digitalearthpacific.io/wms?service=WMS&version=1.1.1&request=GetMap' +
  '&layers=dep_s2_ammi&styles=style_mangroves_percent&format=image/png&transparent=true' +
  '&width=256&height=256&srs=EPSG:3857&bbox={bbox-epsg-3857}'

// Only the years reachable from the timeline (up to SHORELINE_MAX_YEAR) are
// pre-loaded - mangrove data past that point would never be shown here.
const MANGROVE_YEARS = []
for (let y = MANGROVE_MIN_YEAR; y <= SHORELINE_MAX_YEAR; y++) MANGROVE_YEARS.push(y)

function mangroveLayerId(year) {
  return `mangroves-${year}`
}

// Pre-create one layer per year (all start transparent) so each year's tiles
// load once, in the background, up front - switching years is then just an
// opacity toggle instead of a network round-trip.
function setupMangroveLayers(map) {
  for (const year of MANGROVE_YEARS) {
    const id = mangroveLayerId(year)
    if (map.getSource(id)) continue
    map.addSource(id, {
      type: 'raster',
      tiles: [`${MANGROVE_WMS_BASE}&time=${year}-01-01`],
      tileSize: 256,
    })
    map.addLayer(
      {
        id,
        type: 'raster',
        source: id,
        paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 200 } },
      },
      'shorelines-background',
    )
  }
}

function setMangroveYear(map, year) {
  // No mangrove data before MANGROVE_MIN_YEAR - hide entirely rather than
  // showing a nearest-available year that isn't actually this year.
  for (const y of MANGROVE_YEARS) {
    map.setPaintProperty(mangroveLayerId(y), 'raster-opacity', y === year ? 0.75 : 0)
  }
}

function updateYearLayers(map, year, showMangrove) {
  const trailYears = []
  for (let y = year - TRAIL_LENGTH; y < year; y++) {
    if (y >= SHORELINE_MIN_YEAR) trailYears.push(y)
  }

  map.setFilter('shorelines-current', ['==', ['get', 'year'], year])
  map.setFilter(
    'shorelines-trail',
    trailYears.length ? ['in', ['get', 'year'], ['literal', trailYears]] : ['==', ['get', 'year'], -1],
  )
  map.setPaintProperty('shorelines-trail', 'line-opacity', [
    'interpolate',
    ['linear'],
    ['-', year, ['get', 'year']],
    1,
    0.45,
    TRAIL_LENGTH,
    0.05,
  ])
  setMangroveYear(map, showMangrove && year >= MANGROVE_MIN_YEAR ? year : null)
}

// Erosion/accretion heat layers: a soft red/blue haze over rates_of_change
// points, weighted by |rate_time| (m/yr). The haze is local to whatever's
// on screen, fitting the curated per-island scope. Weight caps around the
// local 90th percentile (~1.5 m/yr near Pohnpei) so the common range reads
// clearly instead of being washed out by rare extreme values.
const HEAT_WEIGHT = ['interpolate', ['linear'], ['abs', ['get', 'rate_time']], 0, 0, 1.5, 1]
const HEAT_RADIUS = ['interpolate', ['linear'], ['zoom'], 8, 15, 14, 45]
const HEAT_INTENSITY = ['interpolate', ['linear'], ['zoom'], 8, 1, 14, 3]

// The haze reads fine zoomed out but gets visually noisy up close (individual
// point kernels become distinguishable), so it fades out over this zoom range
// as the perpendicular tick marks (below) fade in. The rates_of_change tiles
// carry data from zoom 9 up.
const ZOOM_TRANSITION_START = 9
const ZOOM_TRANSITION_END = 11
const HEAT_OPACITY = ['interpolate', ['linear'], ['zoom'], ZOOM_TRANSITION_START, 0.75, ZOOM_TRANSITION_END, 0]

// Zoomed-out haze sources from hotspots_zoom_2 rather than raw rates_of_change
// points - hotspots are DEA's own spatial aggregation (average rate_time over
// a 5km radius, see radius_m/n), so the haze reflects a genuine local average
// instead of just piling up wherever points happen to be denser.
function heatLayer(id, sign, colorRamp) {
  return {
    id,
    type: 'heatmap',
    source: 'coastlines',
    'source-layer': 'hotspots_zoom_2',
    filter: ['all', ['==', ['get', 'certainty'], 'good'], [sign, ['get', 'rate_time'], 0]],
    paint: {
      'heatmap-weight': HEAT_WEIGHT,
      'heatmap-radius': HEAT_RADIUS,
      'heatmap-intensity': HEAT_INTENSITY,
      'heatmap-opacity': HEAT_OPACITY,
      'heatmap-color': colorRamp,
    },
  }
}

// Perpendicular tick marks: rendered directly from the rates_of_change vector
// tiles - no client-side re-derivation, so there's no dependency on which
// tiles happen to be loaded at query time. Width and length are decoupled by
// using small pre-rendered icon variants (fixed width, a few discrete
// lengths in pixels - screen-space, so ticks stay the same visual size
// regardless of zoom) rather than a scaled text glyph or real-world geometry.
//
// Point density per screen pixel is still high at zoom 14+ (transects are
// close together on the ground), so a single fixed width overlaps badly
// there - width steps down in several tiers across the zoom range via
// separate icon sets and zoom-gated layers (icon-size can't do this alone,
// since it would scale length too).
const TICK_WIDTH_TIERS = [
  { tag: 'w5', px: 3, minzoom: ZOOM_TRANSITION_START, maxzoom: 11 },
  { tag: 'w4', px: 1, minzoom: 11, maxzoom: 13 },
  { tag: 'w3', px: 2, minzoom: 13, maxzoom: 15 },
  { tag: 'w2', px: 2, minzoom: 15, maxzoom: 17 },
  { tag: 'w1', px: 2, minzoom: 17 },
]
const TICK_LENGTH_BUCKETS_PX = [9, 18, 27, 36, 46] // +15% over the original 8-40 range

function makeTickIcon(widthPx, lengthPx, color) {
  const canvas = document.createElement('canvas')
  canvas.width = widthPx
  canvas.height = lengthPx
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, widthPx, lengthPx)
  return ctx.getImageData(0, 0, widthPx, lengthPx)
}

function setupTickIcons(map) {
  for (const { tag, px } of TICK_WIDTH_TIERS) {
    for (const len of TICK_LENGTH_BUCKETS_PX) {
      const redId = `tick-${tag}-red-${len}`
      const blueId = `tick-${tag}-blue-${len}`
      if (!map.hasImage(redId)) map.addImage(redId, makeTickIcon(px, len, '#ff3b30'))
      if (!map.hasImage(blueId)) map.addImage(blueId, makeTickIcon(px, len, '#3b82ff'))
    }
  }
}

const TICK_LENGTH_EXPR = [
  'step',
  ['abs', ['get', 'rate_time']],
  TICK_LENGTH_BUCKETS_PX[0],
  0.3,
  TICK_LENGTH_BUCKETS_PX[1],
  0.6,
  TICK_LENGTH_BUCKETS_PX[2],
  0.9,
  TICK_LENGTH_BUCKETS_PX[3],
  1.2,
  TICK_LENGTH_BUCKETS_PX[4],
]

function tickLayer({ tag, minzoom, maxzoom }) {
  return {
    id: `change-ticks-${tag}`,
    type: 'symbol',
    source: 'coastlines',
    'source-layer': 'rates_of_change',
    minzoom,
    ...(maxzoom !== undefined ? { maxzoom } : {}),
    filter: ['==', ['get', 'certainty'], 'good'],
    layout: {
      'icon-image': [
        'concat',
        `tick-${tag}-`,
        ['case', ['<', ['get', 'rate_time'], 0], 'red', 'blue'],
        '-',
        ['to-string', TICK_LENGTH_EXPR],
      ],
      // Centered on the point, straddling the shoreline - angle_mean's
      // axial ambiguity (no land/sea sign) doesn't matter here since a
      // symmetric tick looks identical either way round.
      'icon-rotate': ['get', 'angle_mean'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-opacity': ['interpolate', ['linear'], ['zoom'], ZOOM_TRANSITION_START, 0, ZOOM_TRANSITION_END, 1],
    },
  }
}

const CHANGE_TICKS_LAYERS = TICK_WIDTH_TIERS.map(tickLayer)
const CHANGE_TICKS_LAYER_IDS = CHANGE_TICKS_LAYERS.map((l) => l.id)

// Shows rate_time (m/yr) in a small popup when hovering any tick, across all
// width tiers at once (queried by point rather than attached per-layer).
function setupTickHover(map) {
  const popup = new Popup({ closeButton: false, closeOnClick: false })
  map.on('mousemove', (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: CHANGE_TICKS_LAYER_IDS })
    if (features.length === 0) {
      map.getCanvas().style.cursor = ''
      popup.remove()
      return
    }
    map.getCanvas().style.cursor = 'pointer'
    const rateTime = features[0].properties.rate_time
    const sign = rateTime >= 0 ? '+' : ''
    popup.setLngLat(e.lngLat).setHTML(`${sign}${rateTime.toFixed(2)} m/yr`).addTo(map)
  })
  map.on('mouseleave', () => {
    map.getCanvas().style.cursor = ''
    popup.remove()
  })
}

const EROSION_HEAT = heatLayer('erosion-heat', '<', [
  'interpolate',
  ['linear'],
  ['heatmap-density'],
  0,
  'rgba(255,0,0,0)',
  0.3,
  'rgba(255,80,0,0.35)',
  0.6,
  'rgba(255,30,0,0.65)',
  1,
  'rgba(255,0,0,0.9)',
])

const ACCRETION_HEAT = heatLayer('accretion-heat', '>', [
  'interpolate',
  ['linear'],
  ['heatmap-density'],
  0,
  'rgba(0,120,255,0)',
  0.3,
  'rgba(0,150,255,0.35)',
  0.6,
  'rgba(30,100,255,0.65)',
  1,
  'rgba(0,80,255,0.9)',
])

// Inserted right above the basemap's water fill but below its land/landuse/
// building layers, so land visually covers the glow and it only shows over
// water - "sticking out into the sea" rather than washing over the coast.
function setupHeatLayers(map) {
  map.addLayer(EROSION_HEAT, 'landcover_ice_shelf')
  map.addLayer(ACCRETION_HEAT, 'landcover_ice_shelf')
}

const HOTSPOT_SOURCE_ID = 'hotspots'
const HOTSPOT_LAYER_ID = 'hotspots'

function hotspotsToGeoJSON(hotspots) {
  return {
    type: 'FeatureCollection',
    features: hotspots
      .filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon))
      .map((h) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [h.lon, h.lat] },
        // "interest" mirrors the info-card circle colors: red for
        // Negative/at-risk hotspots, green for everything else.
        properties: { location: h.location, interest: h.impactDirection !== 'Negative' },
      })),
  }
}

function setupHotspotLayer(map) {
  if (map.getSource(HOTSPOT_SOURCE_ID)) return
  map.addSource(HOTSPOT_SOURCE_ID, { type: 'geojson', data: hotspotsToGeoJSON([]) })
  map.addLayer({
    id: HOTSPOT_LAYER_ID,
    type: 'circle',
    source: HOTSPOT_SOURCE_ID,
    paint: {
      'circle-radius': 7,
      'circle-opacity': 0,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ff3b30',
    },
  })
}

function updateHotspotLayer(map, hotspots) {
  const source = map.getSource(HOTSPOT_SOURCE_ID)
  if (!source) return
  source.setData(hotspotsToGeoJSON(hotspots))
}

// One tick per year, 1999-2023 (25 years), evenly spaced across the
// 877px-wide timeline track (13.8021vw to 13.8021+45.6771vw).
const YEAR_TICKS = Array.from({ length: 25 }, (_, i) => 13.8021 + (i * 45.6771) / 24)

// Mangrove data only covers 2017-2023 (7 years), on the shorter track
// (48.0599vw to 48.0599+11.4193vw) that's right-aligned with timeline 1.
const MANGROVE_YEAR_TICKS = Array.from({ length: 7 }, (_, i) => 48.0599 + (i * 11.4193) / 6)

function yearFromPointerX(clientX, trackEl, minYear, maxYear) {
  const rect = trackEl.getBoundingClientRect()
  const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  return Math.round(minYear + frac * (maxYear - minYear))
}

// Same as yearFromPointerX, but the draggable [minYear, maxYear] range only
// occupies a sub-section of the track (from rangeStartFrac to
// rangeEndFrac, 0-1) rather than the whole thing - used where the track
// visualizes a wider scale than what's actually draggable.
function yearFromPointerXInRange(clientX, trackEl, minYear, maxYear, rangeStartFrac, rangeEndFrac) {
  const rect = trackEl.getBoundingClientRect()
  const rawFrac = (clientX - rect.left) / rect.width
  const subFrac = Math.min(1, Math.max(0, (rawFrac - rangeStartFrac) / (rangeEndFrac - rangeStartFrac)))
  return Math.round(minYear + subFrac * (maxYear - minYear))
}

function yearToFrac(year, minYear, maxYear) {
  const clamped = Math.min(maxYear, Math.max(minYear, year))
  return (clamped - minYear) / (maxYear - minYear)
}

// Handle position along a track, in cqw, from a year value clamped to that
// track's own range (px reference values from the geometry worked out
// earlier: track 1 spans 265-1142px / 1999-2023, track 2 spans
// 922.75-1142px / 2017-2023).
function yearToLeftCqw(year, startPx, widthPx, minYear, maxYear) {
  return ((startPx + yearToFrac(year, minYear, maxYear) * widthPx) / 1920) * 100
}

const WEATHER_STATIONS_CSV_URL = `${import.meta.env.BASE_URL}data/weather-stations.csv`

// "Total of Weather Stations.csv" is a per-country cumulative running
// total by year (1889-2026); the "Grand Total" row is the Pacific-wide
// cumulative count. Returns a { year: count } lookup for the years our
// timeline actually covers.
// Returns { countryName: { year: cumulativeCount } } - per-country, not
// just the Pacific-wide "Grand Total" row, so the chart can eventually
// follow whichever nation button is selected.
function parseWeatherStationCounts(text) {
  const rows = csvParseRows(text)
  const years = rows[1].slice(2, -1).map(Number) // drop label/blank cols and trailing "Grand Total"
  const byCountry = {}
  for (const row of rows.slice(2)) {
    // rows[2..], including the trailing "Grand Total" row (kept as its own
    // "country" entry, useful as a Pacific-wide fallback/comparison)
    const country = row[0]
    const counts = {}
    years.forEach((year, i) => {
      if (year >= SHORELINE_MIN_YEAR && year <= SHORELINE_MAX_YEAR) {
        counts[year] = Number(row[i + 2]) || 0
      }
    })
    byCountry[country] = counts
  }
  return byCountry
}

// The 22 EEZ territories covered by the coastline dataset (see
// eez_territory), each with an approximate bounding box for fitBounds.
// Names match the weather-station CSV's own spelling where that dataset
// covers the territory, so selecting a nation also drives the
// weather-chart lookup directly - it just won't have any dots for the 4
// territories the CSV doesn't include (ASM, GUM, MNP, WLF).
// Approximate land-area bounds ([west, south, east, north]) for each
// territory's main island group - rough estimates from general geographic
// knowledge, not surveyed data, so treat them as a starting point rather
// than precise. A few (Kiribati, French Polynesia, Cook Islands, Pitcairn)
// have island groups scattered over enormous distances - these boxes
// cover only the main/most populous cluster, not every outlying island,
// since a true full-EEZ box would zoom out to mostly empty ocean.
// capital: approximate capital-city/island coordinate, for zooming in from
// the info card's capital circle - also a rough estimate, not surveyed.
// Capital and capital-island coordinates come from
// data/pacific_island_states_reference.csv ("Capital lat/lon" and "Island
// lat/lon" columns). islandBounds is not in that source (it only gives
// island label points, not extents) - it's the previous hand-estimated box
// for each island, re-centered on the sourced point. See the file's own
// notes for caveats; a few rows needed a judgment call rather than a
// literal copy - see comments below.
const NATIONS = [
  {
    code: 'ASM',
    name: 'American Samoa',
    bounds: [-171.2, -14.4, -169.4, -14.15],
    capital: [-170.703031, -14.273223],
    islandBounds: [-170.882529, -14.400755, -170.582529, -14.250755],
    capitalCityName: 'Pago Pago',
    capitalIslandName: 'Tutuila',
    population: 49710,
    landAreaKm2: 199,
    eezKm2: null,
  },
  {
    code: 'COK',
    name: 'Cook Islands',
    bounds: [-159.85, -21.3, -157.2, -18.7],
    capital: [-159.78501, -21.205684],
    islandBounds: [-159.841349, -21.259237, -159.711349, -21.199237],
    capitalCityName: 'Avarua',
    capitalIslandName: 'Rarotonga',
    population: 15040,
    landAreaKm2: 236.7,
    eezKm2: 1960027,
  },
  {
    code: 'FJI',
    name: 'Fiji',
    bounds: [177.0, -19.3, 180, -15.7],
    capital: [178.439908, -18.126556],
    islandBounds: [177.261847, -18.348319, 178.761847, -17.348319],
    capitalCityName: 'Suva',
    capitalIslandName: 'Viti Levu',
    population: 902623,
    landAreaKm2: 18272,
    eezKm2: 1282978,
  },
  {
    code: 'FSM',
    // name matches the weather-stations CSV's own spelling exactly, since
    // selectedCountry is used to look up station counts by that string.
    // displayName is what's actually shown on-screen.
    name: 'Micronesia, Federated State of',
    displayName: 'Federated State of Micronesia',
    bounds: [138.0, 1.0, 163.0, 10.0],
    capital: [158.158445, 6.92347],
    islandBounds: [157.904317, 6.626992, 158.654317, 7.276992],
    capitalCityName: 'Palikir',
    capitalIslandName: 'Pohnpei',
    population: 75817,
    landAreaKm2: 702,
    eezKm2: 2996419,
  },
  {
    code: 'GUM',
    name: 'Guam',
    bounds: [144.6, 13.2, 144.95, 13.7],
    capital: [144.754282, 13.476923],
    islandBounds: [144.522277, 13.132379, 144.872277, 13.632379],
    capitalCityName: 'Hagåtña',
    capitalIslandName: 'Guam (single island)',
    population: 153836,
    landAreaKm2: 544,
    eezKm2: null,
  },
  {
    code: 'KIR',
    name: 'Kiribati',
    bounds: [172.5, -3.0, 177.0, 3.5],
    capital: [173.0, 1.433333],
    islandBounds: [172.821662, 1.326817, 173.121662, 1.576817],
    capitalCityName: 'Tarawa (South Tarawa)',
    capitalIslandName: 'Tarawa Atoll',
    population: 120740,
    landAreaKm2: 811,
    eezKm2: 3441810,
  },
  {
    code: 'MHL',
    name: 'Marshall Islands',
    // Source flags: the gazetteer returns the same rounded point for both
    // the capital and the atoll, so city vs. island are not independently
    // sourced here.
    bounds: [160.5, 4.5, 172.5, 14.75],
    capital: [171.266667, 7.066667],
    islandBounds: [171.066667, 6.991667, 171.466667, 7.141667],
    capitalCityName: 'Majuro (Delap-Uliga-Djarrit)',
    capitalIslandName: 'Majuro Atoll',
    population: 42418,
    landAreaKm2: 181.3,
    eezKm2: 1990000,
  },
  {
    code: 'MNP',
    name: 'Northern Mariana Islands',
    bounds: [145.1, 14.9, 146.1, 20.6],
    capital: [145.751216, 15.214368],
    islandBounds: [145.661726, 15.095048, 145.831726, 15.275048],
    capitalCityName: 'Capitol Hill (Saipan)',
    capitalIslandName: 'Saipan',
    population: 47329,
    landAreaKm2: null,
    eezKm2: null,
  },
  {
    code: 'NCL',
    name: 'New Caledonia',
    bounds: [163.5, -22.7, 168.2, -19.5],
    capital: [166.439863, -22.271687],
    islandBounds: [163.084473, -22.910911, 167.784473, -19.710911],
    capitalCityName: 'Nouméa',
    capitalIslandName: 'Grande Terre',
    population: 264596,
    landAreaKm2: 18575,
    eezKm2: null,
  },
  {
    code: 'NIU',
    name: 'Niue',
    bounds: [-170.0, -19.15, -169.75, -18.95],
    capital: [-169.921365, -19.055836],
    islandBounds: [-169.992233, -19.154445, -169.742233, -18.954445],
    capitalCityName: 'Alofi',
    capitalIslandName: 'Niue (single island)',
    population: 1681,
    landAreaKm2: 260,
    eezKm2: 450000,
  },
  {
    code: 'NRU',
    name: 'Nauru',
    bounds: [166.88, -0.57, 166.98, -0.47],
    capital: [166.921091, -0.546686],
    islandBounds: [166.881503, -0.572778, 166.981503, -0.472778],
    capitalCityName: 'Yaren (de facto)',
    capitalIslandName: 'Nauru (single island)',
    population: 11680,
    landAreaKm2: 21,
    eezKm2: 308480,
  },
  {
    code: 'PCN',
    name: 'Pitcairn',
    // Source's "Island lat/lon" is flagged as wrong for this row - it's the
    // centroid of the whole 4-island group, not Pitcairn Island itself. Its
    // own note says Pitcairn Island is essentially the Adamstown/capital
    // coordinate, so that's used for both here instead of the raw column.
    bounds: [-130.85, -25.15, -124.5, -23.9],
    capital: [-130.099664, -25.066205],
    islandBounds: [-130.149664, -25.091205, -130.049664, -25.041205],
    capitalCityName: 'Adamstown',
    capitalIslandName: 'Pitcairn Island',
    population: 35,
    landAreaKm2: null,
    eezKm2: 836000,
  },
  {
    code: 'PLW',
    name: 'Palau',
    bounds: [131.1, 2.8, 134.7, 8.1],
    capital: [134.624289, 7.500384],
    islandBounds: [134.479023, 7.434209, 134.659023, 7.554209],
    capitalCityName: 'Ngerulmud',
    capitalIslandName: 'Babeldaob',
    population: 16733,
    landAreaKm2: 459,
    eezKm2: 603978,
  },
  {
    code: 'PNG',
    name: 'Papua New Guinea',
    // Source's "Island lat/lon" is flagged as wrong for PNG - it's the
    // centroid of the whole island of New Guinea (shared with Indonesia)
    // and falls across the border, outside PNG. Left as the prior estimate
    // around Port Moresby rather than using that point; needs a real fix.
    bounds: [140.8, -11.7, 155.97, -0.9],
    capital: [147.149416, -9.479004],
    islandBounds: [146.8, -9.7, 147.5, -9.2],
    capitalCityName: 'Port Moresby',
    capitalIslandName: 'New Guinea (mainland)',
    population: 10185363,
    landAreaKm2: 462840,
    eezKm2: 2402288,
  },
  {
    code: 'PYF',
    name: 'French Polynesia',
    bounds: [-154.7, -27.9, -134.4, -7.8],
    capital: [-149.567715, -17.532461],
    islandBounds: [-149.701042, -17.85092, -149.151042, -17.45092],
    capitalCityName: 'Papeete',
    capitalIslandName: 'Tahiti',
    population: 279500,
    landAreaKm2: null,
    eezKm2: null,
  },
  {
    code: 'SLB',
    name: 'Solomon Islands',
    bounds: [155.5, -11.9, 166.9, -5.0],
    capital: [159.952676, -9.43067],
    islandBounds: [159.645581, -9.877328, 160.645581, -9.277328],
    capitalCityName: 'Honiara',
    capitalIslandName: 'Guadalcanal',
    population: 750325,
    landAreaKm2: 29000,
    eezKm2: 1589477,
  },
  {
    code: 'TKL',
    name: 'Tokelau',
    // Source: Tokelau has no capital - government rotates yearly among its
    // three atolls, so the capital columns are genuinely empty there. Using
    // the Fakaofo atoll point (the source's primary island point) for both
    // fields as the closest available stand-in.
    bounds: [-172.5, -9.5, -171.0, -8.4],
    capital: [-171.218835, -9.380256],
    islandBounds: [-172.5, -9.5, -171.0, -8.4],
    capitalCityName: 'None (rotates annually)',
    capitalIslandName: 'Fakaofo / Nukunonu / Atafu',
    population: 2608,
    landAreaKm2: 10,
    eezKm2: 319031,
  },
  {
    code: 'TON',
    name: 'Tonga',
    bounds: [-176.3, -22.4, -173.7, -15.5],
    capital: [-175.200486, -21.134306],
    islandBounds: [-175.451548, -21.271597, -175.051548, -21.021597],
    capitalCityName: "Nuku'alofa",
    capitalIslandName: 'Tongatapu',
    population: 100179,
    landAreaKm2: 749,
    eezKm2: 659558,
  },
  {
    code: 'TUV',
    name: 'Tuvalu',
    bounds: [176.0, -10.8, 179.9, -5.6],
    capital: [179.196193, -8.521147],
    islandBounds: [179.122972, -8.570475, 179.272972, -8.470475],
    capitalCityName: 'Funafuti',
    capitalIslandName: 'Fongafale islet, Funafuti Atoll',
    population: 10643,
    landAreaKm2: 30,
    eezKm2: 749790,
  },
  {
    code: 'VUT',
    name: 'Vanuatu',
    bounds: [166.5, -20.3, 169.9, -13.1],
    capital: [168.317303, -17.742979],
    islandBounds: [168.254719, -17.782748, 168.604719, -17.532748],
    capitalCityName: 'Port Vila',
    capitalIslandName: 'Efate',
    population: 321409,
    landAreaKm2: 12189,
    eezKm2: 663251,
  },
  {
    code: 'WLF',
    name: 'Wallis and Futuna',
    // Source notes Futuna is a separate, non-contiguous island group from
    // Wallis/Uvea (where the capital sits), so the island box is now
    // tightened to Uvea alone instead of the old placeholder that reused
    // the full two-island-group country bounds.
    bounds: [-178.3, -14.4, -176.1, -13.2],
    capital: [-176.176448, -13.282509],
    islandBounds: [-176.355684, -13.395911, -176.055684, -13.195911],
    capitalCityName: 'Mata-Utu',
    capitalIslandName: 'Uvea (Wallis Island)',
    population: 11620,
    landAreaKm2: 142.4,
    eezKm2: null,
  },
  {
    code: 'WSM',
    name: 'Samoa',
    bounds: [-172.8, -14.1, -171.4, -13.4],
    capital: [-171.768909, -13.831609],
    islandBounds: [-172.084942, -14.063408, -171.384942, -13.763408],
    capitalCityName: 'Apia',
    capitalIslandName: 'Upolu',
    population: 205557,
    landAreaKm2: null,
    eezKm2: null,
  },
]

function formatStat(value, unit = '') {
  return value == null ? '—' : `${value.toLocaleString()}${unit}`
}

// Tiny inline mock-ups of the map's own visuals, used as icons in the
// legend text. Coastline: the current-year line (matches
// shorelines-current's #ffd166) with two fainter trailing lines behind it
// (matches shorelines-trail's fade). Tick: three short perpendicular
// marks, deliberately not parallel/evenly spaced/same-length - mimicking
// the real per-point rate_time ticks rather than a tidy icon.
function CoastlineLegendIcon() {
  return (
    <svg className="legend-icon legend-icon-coastline" viewBox="0 0 25 20" aria-hidden="true">
      <path d="M0,5 Q6.25,2.5 12.5,5 Q18.75,7.5 25,5" fill="none" stroke="#ffd166" strokeWidth="1.5" />
      <path d="M0,8 Q6.25,5.5 12.5,8 Q18.75,10.5 25,8" fill="none" stroke="#ffd166" strokeWidth="1" opacity="0.6" />
      <path d="M0,11 Q6.25,8.5 12.5,11 Q18.75,13.5 25,11" fill="none" stroke="#ffd166" strokeWidth="1" opacity="0.4" />
      <path
        d="M0,14 Q6.25,11.5 12.5,14 Q18.75,16.5 25,14"
        fill="none"
        stroke="#ffd166"
        strokeWidth="1"
        opacity="0.25"
      />
    </svg>
  )
}

function TickLegendIcon({ color }) {
  return (
    <svg className="legend-icon" viewBox="0 0 15 15" aria-hidden="true">
      <line x1="2" y1="1.5" x2="4" y2="11" stroke={color} strokeWidth="1.5" />
      <line x1="7" y1="0.5" x2="8.5" y2="12" stroke={color} strokeWidth="1.5" />
      <line x1="11" y1="3" x2="13.5" y2="10" stroke={color} strokeWidth="1.5" />
    </svg>
  )
}

const HOTSPOT_CSV_URL = `${import.meta.env.BASE_URL}data/hotspot-information.csv`

// Shown in place of a country/hotspot name before the user has picked a
// nation button - no country selected on initial load.
const DEFAULT_COUNTRY_LABEL = 'Nations of the Pacific'

// The hotspot CSV's own country names don't always match NATIONS' spelling
// (it appends the administering state, e.g. "Micronesia (FSM)"). Map those
// to the matching NATIONS name; anything not listed here that also isn't
// already an exact NATIONS name (e.g. "United States (Hawaii)", "Australia
// (Torres Strait)", the regional "Pacific & Indian Oceans" row) falls
// outside our 22-nation selection and gets dropped.
const HOTSPOT_COUNTRY_ALIASES = {
  'French Polynesia (France)': 'French Polynesia',
  'Micronesia (FSM)': 'Micronesia, Federated State of',
  'Tokelau (New Zealand)': 'Tokelau',
  'American Samoa (United States)': 'American Samoa',
  'United States (Guam)': 'Guam',
}

function parseHotspotCsv(text) {
  const rows = csvParseRows(text)
  return rows
    .slice(1)
    .filter((row) => row.length > 1 && row[2])
    .map((row) => {
      const country = HOTSPOT_COUNTRY_ALIASES[row[3]] ?? row[3]
      return {
        impactDirection: row[0],
        status: row[1],
        location: row[2],
        country,
        subRegion: row[4],
        // row[5]/row[6] are blank (not "0") for national/regional/dispersed
        // or unverified entries - Number("") is 0, not NaN, which would
        // otherwise silently plot those at (0,0) ("null island").
        lat: row[5] ? Number(row[5]) : null,
        lon: row[6] ? Number(row[6]) : null,
        coordinatePrecision: row[7],
        coordinateNote: row[8],
        description: row[9],
        source: row[10],
        sourceUrl: row[11],
      }
    })
    .filter((hotspot) => NATIONS.some((n) => n.name === hotspot.country))
}

// Left-chart diverging bars: each bar has its own fixed +/- scale,
// independent of the data's own range.
const SEA_LEVEL_SCALE_MAX = 0.3
const SEA_LEVEL_TICK_STEP = 0.1
const SEA_TEMPERATURE_SCALE_MAX = 3
const SEA_TEMPERATURE_TICK_STEP = 1

// Index-based (not repeated subtraction) to avoid floating-point drift
// across iterations, plus a final rounding pass to clean up the residual
// noise floating-point math still leaves on values like 0.3 (e.g. 3 * 0.1
// === 0.30000000000000004 in JS).
function buildLeftChartTicks(scaleMax, step) {
  const count = Math.round((2 * scaleMax) / step) + 1
  const ticks = []
  for (let i = 0; i < count; i++) {
    const v = scaleMax - i * step
    ticks.push(Math.round(v * 1e6) / 1e6 || 0)
  }
  return ticks
}

const SEA_LEVEL_TICKS = buildLeftChartTicks(SEA_LEVEL_SCALE_MAX, SEA_LEVEL_TICK_STEP)
const SEA_TEMPERATURE_TICKS = buildLeftChartTicks(SEA_TEMPERATURE_SCALE_MAX, SEA_TEMPERATURE_TICK_STEP)

function leftChartValueFor(data, country, year) {
  return data?.values.find((d) => d.country === country && d.year === year)?.value ?? null
}

function leftChartFillPct(value, scaleMax) {
  return value == null ? 0 : (Math.min(Math.abs(value), scaleMax) / scaleMax) * 50
}

// Wavy edge for the sea-level bar's fill, like a water surface - one
// crest/trough cycle across a 0-100 wide, 0-20 tall viewBox (stretched to
// fit via preserveAspectRatio="none"), baseline at y=10 with a shallow
// +/-2.5 swing. WAVE_PATH fills down to the bottom of the box (positive
// fill, growing upward from the zero line - wave sits at its far/top
// edge); WAVE_PATH_NEGATIVE is the mirror, filling up to the top of the
// box (negative fill, growing downward - wave sits at its far/bottom
// edge).
const WAVE_PATH = 'M0,10 Q25,7.5 50,10 Q75,12.5 100,10 L100,20 L0,20 Z'
const WAVE_PATH_NEGATIVE = 'M0,10 Q25,7.5 50,10 Q75,12.5 100,10 L100,0 L0,0 Z'

// Connector lines from each left-chart bar's bottom-middle down to its
// matching heatmap's left-border middle: straight down, a 45-degree
// diagonal, then a fixed 50px horizontal run touching the heatmap (the
// diagonal's own run/drop is whatever's left over so the last segment
// lands exactly on the heatmap's left border). Coordinates are in the
// 1920pt reference frame (same one every cqw measurement in this file is
// derived from), computed from the exact geometry of .left-chart,
// .left-chart-bar (incl. its margin-left), .heatmap-chart-container and
// .heatmap-chart-container-2 - see App.css for those values if this ever
// needs recalculating by hand. The sea-level bar (x=59.13) now targets the
// second heatmap slot and the temperature bar (x=149.37) targets the
// first, since the two heatmaps' on-screen positions were swapped.
// viewBox height = .map-outer's height in the 1920pt frame, so path coords
// map 1:1. .map-outer is calc(240 + --tl-note-h + --conclusion-h -
// --meteo-tighten)cqw = (240 + 16 + 24 - 4.5937)cqw = 275.4063cqw ->
// * 19.2 = 5287.8. Points below the timeline are shifted down 16cqw
// (307.2pt) for .timeline-note; the weather->station connector's target
// end is then pulled up 4.5937cqw (88.2pt) with the meteo chart.
const MAP_OUTER_VIEWBOX_HEIGHT = 5287.8
const BAR_TO_HEATMAP_LINE_1 = 'M 59.13 1019.00 L 59.13 2845.83 L 219.50 3006.20 L 269.50 3006.20'
const BAR_TO_HEATMAP_LINE_2 = 'M 149.37 1019.00 L 149.37 2109.07 L 219.50 2179.20 L 269.50 2179.20'

// Same line style, mirrored: from the weather-station dot chart's (right
// of the map) bottom-middle down to the weather-station chart section's
// (further below the heatmaps) right-border middle - so the diagonal
// bends down-left instead of down-right, and the final 50px run touches
// the target's right border instead of its left.
const WEATHER_CHART_TO_STATION_CHART_LINE = 'M 1773.00 1099.50 L 1773.00 3640.50 L 1455.50 3958.00 L 1405.50 3958.00'

// Annotation pointer: from just right of the "Sidenote on mangroves" title
// (~x627, y1486), a short run right, a 45-degree elbow up-right, then a
// fixed 50pt vertical run up to just under the mangrove timeline toggle
// circle (center x724.5, bottom ~y1358), capped with an upward arrowhead
// matching the timeline connectors' (6pt point / 8pt base). Same 1920pt
// frame as the lines above; button geometry = .timeline-container (left
// 269.5) + .timeline-text (300) + .timeline-toggle-circle-2 (left 125,
// size 60), .timeline-container top 1173.5 + circle top 125.
const NOTE_TO_MANGROVE_LINE = 'M 627 1486 L 679.5 1486 L 724.5 1441 L 724.5 1373'
const NOTE_TO_MANGROVE_ARROW = 'M 724.5 1367 L 720.5 1373 L 728.5 1373 Z'

// Map section: an info card (pentagon, bottom-right corner diagonally cut)
// and nation-select column on top, then the map shape below - anchored at
// the nation column's bottom-left point, tucking up into the row above.
// Everything except the working map itself is still a placeholder.
export default function MapSection() {
  const mapContainer = useRef(null)
  const mapRef = useRef(null)
  const mapLoadedRef = useRef(false)
  const track1Ref = useRef(null)
  const track2Ref = useRef(null)
  const miniTrack1Ref = useRef(null)
  const miniTrack2Ref = useRef(null)
  const miniTrack3Ref = useRef(null)
  const [year, setYear] = useState(SHORELINE_MAX_YEAR)
  const [mapZoom, setMapZoom] = useState(null)
  const [activeTimeline, setActiveTimeline] = useState(1)
  const [stationCounts, setStationCounts] = useState(null)
  const [seaLevelData, setSeaLevelData] = useState(null)
  const [seaTemperatureData, setSeaTemperatureData] = useState(null)
  const [hotspotData, setHotspotData] = useState(null)
  const [selectedCountry, setSelectedCountry] = useState(null)
  const [selectedHotspot, setSelectedHotspot] = useState(null)
  const countryHotspots = (hotspotData ?? []).filter((h) => h.country === selectedCountry).slice(0, 5)
  const selectedHotspotData = countryHotspots.find((h) => h.location === selectedHotspot) ?? null
  const selectedNation = NATIONS.find((n) => n.name === selectedCountry)
  const seaLevelValue = leftChartValueFor(seaLevelData, selectedCountry, year)
  const seaLevelFillPct = leftChartFillPct(seaLevelValue, SEA_LEVEL_SCALE_MAX)
  // Both fills stay permanently mounted (rather than conditionally rendered
  // on sign) so that crossing zero animates smoothly via the height
  // transition - one side eases down to 0 while the other eases up from
  // it, instead of the DOM swapping elements and jumping instantly.
  const seaLevelPositivePct = seaLevelValue != null && seaLevelValue >= 0 ? seaLevelFillPct : 0
  const seaLevelNegativePct = seaLevelValue != null && seaLevelValue < 0 ? seaLevelFillPct : 0
  const seaTemperatureValue = leftChartValueFor(seaTemperatureData, selectedCountry, year)
  const seaTemperatureFillPct = leftChartFillPct(seaTemperatureValue, SEA_TEMPERATURE_SCALE_MAX)

  // Isotype chart data: one circle per station a country has *as of* that
  // year (the CSV's own cumulative total), not per station added that
  // year - so a country with 1 station in 1999 that grows to 2 by some
  // later year shows 1 circle, then 2, etc., non-decreasing across years.
  const weatherStationIsotypeData = useMemo(() => {
    if (!stationCounts) return null
    const countries = Object.keys(stationCounts).filter((c) => c !== 'Grand Total')
    const years = []
    for (let y = SHORELINE_MIN_YEAR; y <= SHORELINE_MAX_YEAR; y++) years.push(y)
    const values = countries.flatMap((country) =>
      years.map((y) => ({ country, year: y, count: stationCounts[country][y] ?? 0 })),
    )
    return { countries, years, values }
  }, [stationCounts])

  useEffect(() => {
    let cancelled = false
    fetch(WEATHER_STATIONS_CSV_URL)
      .then((res) => res.text())
      .then((text) => {
        if (!cancelled) setStationCounts(parseWeatherStationCounts(text))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch(SEA_LEVEL_CSV_URL)
      .then((res) => res.text())
      .then((text) => {
        if (!cancelled) setSeaLevelData(parseAnomalyCsv(text))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch(SEA_TEMPERATURE_CSV_URL)
      .then((res) => res.text())
      .then((text) => {
        if (!cancelled) setSeaTemperatureData(parseAnomalyCsv(text))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch(HOTSPOT_CSV_URL)
      .then((res) => res.text())
      .then((text) => {
        if (!cancelled) setHotspotData(parseHotspotCsv(text))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const ourSources = {
      coastlines: {
        type: 'vector',
        url: PMTILES_URL,
      },
      [HILLSHADE_SOURCE_ID]: HILLSHADE_SOURCE,
    }

    const ourLayers = [
      {
        id: 'shorelines-background',
        type: 'line',
        source: 'coastlines',
        'source-layer': 'shorelines_annual',
        filter: ['==', ['get', 'year'], SHORELINE_MAX_YEAR],
        paint: {
          'line-color': '#5a6b8c',
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 2, 8, 1.2],
          'line-opacity': 0.35,
        },
      },
      {
        id: 'shorelines-trail',
        type: 'line',
        source: 'coastlines',
        'source-layer': 'shorelines_annual',
        filter: ['in', ['get', 'year'], ['literal', [2020, 2021, 2022]]],
        paint: {
          'line-color': '#ffd166',
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 3.5, 8, 2],
          'line-opacity': [
            'interpolate',
            ['linear'],
            ['-', SHORELINE_MAX_YEAR, ['get', 'year']],
            1,
            0.45,
            TRAIL_LENGTH,
            0.05,
          ],
        },
      },
      {
        id: 'shorelines-current',
        type: 'line',
        source: 'coastlines',
        'source-layer': 'shorelines_annual',
        filter: ['==', ['get', 'year'], SHORELINE_MAX_YEAR],
        paint: {
          'line-color': '#ffd166',
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 3.5, 8, 2],
          'line-opacity': 0.9,
        },
      },
      ...CHANGE_TICKS_LAYERS,
    ]

    fetch(OPENFREEMAP_STYLE_URL)
      .then((res) => res.json())
      .then((basemapStyle) => {
        if (cancelled) return

        const recoloredLayers = recolorBasemapLayers(basemapStyle.layers)

        // Keep basemap text/icon labels (place names, country names, water
        // names, ...) above our own data layers so they stay legible.
        const baseLayers = recoloredLayers.filter((l) => l.type !== 'symbol')
        const labelLayers = recoloredLayers.filter((l) => l.type === 'symbol')

        const map = new MapLibreMap({
          container: mapContainer.current,
          style: {
            version: 8,
            glyphs: basemapStyle.glyphs,
            sprite: basemapStyle.sprite,
            sources: { ...basemapStyle.sources, ...ourSources },
            layers: [...baseLayers, HILLSHADE_LAYER, OCEAN_MASK_LAYER, ...ourLayers, ...labelLayers],
          },
          // Whole-Pacific overview on load, framing the coastline data's
          // real extent (PMTiles header: lat -27.9 to 20.6, and the 22
          // NATIONS bounds collectively span roughly Palau (131E) to
          // Pitcairn (124.5W), crossing the antimeridian) - centered near
          // the dateline rather than any single curated country, shifted
          // east to show more of French Polynesia/Pitcairn.
          center: [-165, -4],
          zoom: 3,
          attributionControl: false,
        })
        map.addControl(new AttributionControl({ compact: true }), 'top-right')
        // The compact AttributionControl auto-expands itself the first time
        // attributions populate (it only does so while it lacks the
        // "maplibregl-compact" class). Add that class up front so it starts
        // - and stays - collapsed until the user clicks it open.
        const attribEl = mapContainer.current?.querySelector('.maplibregl-ctrl-attrib')
        if (attribEl) {
          attribEl.classList.add('maplibregl-compact')
          attribEl.classList.remove('maplibregl-compact-show')
          attribEl.removeAttribute('open')
        }

        mapRef.current = map
        setMapZoom(map.getZoom())
        map.on('zoom', () => setMapZoom(map.getZoom()))
        map.on('load', () => {
          mapLoadedRef.current = true
          setupTickIcons(map)
          setupTickHover(map)
          setupMangroveLayers(map)
          setupHeatLayers(map)
          setupHotspotLayer(map)
          updateYearLayers(map, SHORELINE_MAX_YEAR, false)
        })
      })

    return () => {
      cancelled = true
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
      }
      mapLoadedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!mapRef.current || !mapLoadedRef.current) return
    updateYearLayers(mapRef.current, year, activeTimeline === 2)
  }, [year, activeTimeline])

  useEffect(() => {
    if (!mapRef.current || !mapLoadedRef.current) return
    updateHotspotLayer(mapRef.current, countryHotspots)
    // countryHotspots is derived from hotspotData/selectedCountry every
    // render, so depend on those directly instead - a fresh array
    // reference each render would otherwise re-run this every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotspotData, selectedCountry])

  useEffect(() => {
    const el = mapContainer.current
    if (!el) return
    const observer = new ResizeObserver(() => mapRef.current?.resize())
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="map-outer">
      <div className="map-section-top-row">
        <div className="info-card">
          <div className="info-box info-box-name">
            <FitTextLine>{selectedNation?.displayName ?? selectedCountry ?? DEFAULT_COUNTRY_LABEL}</FitTextLine>
          </div>
          <div className="info-box info-box-capitals">
            <div className="info-box-capitals-row">
              <span>Capital island: {selectedNation?.capitalIslandName ?? '—'}</span>
              <div
                className="info-box-capitals-circle"
                role="button"
                tabIndex={0}
                onClick={() => {
                  const nation = NATIONS.find((n) => n.name === selectedCountry)
                  if (nation) mapRef.current?.fitBounds(nation.islandBounds, { padding: 40 })
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  const nation = NATIONS.find((n) => n.name === selectedCountry)
                  if (nation) mapRef.current?.fitBounds(nation.islandBounds, { padding: 40 })
                }}
              />
            </div>
            <div className="info-box-capitals-row">
              <span>Capital city: {selectedNation?.capitalCityName ?? '—'}</span>
              <div
                className="info-box-capitals-circle"
                role="button"
                tabIndex={0}
                onClick={() => {
                  const nation = NATIONS.find((n) => n.name === selectedCountry)
                  if (nation) mapRef.current?.flyTo({ center: nation.capital, zoom: 12 })
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  const nation = NATIONS.find((n) => n.name === selectedCountry)
                  if (nation) mapRef.current?.flyTo({ center: nation.capital, zoom: 12 })
                }}
              />
            </div>
          </div>
          <div className="info-box info-box-stats">
            <span>Population: {formatStat(selectedNation?.population)}</span>
            <span>Land mass size: {formatStat(selectedNation?.landAreaKm2, ' km²')}</span>
            <span>EEZ size: {formatStat(selectedNation?.eezKm2, ' km²')}</span>
          </div>
          <div className="info-box info-box-hotspots">
            <span className="hotspot-section-title">Hot Spots &amp; Spots of Interest</span>
            <div className="hotspot-list">
              {countryHotspots.map((hotspot) => {
                const selectHotspot = () => {
                  setSelectedHotspot(hotspot.location)
                  if (Number.isFinite(hotspot.lat) && Number.isFinite(hotspot.lon)) {
                    mapRef.current?.flyTo({ center: [hotspot.lon, hotspot.lat], zoom: 10 })
                  } else if (selectedNation) {
                    // No point of its own (national/regional/dispersed scope,
                    // e.g. "Fiji (national)") - fall back to the selected
                    // nation's own capital coordinate.
                    mapRef.current?.flyTo({ center: selectedNation.capital, zoom: 10 })
                  }
                }
                return (
                  <div
                    className={`hotspot-row${selectedHotspot === hotspot.location ? ' active' : ''}`}
                    key={hotspot.location}
                    role="button"
                    tabIndex={0}
                    onClick={selectHotspot}
                    onKeyDown={(e) => e.key === 'Enter' && selectHotspot()}
                  >
                    <div
                      className={`hotspot-circle${hotspot.impactDirection !== 'Negative' ? ' hotspot-circle-interest' : ''}`}
                    />
                    <span className="hotspot-name">{hotspot.location}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
        <div className="nation-column">
          <div className="nation-buttons">
            <div className="nation-buttons-title">
              <span>Nations of the Pacific</span>
            </div>
            <div className="nation-buttons-grid">
              {NATIONS.map((nation) => (
                <button
                  type="button"
                  className={`nation-button${selectedCountry === nation.name ? ' active' : ''}`}
                  key={nation.code}
                  lang="en"
                  onClick={() => {
                    setSelectedCountry(nation.name)
                    setSelectedHotspot(null)
                    mapRef.current?.fitBounds(nation.bounds, { padding: 40 })
                  }}
                >
                  <FitText className="nation-button-label">{nation.displayName ?? nation.name}</FitText>
                </button>
              ))}
            </div>
          </div>
          <div className="hotspot-info">
            <div className="hotspot-info-name">
              <FitTextBlock className="hotspot-info-name-text">
                {selectedHotspot ?? selectedNation?.displayName ?? selectedCountry ?? DEFAULT_COUNTRY_LABEL}
              </FitTextBlock>
              {selectedHotspotData && (
                <a href={selectedHotspotData.sourceUrl} target="_blank" rel="noreferrer">
                  {selectedHotspotData.source}
                </a>
              )}
            </div>
            <div className="hotspot-info-text">
              {selectedHotspotData?.description && <p>{selectedHotspotData.description}</p>}
            </div>
          </div>
        </div>
      </div>
      <div className="left-chart">
        <div className="left-chart-bar">
          <span className="left-chart-bar-sign left-chart-bar-sign-plus">+</span>
          <span className="left-chart-bar-sign left-chart-bar-sign-minus">−</span>
          <div className="left-chart-bar-ticks">
            {SEA_LEVEL_TICKS.map((v) => (
              <span
                key={v}
                className="left-chart-bar-tick"
                style={{ top: `${50 - (v / SEA_LEVEL_SCALE_MAX) * 50}%` }}
              >
                {v}
              </span>
            ))}
          </div>
          <div className="left-chart-bar-zero" />
          <svg
            className="left-chart-bar-fill left-chart-bar-fill-positive"
            style={{ height: `${seaLevelPositivePct}%` }}
            viewBox="0 0 100 20"
            preserveAspectRatio="none"
          >
            <path d={WAVE_PATH} fill="#b2182b" />
          </svg>
          <svg
            className="left-chart-bar-fill left-chart-bar-fill-negative"
            style={{ height: `${seaLevelNegativePct}%` }}
            viewBox="0 0 100 20"
            preserveAspectRatio="none"
          >
            <path d={WAVE_PATH_NEGATIVE} fill="#2166ac" />
          </svg>
          <div className="left-chart-bar-title">
            <span>Sea Level Anomaly (m)</span>
          </div>
        </div>
        <div className="left-chart-bar">
          <span className="left-chart-bar-sign left-chart-bar-sign-plus">+</span>
          <span className="left-chart-bar-sign left-chart-bar-sign-minus">−</span>
          <div className="left-chart-bar-ticks">
            {SEA_TEMPERATURE_TICKS.map((v) => (
              <span
                key={v}
                className="left-chart-bar-tick"
                style={{ top: `${50 - (v / SEA_TEMPERATURE_SCALE_MAX) * 50}%` }}
              >
                {v}
              </span>
            ))}
          </div>
          <div className="left-chart-bar-zero" />
          {seaTemperatureValue != null && seaTemperatureValue >= 0 && (
            <div
              className="left-chart-bar-fill left-chart-bar-fill-positive left-chart-bar-fill-temperature-wrap"
              style={{ height: `calc(${seaTemperatureFillPct}% + 1.4cqw)` }}
            >
              <div className="left-chart-bar-fill-temperature" />
            </div>
          )}
          {seaTemperatureValue != null && seaTemperatureValue < 0 && (
            <div
              className="left-chart-bar-fill left-chart-bar-fill-negative left-chart-bar-fill-temperature-negative"
              style={{ height: `${seaTemperatureFillPct}%` }}
            />
          )}
          <div className="left-chart-bar-title">
            <span>Sea Temperature Anomaly (°C)</span>
          </div>
        </div>
      </div>
      <div className="map-shape">
        <div id="map" ref={mapContainer} />
        <svg className="map-shape-diagonals" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path
            className="map-shape-diagonal-top-left"
            d="M 10.5452 0 L 0 23.3045"
            fill="none"
            stroke="#000"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          <path
            className="map-shape-diagonal-bottom-left"
            d="M 0 92.3521 L 3.553 100.2041"
            fill="none"
            stroke="#000"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="map-year-label">{year}</div>
        {mapZoom != null && <div className="map-zoom-label">z{mapZoom.toFixed(2)}</div>}
      </div>
      <div className="weather-chart">
        {stationCounts &&
          (() => {
            const counts = stationCounts[selectedCountry] ?? {}
            // 15px padding on every side of each dot: horizontally that
            // fixes the diameter (chart is 50px wide, so 50-2*15=20px),
            // vertically it's the gap stacking dots from the top down.
            const diameterPx = 20
            const pitchPx = diameterPx + 15
            const firstCenterPx = 15 + diameterPx / 2
            return Array.from({ length: counts[year] ?? 0 }, (_, i) => (
              <span
                key={i}
                className="weather-station-dot"
                style={{ top: `${((firstCenterPx + i * pitchPx) / 1920) * 100}cqw` }}
              />
            ))
          })()}
        <div className="weather-chart-title">
          <span>Meteorological Stations (cumulative)</span>
        </div>
      </div>
      <div className="legend">
        <div className="legend-text">
          <span>
            <CoastlineLegendIcon />
            Coastline position for the selected year, with earlier positions shown.
          </span>
          <span>
            <TickLegendIcon color="#2166ac" />
            Positive and
            <TickLegendIcon color="#b2182b" />
            negative shoreline change in meters/year at each point, from a linear regression fit through its
            historical positions.
          </span>
        </div>
      </div>
      <div className="timeline-container">
        <div className="timeline-text">
          <span>
            The main timeline shows the evolution of the shorelines without the mangroves, as the available
            time range was too short. The option to view the map with mangroves is available for those who may
            find it of interest.
          </span>
        </div>
        <div className="timeline-right">
          <button
            type="button"
            className={`timeline-toggle-circle${activeTimeline === 1 ? ' active' : ''}`}
            onClick={() => setActiveTimeline(1)}
            aria-label="Show shoreline evolution timeline"
          >
            <span className="timeline-toggle-tooltip">Click to change timeline</span>
          </button>
          <div className={`timeline-group${activeTimeline === 1 ? '' : ' faded'}`}>
            <div className="timeline-info-label">
              <span>Shoreline</span>
              <span>Evolution</span>
            </div>
            <div className="timeline-connector timeline-connector-1" />
            <div
              className="timeline-track-1"
              ref={track1Ref}
              onPointerDown={(e) => {
                setActiveTimeline(1)
                setYear(yearFromPointerX(e.clientX, e.currentTarget, SHORELINE_MIN_YEAR, SHORELINE_MAX_YEAR))
              }}
            />
            {YEAR_TICKS.map((left) => (
              <div key={left} className="timeline-year-tick timeline-year-tick-1" style={{ left: `${left}cqw` }} />
            ))}
            <div className="timeline-end-circle timeline-end-circle-1-start" />
            <div className="timeline-end-circle timeline-end-circle-1-end" />
            <span className="timeline-date timeline-date-1-start">1999</span>
            <span className="timeline-date timeline-date-1-end">2023</span>
            <div
              className="timeline-handle"
              style={{
                left: `${yearToLeftCqw(year, 265, 877, SHORELINE_MIN_YEAR, SHORELINE_MAX_YEAR)}cqw`,
                top: '3.6458cqw',
              }}
              onPointerDown={(e) => {
                setActiveTimeline(1)
                e.currentTarget.setPointerCapture(e.pointerId)
              }}
              onPointerMove={(e) => {
                if (e.buttons !== 1 || !track1Ref.current) return
                setYear(yearFromPointerX(e.clientX, track1Ref.current, SHORELINE_MIN_YEAR, SHORELINE_MAX_YEAR))
              }}
            />
          </div>
          <button
            type="button"
            className={`timeline-toggle-circle timeline-toggle-circle-2${activeTimeline === 2 ? ' active' : ''}`}
            onClick={() => {
              setActiveTimeline(2)
              setYear((y) => (y < MANGROVE_MIN_YEAR ? MANGROVE_MIN_YEAR : y))
            }}
            aria-label="Show shoreline and mangrove evolution timeline"
          >
            <span className="timeline-toggle-tooltip">Click to change timeline</span>
          </button>
          <div className={`timeline-group${activeTimeline === 2 ? '' : ' faded'}`}>
            <div className="timeline-info-label timeline-info-label-2">
              <span>Shoreline</span>
              <span>&amp;</span>
              <span>Mangrove</span>
              <span>
                Evolution
                <a className="source-ref" href="#source-2">
                  2
                </a>
              </span>
            </div>
            <div className="timeline-connector timeline-connector-2" />
            <div
              className="timeline-track-2"
              ref={track2Ref}
              onPointerDown={(e) => {
                setActiveTimeline(2)
                setYear(yearFromPointerX(e.clientX, e.currentTarget, MANGROVE_MIN_YEAR, SHORELINE_MAX_YEAR))
              }}
            />
            {MANGROVE_YEAR_TICKS.map((left) => (
              <div key={left} className="timeline-year-tick timeline-year-tick-2" style={{ left: `${left}cqw` }} />
            ))}
            <div className="timeline-end-circle timeline-end-circle-2-start" />
            <div className="timeline-end-circle timeline-end-circle-2-end" />
            <span className="timeline-date timeline-date-2-start">2017</span>
            <span className="timeline-date timeline-date-2-end">2023</span>
            <div
              className="timeline-handle timeline-handle-2"
              style={{
                left: `${yearToLeftCqw(year, 922.75, 219.25, MANGROVE_MIN_YEAR, SHORELINE_MAX_YEAR)}cqw`,
                top: '8.0729cqw',
              }}
              onPointerDown={(e) => {
                setActiveTimeline(2)
                e.currentTarget.setPointerCapture(e.pointerId)
              }}
              onPointerMove={(e) => {
                if (e.buttons !== 1 || !track2Ref.current) return
                setYear(yearFromPointerX(e.clientX, track2Ref.current, MANGROVE_MIN_YEAR, SHORELINE_MAX_YEAR))
              }}
            />
          </div>
        </div>
      </div>
      <div className="timeline-note">
        <h3 className="timeline-note-title">Sidenote on mangroves</h3>
        <div className="timeline-note-body">
          <p>
            Mangroves are trees and shrubs that grow along tropical and subtropical coastlines, where their
            roots are regularly exposed to seawater and tides. Their dense root systems help stabilize
            shorelines by holding sediment in place and reducing erosion. They can also slow waves and lessen
            the impact of storm surges, helping to protect coastal communities from flooding. As sea levels
            rise, mangroves provide a natural barrier between the ocean and the land, making them an important
            part of coastal protection in the Pacific.
          </p>
          <p>
            As an addition to the main project, a small dataset allows users to explore mangrove coverage
            across the Pacific and better understand the role these ecosystems can play in protecting
            vulnerable coastlines, in relation to the evolution of shorelines.
          </p>
        </div>
      </div>
      <div className="map-section-gap" />
      <div className="heatmap-title">
        <span>
          Sea Temperature Anomaly (°C)
          <a className="source-ref" href="#source-3">
            3
          </a>
        </span>
      </div>
      <div className="heatmap-chart-container">
        <AnomalyHeatmap csvUrl={SEA_TEMPERATURE_CSV_URL} unit="°C" activeYear={year} />
      </div>
      <div className="heatmap-side-text">
        <span>Heatmap side text</span>
      </div>
      <div className="timeline-container-2">
        <div className="mini-timeline-wrap">
          {/* Full 1850-2025 scale, shown but mostly inaccessible - only the
              1999-2023 sub-range (matching the shared timeline) is
              draggable. The dark segment + its circles mark the
              accessible window; the rest of the (lighter) track is just
              for scale. */}
          <div className="mini-timeline-track mini-timeline-track-wide" ref={miniTrack1Ref}>
            <div
              className="mini-timeline-accessible-range"
              style={{
                left: `${SST_ACCESSIBLE_START_FRAC * 100}%`,
                width: `${(SST_ACCESSIBLE_END_FRAC - SST_ACCESSIBLE_START_FRAC) * 100}%`,
              }}
            />
            <span
              className="mini-timeline-circle mini-timeline-circle-start"
              style={{ left: `${SST_ACCESSIBLE_START_FRAC * 100}%`, right: 'auto' }}
            />
            <span
              className="mini-timeline-circle mini-timeline-circle-end"
              style={{ left: `${SST_ACCESSIBLE_END_FRAC * 100}%`, right: 'auto', transform: 'translate(-50%, -50%)' }}
            />
            <div
              className="mini-timeline-handle"
              style={{
                left: `${
                  (SST_ACCESSIBLE_START_FRAC +
                    yearToFrac(year, SHORELINE_MIN_YEAR, SHORELINE_MAX_YEAR) *
                      (SST_ACCESSIBLE_END_FRAC - SST_ACCESSIBLE_START_FRAC)) *
                  100
                }%`,
              }}
              onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
              onPointerMove={(e) => {
                if (e.buttons !== 1 || !miniTrack1Ref.current) return
                setYear(
                  yearFromPointerXInRange(
                    e.clientX,
                    miniTrack1Ref.current,
                    SHORELINE_MIN_YEAR,
                    SHORELINE_MAX_YEAR,
                    SST_ACCESSIBLE_START_FRAC,
                    SST_ACCESSIBLE_END_FRAC,
                  ),
                )
              }}
            />
          </div>
          <div className="mini-timeline-dates">
            <span className="mini-timeline-date-scale-start">1850</span>
            <span className="mini-timeline-date-start" style={{ left: `${SST_ACCESSIBLE_START_FRAC * 100}%` }}>
              1999
            </span>
            <span
              className="mini-timeline-date-end"
              style={{ left: `${SST_ACCESSIBLE_END_FRAC * 100}%`, right: 'auto', transform: 'translateX(-50%)' }}
            >
              2023
            </span>
          </div>
        </div>
      </div>
      <div className="heatmap-title-2">
        <span>
          Sea Level Anomaly (m)
          <a className="source-ref" href="#source-4">
            4
          </a>
        </span>
      </div>
      <div className="heatmap-chart-container-2">
        <AnomalyHeatmap csvUrl={SEA_LEVEL_CSV_URL} unit="m" activeYear={year} />
      </div>
      <div className="heatmap-side-text-2">
        <span>Heatmap side text</span>
      </div>
      <div className="timeline-container-3">
        <div className="mini-timeline-wrap">
          <div className="mini-timeline-track" ref={miniTrack2Ref}>
            <span className="mini-timeline-circle mini-timeline-circle-start" />
            <span className="mini-timeline-circle mini-timeline-circle-end" />
            <div
              className="mini-timeline-handle"
              style={{ left: `${yearToFrac(year, SHORELINE_MIN_YEAR, SHORELINE_MAX_YEAR) * 100}%` }}
              onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
              onPointerMove={(e) => {
                if (e.buttons !== 1 || !miniTrack2Ref.current) return
                setYear(yearFromPointerX(e.clientX, miniTrack2Ref.current, SHORELINE_MIN_YEAR, SHORELINE_MAX_YEAR))
              }}
            />
          </div>
          <div className="mini-timeline-dates">
            <span className="mini-timeline-date-start">1999</span>
            <span className="mini-timeline-date-end">2023</span>
          </div>
        </div>
      </div>
      <div className="weather-station-title">
        <span>
          Meteorological Stations
          <a className="source-ref" href="#source-5">
            5
          </a>
        </span>
      </div>
      <div className="weather-station-text">
        <span>
          This chart shows the number of meteorological stations established in each country over the years.
          The more stations that are built, the more data can be collected, helping us stay as informed as
          possible about the evolving situation in the Pacific.
        </span>
      </div>
      <div className="weather-station-chart">
        {weatherStationIsotypeData && (
          <IsotypeMatrix
            years={weatherStationIsotypeData.years}
            countries={weatherStationIsotypeData.countries}
            values={weatherStationIsotypeData.values}
            activeYear={year}
          />
        )}
      </div>
      <div className="timeline-container-4">
        <div className="mini-timeline-wrap">
          <div className="mini-timeline-track" ref={miniTrack3Ref}>
            <span className="mini-timeline-circle mini-timeline-circle-start" />
            <span className="mini-timeline-circle mini-timeline-circle-end" />
            <div
              className="mini-timeline-handle"
              style={{ left: `${yearToFrac(year, SHORELINE_MIN_YEAR, SHORELINE_MAX_YEAR) * 100}%` }}
              onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
              onPointerMove={(e) => {
                if (e.buttons !== 1 || !miniTrack3Ref.current) return
                setYear(yearFromPointerX(e.clientX, miniTrack3Ref.current, SHORELINE_MIN_YEAR, SHORELINE_MAX_YEAR))
              }}
            />
          </div>
          <div className="mini-timeline-dates">
            <span className="mini-timeline-date-start">1999</span>
            <span className="mini-timeline-date-end">2023</span>
          </div>
        </div>
      </div>
      <div className="map-conclusion">
        <h3 className="map-conclusion-title">Conclusion</h3>
        <div className="map-conclusion-body">
          <p>
            What we see in this data is that the situation is still not improving. Programs are being put in
            place, but they are adapting to the situation rather than addressing its underlying causes. This
            is not a criticism. Having interned at the Global Fund for Coral Reefs, I saw firsthand how
            difficult it is to tackle a problem that stems from a deeply rooted global responsibility. Amazing
            people are doing amazing things to alleviate the environmental issues that plague their local
            communities.
          </p>
          <p>
            But what needs to be done requires action on a vastly greater scale. We need to change our ways
            sooner rather than later if we are to address this problem and help protect these nations. The
            technologies we all rely on today also contribute to this damage, forcing us to confront a
            difficult balance between the benefits of our work and the environmental cost of producing them.
          </p>
        </div>
      </div>
      <div className="map-section-separator" />
      <div className="map-section-copyright">
        <span>Data sources</span>
        <ol className="map-sources">
          <li id="source-1">
            Shoreline positions and rates of change — Digital Earth Pacific, Coastlines (
            <a
              href="https://pacificdata.org/data/dataset/dep_ls_coastlines"
              target="_blank"
              rel="noreferrer"
            >
              pacificdata.org
            </a>
            ).
          </li>
          <li id="source-2">
            Mangrove extent — Digital Earth Pacific, Annual Mangrove Mapping (
            <a href="https://pacificdata.org/data/dataset/dep_s2_ammi" target="_blank" rel="noreferrer">
              pacificdata.org
            </a>
            ).
          </li>
          <li id="source-3">
            Sea-surface temperature anomalies — Pacific Data Hub, SPC Climate Change (
            <a
              href="https://stats.pacificdata.org/vis?lc=en&df[ds]=SPC2&df[id]=DF_CLIMATE_CHANGE&df[ag]=SPC&df[vs]=1.0&av=true&dq=A.SST_ANOM.&pd=,&to[TIME_PERIOD]=false&vw=tb"
              target="_blank"
              rel="noreferrer"
            >
              stats.pacificdata.org
            </a>
            ).
          </li>
          <li id="source-4">
            Sea-level rise — Pacific Data Hub, SPC Climate Change (
            <a
              href="https://stats.pacificdata.org/vis?lc=en&df[ds]=SPC2&df[id]=DF_CLIMATE_CHANGE&df[ag]=SPC&df[vs]=1.0&av=true&dq=A.SEA_LVL.&pd=,&to[TIME_PERIOD]=false"
              target="_blank"
              rel="noreferrer"
            >
              stats.pacificdata.org
            </a>
            ).
          </li>
          <li id="source-5">
            Meteorological monitoring network — Pacific Data Hub, SPC Climate Change (
            <a
              href="https://stats.pacificdata.org/vis?lc=en&df[ds]=SPC2&df[id]=DF_CLIMATE_CHANGE&df[ag]=SPC&df[vs]=1.0&av=true&dq=A.METEO_MONITOR_NET.&pd=,&to[TIME_PERIOD]=false"
              target="_blank"
              rel="noreferrer"
            >
              stats.pacificdata.org
            </a>
            ).
          </li>
        </ol>
      </div>
      <svg
        className="bar-heatmap-connector"
        viewBox={`0 0 1920 ${MAP_OUTER_VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
      >
        <path d={BAR_TO_HEATMAP_LINE_1} fill="none" stroke="#000" strokeWidth="2" />
        <path d={BAR_TO_HEATMAP_LINE_2} fill="none" stroke="#000" strokeWidth="2" />
        <path d={WEATHER_CHART_TO_STATION_CHART_LINE} fill="none" stroke="#000" strokeWidth="2" />
        <path d={NOTE_TO_MANGROVE_LINE} fill="none" stroke="#000" strokeWidth="2" />
        <path d={NOTE_TO_MANGROVE_ARROW} fill="#000" />
      </svg>
    </div>
  )
}
