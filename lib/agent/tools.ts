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
// 1. get_lsoa_context — token-efficient profile of the LSOA. Always first.
// ────────────────────────────────────────────────────────────────────────
export const get_lsoa_context = tool({
  description:
    "Get the full context profile for a specific LSOA (Lower Super Output Area). Returns vulnerability indicators, demographics, canopy cover, deprivation, and a summary of street/building stock. Always call this FIRST for any new LSOA.",
  inputSchema: z.object({
    lsoa_code: z.string().describe("LSOA 2021 code, e.g. E01003911"),
  }),
  execute: async ({ lsoa_code }) => {
    const data = await loadLsoas()
    const lsoa = data[lsoa_code]
    if (!lsoa) return { error: `LSOA ${lsoa_code} not found in dataset` }

    // Token-efficient: omit the bulky streets/buildings arrays here, return summary stats.
    const highwayBreakdown: Record<string, number> = {}
    for (const s of lsoa.streets) {
      const h = s.highway ?? "unknown"
      highwayBreakdown[h] = (highwayBreakdown[h] ?? 0) + 1
    }

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
      named_streets_sample: lsoa.streets
        .filter((s) => s.name)
        .slice(0, 8)
        .map((s) => s.name),
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
        items: items.slice(0, 50).map((s) => ({ id: s.id, name: s.name, highway: s.highway })),
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

export const tools = {
  get_lsoa_context,
  query_lsoa_subset,
  search_evidence,
  search_funding_schemes,
  get_fallback_funds,
}
