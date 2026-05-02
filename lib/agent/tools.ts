import { tool } from "ai"
import { z } from "zod"
import { promises as fs } from "node:fs"
import path from "node:path"
import { serverSupabase } from "@/lib/supabase"

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

// Per-LSOA cache from Supabase (fetched on demand). Avoids loading the entire
// dataset into memory when only one LSOA is needed per request.
const _lsoaSingleCache = new Map<string, LsoaRecord>()

async function loadLsoaFromSupabase(code: string): Promise<LsoaRecord | null> {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return null
  }
  if (_lsoaSingleCache.has(code)) return _lsoaSingleCache.get(code)!
  try {
    const supa = serverSupabase()
    const { data, error } = await supa
      .from("lsoas")
      .select("data")
      .eq("lsoa_code", code)
      .maybeSingle()
    if (error || !data?.data) return null
    const rec = data.data as LsoaRecord
    _lsoaSingleCache.set(code, rec)
    return rec
  } catch {
    return null
  }
}

async function loadLsoas(): Promise<Record<string, LsoaRecord>> {
  if (_lsoaCache) return _lsoaCache
  // Read every per-city JSON we have on disk; merge into one map. Supabase is
  // the canonical source once loaded, but the on-disk files are the fast path
  // for dev and fallback for any LSOA that didn't make it into the DB yet.
  const dir = path.join(process.cwd(), "public", "data")
  const files = await fs.readdir(dir)
  const merged: Record<string, LsoaRecord> = {}
  for (const f of files) {
    if (!/^lsoas(-[a-z]+)?\.json$/.test(f)) continue
    try {
      const raw = await fs.readFile(path.join(dir, f), "utf-8")
      Object.assign(merged, JSON.parse(raw))
    } catch (e) {
      console.error(`[loadLsoas] failed to parse ${f}`, e)
    }
  }
  _lsoaCache = merged
  return _lsoaCache
}

/**
 * Resolve one LSOA — Supabase first, then bundled JSON fallback.
 * Used by every tool that takes an lsoa_code. Cheap on hot path because of
 * per-code memoisation.
 */
async function getLsoa(code: string): Promise<LsoaRecord | null> {
  const fromDb = await loadLsoaFromSupabase(code)
  if (fromDb) return fromDb
  const all = await loadLsoas()
  return all[code] ?? null
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
    const lsoa = await getLsoa(lsoa_code)
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
    const lsoa = await getLsoa(lsoa_code)
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

// ────────────────────────────────────────────────────────────────────────
// 8. intervention_catalogue — broad menu of UK adaptation archetypes.
// ────────────────────────────────────────────────────────────────────────
// Replaces the inline example list in the prompt (which biased the agent
// toward 4–5 same-y interventions per LSOA). Each entry carries axis tags
// (heat / flood / both), indicative cost band, maintenance burden, and the
// archetypes it suits — the agent uses these to widen its option surface.
// ────────────────────────────────────────────────────────────────────────
type CatalogueEntry = {
  archetype: string
  category: "trees-and-canopy" | "roofs-and-walls" | "ground-and-paving" | "water-management" | "shade-and-public-realm" | "depave-and-naturalise"
  axes: ("heat" | "flood")[]
  description: string
  typical_unit: string
  cost_band: "low" | "mid" | "high"
  maintenance_burden: "low" | "mid" | "high"
  suits: string[]            // archetypes this fits well
  caveats?: string
}

const INTERVENTION_CATALOGUE: CatalogueEntry[] = [
  // Trees & canopy
  { archetype: "Semi-mature street trees (London plane / lime / hornbeam)", category: "trees-and-canopy", axes: ["heat", "flood"], description: "In-pavement plantings on residential or high-street footways, providing shade and modest interception/SUDS effect.", typical_unit: "trees", cost_band: "mid", maintenance_burden: "mid", suits: ["Victorian/Edwardian residential terrace", "Mixed retail high street", "Park-edge residential", "Interwar suburb"] },
  { archetype: "Pocket woodland on under-used verge / corner plot", category: "trees-and-canopy", axes: ["heat", "flood"], description: "Small dense planting (Miyawaki-style or naturalistic) on council-owned scrap parcels — fast canopy, biodiversity uplift.", typical_unit: "m²", cost_band: "low", maintenance_burden: "mid", suits: ["Post-war estate", "Industrial / former industrial", "Tower-block estate"] },
  { archetype: "School-playground tree planting + depave", category: "trees-and-canopy", axes: ["heat", "flood"], description: "Replace tarmac at school margins with shade trees + permeable surfacing. Hits child-vulnerability axis hard.", typical_unit: "trees", cost_band: "mid", maintenance_burden: "low", suits: ["School-and-church cluster", "Post-war estate"] },
  { archetype: "Hedgerow / front-garden re-greening campaign", category: "trees-and-canopy", axes: ["heat", "flood"], description: "Borough-funded grants to residents for pulling up paved front gardens and replanting with hedge/shrub. Attenuates surface runoff and cools.", typical_unit: "m²", cost_band: "low", maintenance_burden: "low", suits: ["Victorian/Edwardian residential terrace", "Interwar suburb"], caveats: "Uptake-dependent — requires resident engagement budget." },

  // Roofs & walls
  { archetype: "Cool-roof retrofit (high-albedo coating) on flat roofs", category: "roofs-and-walls", axes: ["heat"], description: "White / reflective coating applied to existing flat roofs of social housing, schools, civic buildings. Cheap per-m² and fast.", typical_unit: "m²", cost_band: "low", maintenance_burden: "low", suits: ["Post-war estate", "Tower-block estate", "Industrial / former industrial", "1960s-70s council low-rise"] },
  { archetype: "Extensive green roof retrofit (sedum)", category: "roofs-and-walls", axes: ["heat", "flood"], description: "Lightweight sedum mat over existing flat roof. Modest cooling, real flood-attenuation, biodiversity uplift, BNG units.", typical_unit: "m²", cost_band: "mid", maintenance_burden: "mid", suits: ["Post-war estate", "Modern infill / new build", "1960s-70s council low-rise"], caveats: "Structural-load survey required." },
  { archetype: "Living wall on south/west-facing civic building", category: "roofs-and-walls", axes: ["heat"], description: "Vertical greening on a single high-visibility wall — civic-pride / demonstrator beat as much as the cooling itself.", typical_unit: "m²", cost_band: "high", maintenance_burden: "high", suits: ["Mixed retail high street", "School-and-church cluster"], caveats: "High maintenance — only viable with named long-term steward." },

  // Ground & paving
  { archetype: "Permeable paving on residential side-streets", category: "ground-and-paving", axes: ["flood"], description: "Replace impermeable footway / parking bay surfacing with permeable block paving. Direct surface-water attenuation.", typical_unit: "m²", cost_band: "mid", maintenance_burden: "low", suits: ["Victorian/Edwardian residential terrace", "Interwar suburb", "Post-war estate"] },
  { archetype: "Depave + reseed under-used hardstanding (estate margins)", category: "depave-and-naturalise", axes: ["heat", "flood"], description: "Remove redundant tarmac on estate edges and reseed as wildflower / amenity grass. Cooling AND infiltration AND biodiversity.", typical_unit: "m²", cost_band: "low", maintenance_burden: "low", suits: ["Post-war estate", "Tower-block estate", "1960s-70s council low-rise", "Industrial / former industrial"] },

  // Water management (SuDS family)
  { archetype: "Raingardens at junction build-outs", category: "water-management", axes: ["flood", "heat"], description: "Engineered planted depressions at street corners that intercept road runoff before it hits the gully. Strong flood signal, modest cooling.", typical_unit: "raingardens", cost_band: "mid", maintenance_burden: "mid", suits: ["Victorian/Edwardian residential terrace", "Mixed retail high street", "Riverside / canal-side"] },
  { archetype: "Bioswales along residential streets", category: "water-management", axes: ["flood"], description: "Linear vegetated channels alongside the kerb that move and filter surface water. Larger footprint than raingardens.", typical_unit: "linear_m", cost_band: "mid", maintenance_burden: "mid", suits: ["Interwar suburb", "Post-war estate"] },
  { archetype: "Daylighting / partial-naturalisation of culverted watercourse", category: "water-management", axes: ["flood", "heat"], description: "Open up a previously-buried stream segment as a naturalised channel — significant flood capacity, evaporative cooling, biodiversity hero project.", typical_unit: "linear_m", cost_band: "high", maintenance_burden: "mid", suits: ["Riverside / canal-side", "Industrial / former industrial"], caveats: "Requires EA consent + multi-year scoping. Flagship-scale only." },
  { archetype: "Estate attenuation pond / detention basin", category: "water-management", axes: ["flood"], description: "Engineered surface storage of stormwater on under-used estate land — protects downstream surface-water flooding receptors.", typical_unit: "m²", cost_band: "high", maintenance_burden: "mid", suits: ["Post-war estate", "Tower-block estate"] },

  // Shade & public realm
  { archetype: "Shade structures at bus stops / school gates / market squares", category: "shade-and-public-realm", axes: ["heat"], description: "Lightweight permanent shade canopies over fixed waiting / dwell points — cheapest per shaded-person-hour, especially for over-65 and under-5.", typical_unit: "structures", cost_band: "low", maintenance_burden: "low", suits: ["Mixed retail high street", "School-and-church cluster", "Post-war estate"] },
  { archetype: "Pedestrian widening with associated shade trees", category: "shade-and-public-realm", axes: ["heat"], description: "Reallocate carriageway space to wider footways and embed plane / lime trees in the new build-out. Crucial repackaging route — unlocks Active Travel England funds beyond pure climate budgets.", typical_unit: "linear_m", cost_band: "high", maintenance_burden: "mid", suits: ["Mixed retail high street", "Victorian/Edwardian terrace high-street"] },
  { archetype: "Mister / hydration / cooling-centre upgrade in a public building", category: "shade-and-public-realm", axes: ["heat"], description: "Convert under-used civic indoor space (library, leisure centre) into a designated cooling refuge with extended summer hours.", typical_unit: "structures", cost_band: "low", maintenance_burden: "low", suits: ["Post-war estate", "Tower-block estate", "Mixed retail high street"], caveats: "Operational cost not capital cost — councils undervalue it." },

  // Naturalisation
  { archetype: "Wildflower / meadow conversion of amenity grassland", category: "depave-and-naturalise", axes: ["heat", "flood"], description: "Stop mowing under-used council grass and convert to wildflower meadow. Near-zero cost, biodiversity + BNG + modest cooling.", typical_unit: "m²", cost_band: "low", maintenance_burden: "low", suits: ["Park-edge residential", "Post-war estate", "Interwar suburb"] },
]

export const intervention_catalogue = tool({
  description:
    "Return the full menu of UK climate-adaptation intervention archetypes available to consider — across trees & canopy, roofs & walls, ground & paving, water management (SuDS), shade & public realm, and depaving. Each entry carries axis tags (heat / flood / both), cost band, maintenance burden, and the place archetypes it suits. Call this ONCE in Step 3 before shortlisting interventions, and use it to widen your option surface beyond the obvious. The agent's job is to PICK from this menu (or invent close variants for the specific place); not to default to trees+roofs every time.",
  inputSchema: z.object({
    archetype_filter: z
      .string()
      .optional()
      .describe(
        "Optional: place-archetype string. If supplied, results are scored by fit to the archetype but the full catalogue is still returned."
      ),
  }),
  execute: async ({ archetype_filter }) => {
    const entries = INTERVENTION_CATALOGUE.map((e) => {
      const fit = archetype_filter
        ? e.suits.some((s) => s.toLowerCase() === archetype_filter.toLowerCase())
          ? "strong-fit"
          : e.suits.some((s) =>
              s.toLowerCase().includes(archetype_filter.toLowerCase().split(" ")[0])
            )
          ? "partial-fit"
          : "weak-fit"
        : undefined
      return { ...e, ...(fit ? { archetype_fit: fit } : {}) }
    })
    return {
      catalogue: entries,
      note:
        "Pick interventions that match this LSOA's archetype + hypotheses. Surface combined-axis (heat AND flood) options when feasible — they're under-used by most planners.",
    }
  },
})

// ────────────────────────────────────────────────────────────────────────
// 9. propose_intervention — externalises the agent's decision-making.
// ────────────────────────────────────────────────────────────────────────
// The agent calls this once per candidate (status: considering / accepted /
// dropped) so the UI can render the live "interventions banner". Reusing an
// id updates the same banner card. This makes "considered and dropped"
// candidates a first-class part of the dossier, not a paragraph.
//
// The tool itself is a no-op server-side — it just echoes the input back.
// The value is in the streamed tool-call event the UI subscribes to.
// ────────────────────────────────────────────────────────────────────────
export const propose_intervention = tool({
  description:
    "Externalise an intervention decision so the UI can render a live decision banner. Call ONCE per candidate when first considering it (status: 'considering'), then call AGAIN with the same id to update to 'accepted' (after evidence is in) or 'dropped' (if you reject it). Provide a short rationale and any evidence references on the final call. At least 2 dropped candidates should be surfaced — proof of decision-making is critical to the trustworthiness of the dossier.",
  inputSchema: z.object({
    id: z.string().describe("Stable id you choose; reuse across status updates"),
    name: z.string(),
    status: z.enum(["considering", "accepted", "dropped"]),
    axes_addressed: z.array(z.enum(["heat", "flood"])).optional(),
    rationale: z.string().describe("One-sentence reason for this status"),
    target_streets: z.array(z.string()).optional(),
    evidence_quality: z.enum(["strong", "moderate", "weak"]).optional(),
    catalogue_archetype: z.string().optional(),
  }),
  execute: async (input) => {
    return { ok: true, ...input, recorded_at: new Date().toISOString() }
  },
})

// ────────────────────────────────────────────────────────────────────────
// 10. critique_funding_match — adversarial review of fund-intervention pairs.
// ────────────────────────────────────────────────────────────────────────
// Kept deliberately mechanical (returns a structured prompt frame), so the
// agent uses it as a forced critique step rather than a free-form rumination.
// Realistic coverage in the dossier is the agent's responsibility — this
// tool just makes the heuristic explicit and visible.
// ────────────────────────────────────────────────────────────────────────
export const critique_funding_match = tool({
  description:
    "Force a structured critical review of one fund-intervention pairing. Returns a checklist of risk factors the agent must address: award probability (applicants per award), match-funding gap, timing reality, geographic/political fit, capacity caps, past awardee patterns. Call ONCE per fund in Step 6 — even funds that look 'open' may have low realistic award probability. Use the response to set realistic award_probability and match_secured_pct in the final dossier JSON.",
  inputSchema: z.object({
    fund_name: z.string(),
    fund_url: z.string().optional(),
    intervention_ids: z.array(z.string()).describe("Which interventions this fund covers"),
    scraped_text_excerpt: z.string().optional().describe("Any relevant scraped text already captured"),
  }),
  execute: async ({ fund_name, intervention_ids }) => {
    return {
      fund_name,
      checklist: [
        {
          axis: "award_probability",
          prompt:
            "Estimate applicants per award. If unknown: competitive funds default ≤ 0.30, formula/non-competitive ≤ 0.60. Search for 'past awardees' or 'previous round results' if scraping captured them.",
        },
        {
          axis: "match_funding_gap",
          prompt:
            "Does this fund require match funding? If yes, what % and where would it come from? Unsourced match = realistic coverage from this fund is 0.",
        },
        {
          axis: "timing_reality",
          prompt:
            "Time between today and the deadline. Funds closing in <8 weeks are usually unusable for fresh schemes (no time to scope + secure matchin).",
        },
        {
          axis: "geographic_political_fit",
          prompt:
            "Is this fund explicitly rural / northern / urban / regional in its eligibility? Mismatches kill applications even when the technical scope fits.",
        },
        {
          axis: "capacity_caps",
          prompt:
            "Does this fund cap applications per applicant per cycle? Has the borough already submitted to this round?",
        },
        {
          axis: "past_awardee_patterns",
          prompt:
            "If past awardees are listed: same boroughs winning repeatedly? New entrants ignored? Type of project they actually fund?",
        },
      ],
      instruction:
        `For each axis, answer briefly in your response, then assign realistic award_probability (0–1) and match_secured_pct (0–100) for ${fund_name} → ${intervention_ids.join(", ")} in the final dossier JSON.`,
    }
  },
})

// ────────────────────────────────────────────────────────────────────────
// 11. compare_to_similar_lsoas — pick 2 nearest-neighbour LSOAs in the same
//     city for archetype-matched comparison. Lets the agent point at past
//     analyses (saved Supabase rows) to argue "this proposal differs because…".
// ────────────────────────────────────────────────────────────────────────
//
// Uses a cheap k-NN: same city, similar vulnerability score (±0.1) and
// similar canopy. Returns 2 codes + names + their parsed_dossier headline if
// they've been previously analysed (otherwise just the metadata).
// ────────────────────────────────────────────────────────────────────────
export const compare_to_similar_lsoas = tool({
  description:
    "Find 2 nearest-neighbour LSOAs in the same city — similar vulnerability score, IMD decile, and canopy cover. If they've been previously analysed in this session, returns their dossier headlines; otherwise just metadata. Use this in Step 8 to argue why your proposal for THIS LSOA differs from what neighbours did. Skip if the city has too few analysed neighbours.",
  inputSchema: z.object({
    lsoa_code: z.string(),
    k: z.number().int().min(1).max(4).default(2),
  }),
  execute: async ({ lsoa_code, k }) => {
    const target = await getLsoa(lsoa_code)
    if (!target) return { error: `Target LSOA ${lsoa_code} not found` }
    const all = await loadLsoas()
    const candidates = Object.entries(all)
      .filter(([code, v]) => {
        if (code === lsoa_code) return false
        const sameCity = (v as LsoaRecord & { city?: string }).city ===
          (target as LsoaRecord & { city?: string }).city
        return sameCity
      })
      .map(([code, v]) => {
        const dv = Math.abs((v.vulnerability_score ?? 0.5) - (target.vulnerability_score ?? 0.5))
        const dc = Math.abs((v.canopy_cover_pct ?? 10) - (target.canopy_cover_pct ?? 10)) / 30
        const di = Math.abs((v.imd_decile ?? 5) - (target.imd_decile ?? 5)) / 10
        const dist = dv * 0.6 + dc * 0.25 + di * 0.15
        return { code, record: v, dist }
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, k)

    // If Supabase is configured, look up previous parsed_dossier headlines.
    let priorAnalyses: Record<string, { area_name: string | null; headline?: string | null }> = {}
    if (
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      try {
        const supa = serverSupabase()
        const { data } = await supa
          .from("analyses")
          .select("lsoa_code, area_name, parsed_dossier")
          .in(
            "lsoa_code",
            candidates.map((c) => c.code)
          )
        if (data) {
          for (const row of data) {
            const head = row.parsed_dossier?.vulnerability_summary?.headline
              ?? row.parsed_dossier?.place_archetype
              ?? null
            priorAnalyses[row.lsoa_code] = {
              area_name: row.area_name ?? null,
              headline: head,
            }
          }
        }
      } catch {
        // ignore — agent gets metadata only
      }
    }

    return {
      target_lsoa: lsoa_code,
      neighbours: candidates.map((c) => ({
        lsoa_code: c.code,
        name: c.record.name,
        vulnerability_score: c.record.vulnerability_score,
        imd_decile: c.record.imd_decile,
        canopy_cover_pct: c.record.canopy_cover_pct,
        prior_analysis: priorAnalyses[c.code] ?? null,
        distance: Math.round(c.dist * 1000) / 1000,
      })),
    }
  },
})

export const tools = {
  get_lsoa_context,
  query_lsoa_subset,
  intervention_catalogue,
  propose_intervention,
  search_evidence,
  web_search,
  search_funding_schemes,
  scrape_funding_page,
  get_fallback_funds,
  critique_funding_match,
  compare_to_similar_lsoas,
}
