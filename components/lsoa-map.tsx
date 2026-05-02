"use client"

import { useEffect, useRef, useCallback, useState } from "react"
import { useCanopyStore, type LsoaData, type Intervention } from "@/lib/store"
import { vulnerabilityColour, normaliseScore, SELECTED_STROKE } from "@/lib/colours"
import { TreePine, House, Square, Umbrella, Trees, MapPin, X, Banknote } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
// page.tsx wraps this component in next/dynamic with ssr:false, so importing
// maplibre at module scope is safe and avoids the dynamic-import-inside-useEffect
// race that breaks under React Strict Mode's mount/cleanup/mount cycle.
import maplibregl from "maplibre-gl"

// Inline style with OSM tiles (no external style.json required)
const DARK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
      ],
      tileSize: 256,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    },
  },
  layers: [
    {
      id: "osm-tiles",
      type: "raster",
      source: "osm",
      minzoom: 0,
      maxzoom: 19,
    },
  ],
}

interface SelectedMarker {
  intervention: Intervention
  lng: number
  lat: number
  index: number
}

// Match the icon to the kind of intervention. Loose matching on substrings of
// the agent's free-text type (per context.md, type is open-vocab).
function getInterventionIcon(type: string) {
  const t = type.toLowerCase()
  if (t.includes("tree")) return TreePine
  if (t.includes("roof")) return House
  if (t.includes("pavement") || t.includes("paving")) return Square
  if (t.includes("shade") || t.includes("canopy") || t.includes("umbrella")) return Umbrella
  if (t.includes("park") || t.includes("garden") || t.includes("green")) return Trees
  return MapPin
}

function getInterventionColor(type: string): string {
  const t = type.toLowerCase()
  if (t.includes("tree")) return "#4ade80" // green
  if (t.includes("cool_roof") || t.includes("cool roof")) return "#60a5fa" // blue
  if (t.includes("green_roof") || t.includes("green roof")) return "#34d399" // emerald
  if (t.includes("pavement") || t.includes("paving")) return "#a78bfa" // violet
  if (t.includes("shade")) return "#f59e0b" // amber
  if (t.includes("park") || t.includes("garden")) return "#10b981" // emerald
  return "#22d3ee" // cyan default
}

// Encode an SVG icon string for the marker DOM. lucide-react paths inlined.
const ICON_SVG: Record<string, string> = {
  tree: '<path d="M12 2L8 7h2l-3 4h2l-4 5h6v6h2v-6h6l-4-5h2l-3-4h2z"/>',
  house: '<path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="1"/>',
  umbrella: '<path d="M12 2v2"/><path d="M2 12a10 10 0 0 1 20 0z"/><path d="M12 12v6a2 2 0 0 0 4 0"/>',
  park: '<path d="M12 2v20"/><path d="M5 8h14"/><path d="M5 16h14"/>',
  pin: '<path d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7z"/><circle cx="12" cy="9" r="2.5"/>',
}

function getIconSvg(type: string): string {
  const t = type.toLowerCase()
  if (t.includes("tree")) return ICON_SVG.tree
  if (t.includes("roof")) return ICON_SVG.house
  if (t.includes("pavement") || t.includes("paving")) return ICON_SVG.square
  if (t.includes("shade")) return ICON_SVG.umbrella
  if (t.includes("park") || t.includes("garden")) return ICON_SVG.park
  return ICON_SVG.pin
}

interface LsoaMapProps {
  className?: string
}

export function LsoaMap({ className }: LsoaMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [mapLoaded, setMapLoaded] = useState(false)
  const [hoveredLsoa, setHoveredLsoa] = useState<string | null>(null)
  const [selectedMarker, setSelectedMarker] = useState<SelectedMarker | null>(null)
  // Re-projected popup screen coords. Updated whenever the map moves so the
  // popup tracks its anchor instead of getting stranded on pan/zoom.
  const [popupXY, setPopupXY] = useState<{ x: number; y: number } | null>(null)
  // LSOA the user just clicked but hasn't confirmed switching to (when there's
  // already work to lose).
  const [pendingLsoa, setPendingLsoa] = useState<string | null>(null)
  const markerRefs = useRef<maplibregl.Marker[]>([])

  const {
    selectedLsoa,
    lsoaData,
    setLsoaData,
    setSelectedLsoa,
    parsedDossier,
    resetAgent,
    setMapInstance,
    isAgentRunning,
  } = useCanopyStore()

  // Load LSOA data from public JSON
  useEffect(() => {
    fetch("/data/lsoas.json")
      .then((r) => r.json())
      .then((data: LsoaData) => setLsoaData(data))
      .catch(console.error)
  }, [setLsoaData])

  // Build GeoJSON from the loaded data
  const buildGeoJSON = useCallback(
    (data: LsoaData): GeoJSON.FeatureCollection => {
      const scores = Object.values(data).map((f) => f.vulnerability_score)
      const minScore = Math.min(...scores)
      const maxScore = Math.max(...scores)

      return {
        type: "FeatureCollection",
        features: Object.entries(data).map(([code, feat]) => ({
          type: "Feature",
          id: code,
          properties: {
            lsoa_code: code,
            name: feat.name,
            vulnerability_score: feat.vulnerability_score,
            fill_color: vulnerabilityColour(
              normaliseScore(feat.vulnerability_score, minScore, maxScore)
            ),
          },
          geometry: feat.geometry,
        })),
      }
    },
    []
  )

  // Initialise map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: DARK_STYLE,
      center: [-0.09, 51.495],
      zoom: 12,
      attributionControl: false,
      // Required for getCanvas().toDataURL() — used by the dossier PDF export
      // to embed a snapshot of the map. Slight perf cost is acceptable here.
      preserveDrawingBuffer: true,
    })

    mapRef.current = map
    setMapInstance(map)

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right")

    const markReady = () => setMapLoaded(true)
    if (map.isStyleLoaded()) {
      markReady()
    } else {
      map.once("styledata", markReady)
    }

    map.on("error", (e: unknown) => {
      console.error("Map error:", e)
    })

    return () => {
      map.remove()
      mapRef.current = null
      setMapInstance(null)
    }
  }, [setMapInstance])

  // Add/update polygon layers when data and map are ready
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded || Object.keys(lsoaData).length === 0) return

    const geojson = buildGeoJSON(lsoaData)

    // Auto-fit to bounding box on first load only
    if (!map.getSource("lsoas")) {
      const coords: [number, number][] = []
      geojson.features.forEach((f) => {
        const geom = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon
        if (geom.type === "Polygon") {
          geom.coordinates[0].forEach(([lng, lat]) => coords.push([lng, lat]))
        } else if (geom.type === "MultiPolygon") {
          geom.coordinates.forEach((poly) =>
            poly[0].forEach(([lng, lat]) => coords.push([lng, lat]))
          )
        }
      })
      if (coords.length > 0) {
        const lngs = coords.map(([lng]) => lng)
        const lats = coords.map(([, lat]) => lat)
        map.fitBounds(
          [
            [Math.min(...lngs), Math.min(...lats)],
            [Math.max(...lngs), Math.max(...lats)],
          ],
          { padding: 60, duration: 800 }
        )
      }

      map.addSource("lsoas", { type: "geojson", data: geojson })

      map.addLayer({
        id: "lsoas-fill",
        type: "fill",
        source: "lsoas",
        paint: {
          "fill-color": ["get", "fill_color"],
          "fill-opacity": 0.72,
        },
      })

      map.addLayer({
        id: "lsoas-stroke",
        type: "line",
        source: "lsoas",
        paint: {
          "line-color": [
            "case",
            ["==", ["get", "lsoa_code"], selectedLsoa ?? ""],
            SELECTED_STROKE,
            "rgba(255,255,255,0.5)",
          ],
          "line-width": [
            "case",
            ["==", ["get", "lsoa_code"], selectedLsoa ?? ""],
            2.5,
            ["==", ["get", "lsoa_code"], hoveredLsoa ?? ""],
            1.5,
            0.6,
          ],
        },
      })

      // Hover
      map.on("mousemove", "lsoas-fill", (e) => {
        map.getCanvas().style.cursor = "pointer"
        const code = e.features?.[0]?.properties?.lsoa_code as string | undefined
        if (code) setHoveredLsoa(code)
      })
      map.on("mouseleave", "lsoas-fill", () => {
        map.getCanvas().style.cursor = ""
        setHoveredLsoa(null)
      })

      // Click — read latest store state at click time so we can gate behind
      // the confirm modal when work would be lost.
      map.on("click", "lsoas-fill", (e) => {
        const code = e.features?.[0]?.properties?.lsoa_code as string | undefined
        if (!code) return
        const s = useCanopyStore.getState()
        // Same area or no prior work: just go.
        if (
          code === s.selectedLsoa ||
          (!s.parsedDossier && !s.isAgentRunning)
        ) {
          if (code !== s.selectedLsoa) s.resetAgent()
          s.setSelectedLsoa(code)
          setSelectedMarker(null)
          return
        }
        // Otherwise: queue the switch for user confirmation.
        setPendingLsoa(code)
      })
    } else {
      ;(map.getSource("lsoas") as maplibregl.GeoJSONSource).setData(geojson)
    }
  }, [mapLoaded, lsoaData, buildGeoJSON, selectedLsoa, hoveredLsoa, setSelectedLsoa, resetAgent])

  // Update stroke when selection/hover changes
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded || !map.getLayer("lsoas-stroke")) return

    map.setPaintProperty("lsoas-stroke", "line-color", [
      "case",
      ["==", ["get", "lsoa_code"], selectedLsoa ?? ""],
      SELECTED_STROKE,
      "rgba(255,255,255,0.5)",
    ])
    map.setPaintProperty("lsoas-stroke", "line-width", [
      "case",
      ["==", ["get", "lsoa_code"], selectedLsoa ?? ""],
      2.5,
      ["==", ["get", "lsoa_code"], hoveredLsoa ?? ""],
      1.5,
      0.6,
    ])
  }, [selectedLsoa, hoveredLsoa, mapLoaded])

  // Render intervention markers — one per target_location, grouped per intervention.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded) return

    // Clear previous markers
    markerRefs.current.forEach((m) => m.remove())
    markerRefs.current = []
    setSelectedMarker(null)

    if (!parsedDossier) return

    // Track marker bounds so we can fit the camera nicely.
    const allCoords: [number, number][] = []

    parsedDossier.interventions.forEach((intervention, ivIdx) => {
      const color = getInterventionColor(intervention.type)
      const iconSvg = getIconSvg(intervention.type)

      intervention.target_locations.forEach((loc, locIdx) => {
        if (typeof loc.lng !== "number" || typeof loc.lat !== "number") return
        allCoords.push([loc.lng, loc.lat])

        // Outer element — MapLibre owns its `transform` for translation. Do
        // NOT set transform on this node, or hover-scaling will clobber the
        // marker's lng/lat positioning and it'll fly to the top-left.
        const el = document.createElement("div")
        el.className = "intervention-marker"
        el.style.cursor = "pointer"

        // Inner element carries all the styling and hover effects.
        const inner = document.createElement("div")
        inner.style.cssText = `
          width: 32px; height: 32px;
          background: ${color}33;
          border: 2px solid ${color};
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          transition: transform 0.15s, box-shadow 0.15s;
          box-shadow: 0 0 0 0 ${color}66;
        `
        inner.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconSvg}</svg>`
        el.appendChild(inner)

        el.addEventListener("mouseenter", () => {
          inner.style.transform = "scale(1.15)"
          inner.style.boxShadow = `0 0 0 6px ${color}22`
        })
        el.addEventListener("mouseleave", () => {
          inner.style.transform = "scale(1)"
          inner.style.boxShadow = `0 0 0 0 ${color}66`
        })
        el.addEventListener("click", (ev) => {
          ev.stopPropagation()
          setSelectedMarker({
            intervention,
            lng: loc.lng,
            lat: loc.lat,
            index: ivIdx * 100 + locIdx,
          })
        })

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([loc.lng, loc.lat])
          .addTo(map)

        markerRefs.current.push(marker)
      })
    })

    // Fit to markers + selected LSOA
    if (allCoords.length > 0) {
      const lngs = allCoords.map(([lng]) => lng)
      const lats = allCoords.map(([, lat]) => lat)
      map.fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        { padding: 120, duration: 800, maxZoom: 16 }
      )
    }
  }, [parsedDossier, mapLoaded])

  // Keep popup glued to its lat/lng across pan/zoom by re-projecting on every
  // map move. Without this, the popup is positioned once at click time and
  // drifts off as the map animates (e.g. the auto-fit after the dossier
  // arrives).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedMarker) {
      setPopupXY(null)
      return
    }
    const update = () => {
      const p = map.project([selectedMarker.lng, selectedMarker.lat])
      setPopupXY({ x: p.x, y: p.y })
    }
    update()
    map.on("move", update)
    map.on("zoom", update)
    return () => {
      map.off("move", update)
      map.off("zoom", update)
    }
  }, [selectedMarker])

  // Compute fund cover for the open marker, if any.
  const matchedFunds =
    selectedMarker && parsedDossier
      ? parsedDossier.funds.filter((f) =>
          f.covered_interventions.some(
            (c) =>
              c.includes(selectedMarker.intervention.type) ||
              selectedMarker.intervention.type.includes(c)
          )
        )
      : []

  const handleResetView = useCallback(() => {
    if (!mapRef.current || Object.keys(lsoaData).length === 0) return
    const geojson = buildGeoJSON(lsoaData)
    const coords: [number, number][] = []
    geojson.features.forEach((f) => {
      const geom = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon
      if (geom.type === "Polygon") {
        geom.coordinates[0].forEach(([lng, lat]) => coords.push([lng, lat]))
      }
    })
    if (coords.length > 0) {
      const lngs = coords.map(([lng]) => lng)
      const lats = coords.map(([, lat]) => lat)
      mapRef.current.fitBounds(
        [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
        { padding: 60, duration: 600 }
      )
    }
  }, [lsoaData, buildGeoJSON])

  return (
    <div className={`relative w-full h-full ${className ?? ""}`}>
      <div ref={mapContainerRef} className="w-full h-full" />

      {/* Loading skeleton */}
      <AnimatePresence>
        {!mapLoaded && (
          <motion.div
            key="skeleton"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-zinc-950 flex items-center justify-center z-10"
          >
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-cyan-400/40 border-t-cyan-400 rounded-full animate-spin" />
              <span className="text-zinc-500 text-sm font-mono">Loading map tiles…</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* "Click any area" overlay when nothing selected */}
      <AnimatePresence>
        {mapLoaded && !selectedLsoa && (
          <motion.div
            key="prompt"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ delay: 0.8 }}
            className="pointer-events-none absolute inset-0 flex items-end justify-center pb-20 z-10"
          >
            <div className="bg-zinc-900/80 backdrop-blur-sm border border-zinc-700/60 rounded-lg px-4 py-2.5 text-sm text-zinc-400">
              Click any area on the map to begin analysis
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Vulnerability legend */}
      <div className="absolute bottom-10 left-4 z-10 bg-zinc-900/80 backdrop-blur-sm border border-zinc-800/60 rounded-md px-3 py-2.5">
        <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-1.5">
          Heat vulnerability
        </p>
        <div
          className="w-28 h-2 rounded-sm"
          style={{
            background:
              "linear-gradient(to right, #ffffb2, #fecc5c, #fd8d3c, #f03b20, #bd0026)",
          }}
        />
        <div className="flex justify-between mt-1">
          <span className="text-[9px] font-mono text-zinc-600">Low</span>
          <span className="text-[9px] font-mono text-zinc-600">High</span>
        </div>
      </div>

      {/* Intervention legend (shown when dossier is loaded) */}
      <AnimatePresence>
        {parsedDossier && parsedDossier.interventions.length > 0 && (
          <motion.div
            key="iv-legend"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="absolute top-4 left-4 z-10 bg-zinc-900/85 backdrop-blur-sm border border-zinc-800/60 rounded-md px-3 py-2.5 max-w-[220px]"
          >
            <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-2">
              Proposed interventions
            </p>
            <div className="space-y-1.5">
              {parsedDossier.interventions.map((iv, i) => {
                const color = getInterventionColor(iv.type)
                const Icon = getInterventionIcon(iv.type)
                return (
                  <div key={i} className="flex items-center gap-2">
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                      style={{
                        background: `${color}33`,
                        border: `1.5px solid ${color}`,
                      }}
                    >
                      <Icon size={10} className="" style={{ color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-zinc-200 leading-tight truncate">
                        {iv.type.replace(/_/g, " ")}
                      </p>
                      <p className="text-[9px] font-mono text-zinc-500">
                        {iv.target_locations.length} sites · £{(iv.indicative_cost_gbp / 1000).toFixed(0)}k
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="text-[9px] font-mono text-zinc-600 mt-2 pt-2 border-t border-zinc-800/60">
              Click a marker for cost & impact
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reset view button */}
      <div className="absolute bottom-10 right-12 z-10">
        <button
          onClick={handleResetView}
          className="bg-zinc-900/80 hover:bg-zinc-800 backdrop-blur-sm border border-zinc-700/60 rounded-md px-2.5 py-1.5 text-[10px] font-mono text-zinc-400 hover:text-zinc-200 transition-colors uppercase tracking-widest"
        >
          Reset view
        </button>
      </div>

      {/* Persistent intervention popup (click marker) */}
      <AnimatePresence>
        {selectedMarker && popupXY && (
          <motion.div
            key={`popup-${selectedMarker.index}`}
            initial={{ opacity: 0, scale: 0.95, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="absolute z-20 pointer-events-auto"
            style={{
              left: popupXY.x,
              top: popupXY.y - 22,
              transform: "translate(-50%, -100%)",
            }}
          >
            <div className="bg-zinc-900 border border-zinc-700/80 rounded-md p-3 w-[280px] shadow-2xl">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0 flex-1">
                  <p
                    className="text-[10px] font-mono uppercase tracking-widest"
                    style={{ color: getInterventionColor(selectedMarker.intervention.type) }}
                  >
                    Intervention
                  </p>
                  <p className="text-sm font-medium text-zinc-100 leading-tight">
                    {selectedMarker.intervention.type.replace(/_/g, " ")}
                  </p>
                </div>
                <button
                  onClick={() => setSelectedMarker(null)}
                  className="text-zinc-500 hover:text-zinc-300 flex-shrink-0"
                  aria-label="Close"
                >
                  <X size={14} />
                </button>
              </div>

              <p className="text-[11px] text-zinc-400 leading-relaxed mb-2.5">
                {selectedMarker.intervention.rationale_short}
              </p>

              <div className="grid grid-cols-2 gap-2 mb-2.5">
                <div className="bg-zinc-950/60 rounded p-2">
                  <p className="text-[8px] font-mono text-zinc-600 uppercase tracking-widest">
                    Quantity
                  </p>
                  <p className="text-[12px] font-mono text-zinc-200">
                    {selectedMarker.intervention.quantity}{" "}
                    <span className="text-zinc-500">{selectedMarker.intervention.unit}</span>
                  </p>
                </div>
                <div className="bg-zinc-950/60 rounded p-2">
                  <p className="text-[8px] font-mono text-zinc-600 uppercase tracking-widest">
                    Indicative cost
                  </p>
                  <p className="text-[12px] font-mono text-amber-400">
                    £{selectedMarker.intervention.indicative_cost_gbp.toLocaleString()}
                  </p>
                </div>
              </div>

              <div className="bg-zinc-950/60 rounded p-2 mb-2.5">
                <p className="text-[8px] font-mono text-zinc-600 uppercase tracking-widest mb-0.5">
                  Expected impact
                  <span
                    className={`ml-2 px-1.5 py-0.5 rounded border ${
                      selectedMarker.intervention.evidence_quality === "strong"
                        ? "border-green-400/30 text-green-400 bg-green-400/10"
                        : selectedMarker.intervention.evidence_quality === "moderate"
                        ? "border-amber-400/30 text-amber-400 bg-amber-400/10"
                        : "border-zinc-700 text-zinc-500 bg-zinc-800"
                    }`}
                  >
                    {selectedMarker.intervention.evidence_quality}
                  </span>
                </p>
                <p className="text-[11px] text-zinc-300 leading-relaxed mt-1">
                  {selectedMarker.intervention.evidence_effect_size}
                </p>
              </div>

              {matchedFunds.length > 0 && (
                <div>
                  <p className="text-[8px] font-mono text-zinc-600 uppercase tracking-widest mb-1 flex items-center gap-1">
                    <Banknote size={9} /> Funded by
                  </p>
                  <div className="space-y-1">
                    {matchedFunds.slice(0, 3).map((f, i) => (
                      <a
                        key={i}
                        href={f.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block text-[11px] text-cyan-400 hover:text-cyan-300 truncate"
                      >
                        → {f.name}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Confirm switch — guards against losing in-progress work. */}
      <AnimatePresence>
        {pendingLsoa && (
          <motion.div
            key="confirm-switch"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 bg-zinc-950/70 backdrop-blur-sm flex items-center justify-center p-6"
            onClick={() => setPendingLsoa(null)}
          >
            <motion.div
              initial={{ y: 8, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 4, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-zinc-900 border border-zinc-700/80 rounded-md p-5 w-[380px] max-w-full shadow-2xl"
            >
              <p className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest mb-2">
                Move to a different area?
              </p>
              <p className="text-[13px] text-zinc-200 leading-relaxed mb-1">
                Switch analysis to{" "}
                <span className="font-medium text-cyan-400">
                  {lsoaData[pendingLsoa]?.name ?? pendingLsoa}
                </span>
                ?
              </p>
              <p className="text-[11px] text-zinc-500 leading-relaxed mb-4">
                {isAgentRunning
                  ? "The current analysis is still running and will be discarded."
                  : "The current dossier will be discarded. You can always re-run."}
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setPendingLsoa(null)}
                  className="text-[11px] font-mono text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-md px-3 py-1.5 transition-colors"
                >
                  Stay here
                </button>
                <button
                  onClick={() => {
                    const code = pendingLsoa
                    setPendingLsoa(null)
                    resetAgent()
                    setSelectedLsoa(code)
                    setSelectedMarker(null)
                  }}
                  className="text-[11px] font-mono text-cyan-400 bg-cyan-400/15 hover:bg-cyan-400/25 border border-cyan-400/40 rounded-md px-3 py-1.5 transition-colors"
                >
                  Move to area
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
