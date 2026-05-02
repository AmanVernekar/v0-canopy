"use client"

import { useEffect, useRef, useCallback, useState } from "react"
import { useCanopyStore, type LsoaData } from "@/lib/store"
import { vulnerabilityColour, normaliseScore, SELECTED_STROKE } from "@/lib/colours"
import { TreePine, House, Square, Umbrella, Trees, MapPin } from "lucide-react"
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

interface PopupInfo {
  lng: number
  lat: number
  title: string
  rationale: string
  cost: number
  x: number
  y: number
}

function getInterventionIcon(type: string) {
  switch (type) {
    case "street_trees": return TreePine
    case "green_roofs":
    case "cool_roofs": return House
    case "cool_pavements": return Square
    case "shade_structures": return Umbrella
    case "pocket_parks": return Trees
    default: return MapPin
  }
}

function getInterventionColor(type: string): string {
  switch (type) {
    case "street_trees": return "#4ade80" // green-400
    case "green_roofs":
    case "cool_roofs": return "#60a5fa" // blue-400
    case "cool_pavements": return "#a78bfa" // violet-400
    case "shade_structures": return "#f59e0b" // amber-400
    case "pocket_parks": return "#34d399" // emerald-400
    default: return "#22d3ee" // cyan-400
  }
}

interface LsoaMapProps {
  className?: string
}

export function LsoaMap({ className }: LsoaMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [mapLoaded, setMapLoaded] = useState(false)
  const [hoveredLsoa, setHoveredLsoa] = useState<string | null>(null)
  const [popupInfo, setPopupInfo] = useState<PopupInfo | null>(null)
  const markerRefs = useRef<maplibregl.Marker[]>([])

  const { selectedLsoa, lsoaData, setLsoaData, setSelectedLsoa, parsedDossier, resetAgent } =
    useCanopyStore()

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
    })

    mapRef.current = map

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right")

    // Gate on `isStyleLoaded()` rather than the `load` event — under React
    // Strict Mode the first map gets .remove()'d immediately and the second
    // map's `load` event sometimes never fires.
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
    }
  }, [])

  // Add/update polygon layers when data and map are ready
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded || Object.keys(lsoaData).length === 0) return

    const geojson = buildGeoJSON(lsoaData)

    // Auto-fit to bounding box
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
      const bbox: [[number, number], [number, number]] = [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ]
      map.fitBounds(bbox, { padding: 60, duration: 800 })
    }

    // Add source
    if (map.getSource("lsoas")) {
      ;(map.getSource("lsoas") as maplibregl.GeoJSONSource).setData(geojson)
    } else {
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

      // Click
      map.on("click", "lsoas-fill", (e) => {
        const code = e.features?.[0]?.properties?.lsoa_code as string | undefined
        if (code) {
          if (code !== selectedLsoa) {
            resetAgent()
          }
          setSelectedLsoa(code)
        }
      })
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

  // Render intervention markers
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded) return

    // Clear previous markers
    markerRefs.current.forEach((m) => m.remove())
    markerRefs.current = []

    if (!parsedDossier) return

    parsedDossier.interventions.forEach((intervention) => {
      const color = getInterventionColor(intervention.type)

      intervention.target_locations.forEach((loc) => {
        const el = document.createElement("div")
        el.className = "intervention-marker"
        el.style.cssText = `
          width: 30px; height: 30px;
          background: ${color}22;
          border: 1.5px solid ${color};
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer;
          transition: transform 0.2s;
        `
        el.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></svg>`

        el.addEventListener("mouseenter", () => {
          el.style.transform = "scale(1.2)"
          const rect = el.getBoundingClientRect()
          const containerRect = mapContainerRef.current?.getBoundingClientRect()
          if (containerRect) {
            setPopupInfo({
              lng: loc.lng,
              lat: loc.lat,
              title: intervention.title,
              rationale: intervention.rationale_short,
              cost: intervention.estimated_cost_gbp,
              x: rect.left - containerRect.left + rect.width / 2,
              y: rect.top - containerRect.top,
            })
          }
        })
        el.addEventListener("mouseleave", () => {
          el.style.transform = "scale(1)"
          setPopupInfo(null)
        })

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([loc.lng, loc.lat])
          .addTo(map)

        markerRefs.current.push(marker)
      })
    })
  }, [parsedDossier, mapLoaded])

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
      {/* Map container — w-full h-full instead of absolute inset-0 because
          maplibre-gl.css sets .maplibregl-map { position: relative } and clobbers
          the absolute, collapsing height to 0. */}
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

      {/* Legend */}
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

      {/* Reset view button */}
      <div className="absolute bottom-10 right-12 z-10">
        <button
          onClick={handleResetView}
          className="bg-zinc-900/80 hover:bg-zinc-800 backdrop-blur-sm border border-zinc-700/60 rounded-md px-2.5 py-1.5 text-[10px] font-mono text-zinc-400 hover:text-zinc-200 transition-colors uppercase tracking-widest"
        >
          Reset view
        </button>
      </div>

      {/* Intervention popup */}
      <AnimatePresence>
        {popupInfo && (
          <motion.div
            key="popup"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute z-20 pointer-events-none"
            style={{
              left: popupInfo.x,
              top: popupInfo.y - 8,
              transform: "translate(-50%, -100%)",
            }}
          >
            <div className="bg-zinc-900 border border-zinc-700/80 rounded-md p-3 max-w-[220px] shadow-xl">
              <p className="text-xs font-medium text-zinc-200 mb-1">{popupInfo.title}</p>
              <p className="text-[11px] text-zinc-400 leading-relaxed mb-2">
                {popupInfo.rationale}
              </p>
              <p className="text-[11px] font-mono text-amber-400">
                ~£{popupInfo.cost.toLocaleString()}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
