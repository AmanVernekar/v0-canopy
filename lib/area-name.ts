// Resolve a friendly neighbourhood name (e.g. "Walworth", "Camberwell")
// from an LSOA polygon centroid via OSM Nominatim. Free, no key, just polite
// UA + cache.

const cache = new Map<string, Promise<string | null>>()

function centroid(geom: GeoJSON.Polygon | GeoJSON.MultiPolygon): [number, number] {
  const ring =
    geom.type === "Polygon"
      ? geom.coordinates[0]
      : geom.coordinates[0]?.[0] ?? []
  let lng = 0
  let lat = 0
  for (const [x, y] of ring) {
    lng += x
    lat += y
  }
  const n = ring.length || 1
  return [lng / n, lat / n]
}

interface NominatimAddress {
  suburb?: string
  neighbourhood?: string
  quarter?: string
  city_district?: string
  hamlet?: string
  village?: string
  town?: string
  city?: string
  road?: string
}

interface NominatimResponse {
  address?: NominatimAddress
  display_name?: string
}

export function resolveAreaName(
  lsoaCode: string,
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
): Promise<string | null> {
  const cached = cache.get(lsoaCode)
  if (cached) return cached

  const [lng, lat] = centroid(geometry)
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`

  const promise = fetch(url, {
    headers: {
      // Nominatim asks every client to identify itself.
      "Accept-Language": "en-GB,en",
    },
  })
    .then((r) => (r.ok ? (r.json() as Promise<NominatimResponse>) : null))
    .then((j): string | null => {
      if (!j) return null
      const a = j.address ?? {}
      // Pick the most "neighbourhood-like" name available.
      const name =
        a.neighbourhood ||
        a.suburb ||
        a.quarter ||
        a.city_district ||
        a.hamlet ||
        a.village ||
        a.town ||
        null
      return name
    })
    .catch(() => null)

  cache.set(lsoaCode, promise)
  return promise
}
