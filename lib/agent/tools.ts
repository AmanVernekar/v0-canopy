import { tool } from "ai"
import { z } from "zod"
import { promises as fs } from "node:fs"
import path from "node:path"

// ────────────────────────────────────────────────────────────────────────
// Loader for the bundled LSOA dataset. Cached for the lifetime of the
// process — small dataset, read-only, never expires within a request.
// ────────────────────────────────────────────────────────────────────────
type LsoaRecord = {
  name: string
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
  imd_decile: number | null
  vulnerability_score: number | null
  canopy_cover_pct: number | null
  tree_equity_score: number | null
  building_count: number
  population: number | null
  pop_density_per_ha: number | null
  pct_over_65: number | null
  pct_under_5: number | null
  streets: Array<{ id: number; name: string | null; highway: string | null; coords: [number, number][] }>
  buildings: Array<{ id: number; coords: [number, number][] }>
}

let _lsoaCache: Record<string, LsoaRecord> | null = null
async function loadLsoas(): Promise<Record<string, LsoaRecord>> {
  if (_lsoaCache) return _lsoaCache
  const filePath = path.join(process.cwd(), "public", "data", "lsoas.json")
  const raw = await fs.readFile(filePath, "utf-8")
  _lsoaCache = JSON.parse(raw) as Record<string, LsoaRecord>
  return _lsoaCache
}

let _fundsCache: FundProfile[] | null = null
async function loadFunds(): Promise<FundProfile[]> {
  if (_fundsCache) return _fundsCache
  const filePath = path.join(process.cwd(), "data", "funds-fallback.json")
  const raw = await fs.readFile(filePath, "utf-8")
  _fundsCache = JSON.parse(raw) as FundProfile[]
  return _fundsCache
}

interface FundProfile {
  name: string
  url: string
  status: "open" | "closing_soon" | "scheduled" | "unclear"
  deadline: string | null
  max_grant_gbp: number
  match_required_pct: number
  covered_interventions: string[]
  eligibility_notes: string
}

// ────────────────────────────────────────────────────────────────────────
// Geometry helpers — used by get_lsoa_context and query_lsoa_subset to give
// the agent real coordinates so it can place markers inside the LSOA polygon
// instead of guessing.
// ────────────────────────────────────────────────────────────────────────
function computeBbox(geom: GeoJSON.Polygon | GeoJSON.MultiPolygon): {
  bbox: [number, number, number, number]
  centroid: [number, number]
} {
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity
  const visit = (ring: GeoJSON.Position[]) => {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }
  }
  if (geom.type === "Polygon") {
    visit(geom.coordinates[0])
  } else {
    geom.coordinates.forEach((poly) => visit(poly[0]))
  }
  return {
    bbox: [minLng, minLat, maxLng, maxLat],
    centroid: [(minLng + maxLng) / 2, (minLat + maxLat) / 2],
  }
}

function streetMidpoint(coords: [number, number][]): [number, number] | null {
  if (coords.length === 0) return null
  if (coords.length === 1) return coords[0]
  // Take the geometric mid by index — close enough for marker placement, no
  // need to compute true cumulative-length midpoint for a hackathon.
  return coords[Math.floor(coords.length / 2)]
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

// ────────────────────────────────────────────────────────────────────────
// 1. get_lsoa_context — token-efficient profile of the LSOA. Always first.
// ────────────────────────────────────────────────────────────────────────
export const get_lsoa_context = tool({
  description:
    "Get the full context profile for a specific LSOA (Lower Super Output Area). Returns vulnerability indicators, demographics, canopy cover, deprivation, AND geographic anchors (bbox, centroid, named streets with midpoint coordinates) you must use to place intervention markers inside the polygon. Always call this FIRST for any new LSOA.",
  inputSchema: z.object({
    lsoa_code: z.string().describe("LSOA 2021 code, e.g. E01003911"),
  }),
  execute: async ({ lsoa_code }) => {
    const data = await loadLsoas()
    const lsoa = data[lsoa_code]
    if (!lsoa) return { error: `LSOA ${lsoa_code} not found in dataset` }

    const highwayBreakdown: Record<string, number> = {}
    for (const s of lsoa.streets) {
      const h = s.highway ?? "unknown"
      highwayBreakdown[h] = (highwayBreakdown[h] ?? 0) + 1
    }

    const { bbox, centroid } = computeBbox(lsoa.geometry)

    // Named streets with midpoint coordinates — the agent uses these as the
    // primary anchors for intervention target_locations. Without coords here
    // the agent hallucinates points outside the polygon.
    const namedStreets = lsoa.streets
      .filter((s) => s.name && s.coords.length > 0)
      .slice(0, 12)
      .map((s) => {
        const mid = streetMidpoint(s.coords)
        return mid
          ? {
              name: s.name,
              highway: s.highway,
              midpoint: { lng: round6(mid[0]), lat: round6(mid[1]) },
            }
          : null
      })
      .filter(Boolean)

    return {
      lsoa_code,
      name: lsoa.name,
      vulnerability_score: lsoa.vulnerability_score,
      imd_decile: lsoa.imd_decile,
      canopy_cover_pct: lsoa.canopy_cover_pct,
      tree_equity_score: lsoa.tree_equity_score,
      population: lsoa.population,
      pop_density_per_ha: lsoa.pop_density_per_ha,
      pct_over_65: lsoa.pct_over_65,
      pct_under_5: lsoa.pct_under_5,
      building_count: lsoa.building_count,
      street_count: lsoa.streets.length,
      highway_breakdown: highwayBreakdown,
      // Geographic anchors — every target_locations entry MUST be inside this
      // bbox. Use named_streets[*].midpoint as starting points.
      bbox: {
        lng_min: round6(bbox[0]),
        lat_min: round6(bbox[1]),
        lng_max: round6(bbox[2]),
        lat_max: round6(bbox[3]),
      },
      centroid: { lng: round6(centroid[0]), lat: round6(centroid[1]) },
      named_streets: namedStreets,
    }
  },
})

// ────────────────────────────────────────────────────────────────────────
// 2. query_lsoa_subset — pull-on-threads for hypothesis-driven discovery.
// ────────────────────────────────────────────────────────────────────────
export const query_lsoa_subset = tool({
  description:
    "Query a subset of streets or buildings within an LSOA, optionally filtered by tags. Use this to test hypotheses about the place — e.g. 'are there many residential streets without trees?' or 'how many large building footprints are in the south-west portion?'. Returns either summary stats (preferred) or up to 50 raw items.",
  inputSchema: z.object({
    lsoa_code: z.string(),
    target: z.enum(["streets", "buildings"]),
    filters: z
      .object({
        highway_in: z.array(z.string()).optional().describe("e.g. ['residential','tertiary']"),
        named_only: z.boolean().optional(),
      })
      .optional(),
    summary_only: z
      .boolean()
      .default(true)
      .describe("If true, return counts/aggregates only. Set false to retrieve up to 50 items."),
  }),
  execute: async ({ lsoa_code, target, filters, summary_only }) => {
    const data = await loadLsoas()
    const lsoa = data[lsoa_code]
    if (!lsoa) return { error: `LSOA ${lsoa_code} not found` }

    if (target === "streets") {
      let items = lsoa.streets
      if (filters?.highway_in)
        items = items.filter((s) => s.highway && filters.highway_in!.includes(s.highway))
      if (filters?.named_only) items = items.filter((s) => s.name)
      if (summary_only) {
        return {
          target,
          count: items.length,
          named: items.filter((s) => s.name).length,
          highway_distribution: items.reduce<Record<string, number>>((a, s) => {
            const h = s.highway ?? "unknown"
            a[h] = (a[h] ?? 0) + 1
            return a
          }, {}),
        }
      }
      return {
        target,
        count: items.length,
        items: items.slice(0, 50).map((s) => {
          const mid = streetMidpoint(s.coords)
          return {
            id: s.id,
            name: s.name,
            highway: s.highway,
            midpoint: mid ? { lng: round6(mid[0]), lat: round6(mid[1]) } : null,
          }
        }),
      }
    } else {
      const items = lsoa.buildings
      if (summary_only) {
        return { target, count: items.length }
      }
      return {
        target,
        count: items.length,
        items: items.slice(0, 50).map((b) => ({ id: b.id })),
      }
    }
  },
})

// ────────────────────────────────────────────────────────────────────────
// 3. search_evidence — peer-reviewed cooling-effect studies via OpenAlex.
// ────────────────────────────────────────────────────────────────────────
export const search_evidence = tool({
  description:
    "Search peer-reviewed literature for cooling-effect evidence on a specific intervention type. Prefer UK / temperate-maritime studies. Returns up to 5 papers with title, year, abstract snippet, and effect-size language.",
  inputSchema: z.object({
    intervention: z
      .string()
      .describe("e.g. 'street trees', 'cool roofs', 'green walls', 'pocket parks'"),
    climate_context: z
      .string()
      .optional()
      .describe("e.g. 'UK', 'temperate maritime'. Used to bias the query."),
  }),
  execute: async ({ intervention, climate_context }) => {
    const email = process.env.OPENALEX_EMAIL ?? "anonymous@example.com"
    const q = [
      `"${intervention}"`,
      "(cooling OR temperature OR heat)",
      climate_context ? `"${climate_context}"` : null,
    ]
      .filter(Boolean)
      .join(" ")
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per_page=5&select=id,title,publication_year,abstract_inverted_index,doi`

    try {
      const r = await fetch(url, { headers: { "User-Agent": `canopy/0.1 (${email})` } })
      if (!r.ok) return { error: `OpenAlex returned ${r.status}` }
      const json = (await r.json()) as { results?: OpenAlexWork[] }
      const results = (json.results ?? []).map((w) => ({
        title: w.title,
        year: w.publication_year,
        doi: w.doi,
        abstract_snippet: reconstructAbstract(w.abstract_inverted_index).slice(0, 400),
      }))
      return { query: q, results }
    } catch (e) {
      return { error: `OpenAlex request failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
})

interface OpenAlexWork {
  id: string
  title: string
  publication_year: number
  doi: string | null
  abstract_inverted_index: Record<string, number[]> | null
}

function reconstructAbstract(idx: Record<string, number[]> | null): string {
  if (!idx) return ""
  const positions: Array<[number, string]> = []
  for (const [word, idxs] of Object.entries(idx)) {
    for (const i of idxs) positions.push([i, word])
  }
  positions.sort((a, b) => a[0] - b[0])
  return positions.map(([, w]) => w).join(" ")
}

// ────────────────────────────────────────────────────────────────────────
// 4. search_funding_schemes — return curated UK fund URLs to scrape.
// ────────────────────────────────────────────────────────────────────────
// In the full build this returns *URLs* and the agent then calls Bright Data
// MCP's scrape_as_markdown on each to verify open/closed status. Without the
// MCP token, the agent should call get_fallback_funds instead.
// ────────────────────────────────────────────────────────────────────────
export const search_funding_schemes = tool({
  description:
    "Return a curated list of UK funding-scheme landing-page URLs that are eligible for the given intervention types. The agent should then scrape each URL via the Bright Data MCP `scrape_as_markdown` tool to verify open/closed status. If Bright Data MCP is unavailable, fall back to `get_fallback_funds`.",
  inputSchema: z.object({
    intervention_types: z
      .array(z.string())
      .describe("e.g. ['street_trees','cool_roofs']"),
    geography: z.string().optional().describe("LSOA, borough, or region"),
  }),
  execute: async ({ intervention_types }) => {
    const funds = await loadFunds()
    const matched = funds.filter((f) =>
      f.covered_interventions.some((c) =>
        intervention_types.some((it) => c.includes(it) || it.includes(c))
      )
    )
    return {
      candidate_urls: matched.map((f) => ({ name: f.name, url: f.url })),
      note:
        "Scrape these URLs with Bright Data MCP `scrape_as_markdown` to verify current status. If MCP is unavailable, call get_fallback_funds.",
    }
  },
})

// ────────────────────────────────────────────────────────────────────────
// 5. get_fallback_funds — hand-verified profiles when scraping fails.
// ────────────────────────────────────────────────────────────────────────
export const get_fallback_funds = tool({
  description:
    "Return hand-verified fallback profiles for UK funding schemes. Use ONLY when search_funding_schemes + Bright Data scraping is unavailable. The agent must disclose use of fallback in the dossier.",
  inputSchema: z.object({
    intervention_types: z.array(z.string()),
  }),
  execute: async ({ intervention_types }) => {
    const funds = await loadFunds()
    const matched = funds.filter((f) =>
      f.covered_interventions.some((c) =>
        intervention_types.some((it) => c.includes(it) || it.includes(c))
      )
    )
    return {
      verified_via: "fallback" as const,
      funds: matched,
      disclosure:
        "Funds verified via hand-curated fallback file (last updated by maintainer). Live-scrape verification was not available.",
    }
  },
})

// ────────────────────────────────────────────────────────────────────────
// 6. scrape_funding_page — live scrape via Bright Data Web Unlocker.
// ────────────────────────────────────────────────────────────────────────
// Calls Bright Data's Web Unlocker REST API to fetch a funding page that
// would otherwise be blocked / dynamic. The agent uses this on each URL
// returned by search_funding_schemes to verify open/closed status.
//
// Requires BRIGHT_DATA_TOKEN. Optional BRIGHT_DATA_ZONE (defaults to
// "web_unlocker1" — the default zone name new accounts get).
// ────────────────────────────────────────────────────────────────────────
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export const scrape_funding_page = tool({
  description:
    "Live-scrape a UK funding scheme page via Bright Data Web Unlocker. Returns the page text (truncated). Use this on each candidate URL from search_funding_schemes to verify open/closed status, deadlines, and grant ceilings before recommending a fund. Surface anything you find about deadlines, eligibility, max grant, and match requirements in your dossier.",
  inputSchema: z.object({
    url: z.string().url().describe("Funding scheme landing-page URL to scrape"),
  }),
  execute: async ({ url }) => {
    const token = process.env.BRIGHT_DATA_TOKEN
    if (!token) {
      return {
        error:
          "BRIGHT_DATA_TOKEN not set. Cannot live-scrape — fall back to get_fallback_funds and disclose in dossier.",
      }
    }
    const zone = process.env.BRIGHT_DATA_ZONE ?? "web_unlocker1"
    try {
      const r = await fetch("https://api.brightdata.com/request", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ zone, url, format: "raw" }),
      })
      if (!r.ok) {
        const errText = await r.text().catch(() => "")
        return {
          error: `Bright Data returned ${r.status}: ${errText.slice(0, 300)}`,
          url,
        }
      }
      const html = await r.text()
      const text = htmlToText(html).slice(0, 1500)
      return {
        url,
        scraped_via: "bright_data_web_unlocker" as const,
        zone,
        bytes: html.length,
        text,
      }
    } catch (e) {
      return {
        error: `Bright Data request failed: ${e instanceof Error ? e.message : String(e)}`,
        url,
      }
    }
  },
})

// ────────────────────────────────────────────────────────────────────────
// 7. web_search — broad discovery via Bright Data → DuckDuckGo HTML.
// ────────────────────────────────────────────────────────────────────────
// The curated funds-fallback list is small and the URLs it yields tend to
// 404 / get blocked. This tool gives the agent a way to find *current* UK
// funding pages, council schemes, news-of-grants articles, etc, then feed
// the URLs it finds into `scrape_funding_page`.
//
// We hit DuckDuckGo's HTML endpoint via Bright Data Web Unlocker for
// stability — DDG's HTML markup is far more parseable than Google's, and
// the Web Unlocker handles bot detection. Returns up to `max_results`
// entries with title, url, and snippet.
// ────────────────────────────────────────────────────────────────────────
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
}

function parseDdgResults(
  html: string,
  max: number
): Array<{ title: string; url: string; snippet: string }> {
  // Don't try to scope to a parent <div class="result"> — DDG's nested
  // structure trips greedy regexes. Instead, walk all result__a anchors and
  // result__snippet anchors independently and zip them by order.
  const links: Array<{ title: string; url: string }> = []
  const linkRe =
    /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) && links.length < max) {
    let url = m[1]
    if (url.startsWith("//")) url = "https:" + url
    const uddg = /[?&]uddg=([^&]+)/.exec(url)
    if (uddg) url = decodeURIComponent(uddg[1])
    if (!url.startsWith("http")) continue
    const title = stripTags(m[2])
    if (title && url) links.push({ title, url })
  }
  const snippets: string[] = []
  const snipRe =
    /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let s: RegExpExecArray | null
  while ((s = snipRe.exec(html))) snippets.push(stripTags(s[1]))
  return links.map((l, i) => ({
    ...l,
    snippet: (snippets[i] ?? "").slice(0, 240),
  }))
}

// Bing fallback parser — a different SERP HTML shape.
function parseBingResults(
  html: string,
  max: number
): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = []
  // Each organic result is wrapped in <li class="b_algo">.
  const itemRe = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(html)) && results.length < max) {
    const block = m[1]
    const titleMatch = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!titleMatch) continue
    const url = titleMatch[1]
    if (!url.startsWith("http")) continue
    const title = stripTags(titleMatch[2])
    // Bing's snippet is in <p> or <div class="b_caption"><p>...
    const snipMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    const snippet = snipMatch ? stripTags(snipMatch[1]) : ""
    results.push({ title, url, snippet: snippet.slice(0, 240) })
  }
  return results
}

async function brightDataFetch(url: string, token: string, zone: string) {
  const r = await fetch("https://api.brightdata.com/request", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ zone, url, format: "raw" }),
  })
  return r
}

export const web_search = tool({
  description:
    "Search the open web for current UK funding announcements, council green-infrastructure schemes, or domain pages — anything not in the curated fallback list. Returns up to `max_results` URLs with titles and snippets. Use this BEFORE search_funding_schemes when you suspect the curated list is stale, when scrapes return empty, or when probing for less-obvious funds (lottery community grants, charitable trusts, water-company schemes, BID levies, ULEZ scrappage offshoots). Then feed the URLs to scrape_funding_page.",
  inputSchema: z.object({
    query: z.string().describe("Free-text search query"),
    max_results: z.number().int().min(1).max(10).default(6),
  }),
  execute: async ({ query, max_results }) => {
    const token = process.env.BRIGHT_DATA_TOKEN
    if (!token) {
      return {
        error:
          "BRIGHT_DATA_TOKEN not set. Cannot run web search — proceed with search_funding_schemes / get_fallback_funds.",
      }
    }
    const zone = process.env.BRIGHT_DATA_ZONE ?? "web_unlocker1"
    // Try DDG (html.duckduckgo.com is more parser-friendly than the SPA at
    // duckduckgo.com), then fall back to Bing if DDG returns nothing.
    const attempts: Array<{ engine: string; url: string }> = [
      { engine: "duckduckgo", url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}` },
      { engine: "bing", url: `https://www.bing.com/search?q=${encodeURIComponent(query)}` },
    ]
    let lastDiagnostic: { engine: string; status: number; bytes: number; sample: string } | null = null
    for (const a of attempts) {
      try {
        const r = await brightDataFetch(a.url, token, zone)
        if (!r.ok) {
          const errText = await r.text().catch(() => "")
          lastDiagnostic = {
            engine: a.engine,
            status: r.status,
            bytes: errText.length,
            sample: errText.slice(0, 200),
          }
          continue
        }
        const html = await r.text()
        const results =
          a.engine === "duckduckgo"
            ? parseDdgResults(html, max_results)
            : parseBingResults(html, max_results)
        if (results.length > 0) {
          return {
            query,
            engine: `${a.engine} (via Bright Data)`,
            results,
            note: "Pass interesting URLs to scrape_funding_page to verify status / extract details.",
          }
        }
        lastDiagnostic = {
          engine: a.engine,
          status: r.status,
          bytes: html.length,
          // Strip the head + scripts so the sample is more useful for debug.
          sample: stripTags(html.slice(0, 4000)).slice(0, 240),
        }
      } catch (e) {
        lastDiagnostic = {
          engine: a.engine,
          status: -1,
          bytes: 0,
          sample: e instanceof Error ? e.message : String(e),
        }
      }
    }
    return {
      query,
      results: [],
      diagnostic: lastDiagnostic,
      note:
        "Both DuckDuckGo and Bing failed to return parseable results. Either Bright Data is returning a captcha / block page, or the page format has changed. Try a more specific query, or proceed with search_funding_schemes + get_fallback_funds.",
    }
  },
})

export const tools = {
  get_lsoa_context,
  query_lsoa_subset,
  search_evidence,
  web_search,
  search_funding_schemes,
  scrape_funding_page,
  get_fallback_funds,
}
