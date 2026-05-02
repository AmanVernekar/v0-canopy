/**
 * Load Canopy LSOA JSON files into Supabase.
 *
 * Prereq: schema migration applied (paste supabase/migrations/0001_init.sql
 * into Supabase Dashboard → SQL Editor).
 *
 * Usage:
 *    node load-supabase.mjs                    # all per-city files in public/data/
 *    node load-supabase.mjs london             # one city only
 *
 * Reads .env.local for SUPABASE_URL + SERVICE_ROLE_KEY.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

// ── Tiny .env.local loader (no dependency on dotenv) ──
const envText = readFileSync(".env.local", "utf-8")
for (const line of envText.split("\n")) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error("✘ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}
const supa = createClient(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const ONLY = process.argv[2] // optional city slug

const DATA_DIR = "public/data"
const files = readdirSync(DATA_DIR)
  .filter((f) => /^lsoas-([a-z]+)\.json$/.test(f))
  .filter((f) => !ONLY || f === `lsoas-${ONLY}.json`)

if (files.length === 0) {
  console.error(`✘ No lsoas-*.json files found in ${DATA_DIR}`)
  process.exit(1)
}

const BATCH = 100

for (const file of files) {
  const slug = /^lsoas-([a-z]+)\.json$/.exec(file)[1]
  console.log(`▸ ${file}`)
  const raw = readFileSync(join(DATA_DIR, file), "utf-8")
  const dataset = JSON.parse(raw)
  const codes = Object.keys(dataset)
  console.log(`  ${codes.length} LSOAs`)

  let written = 0
  for (let i = 0; i < codes.length; i += BATCH) {
    const slice = codes.slice(i, i + BATCH)
    const rows = slice.map((code) => {
      const d = dataset[code]
      return {
        lsoa_code: code,
        city: d.city ?? slug,
        lad_name: d.lad_name ?? null,
        name: d.name,
        vulnerability_score: d.vulnerability_score ?? null,
        vulnerability_flood: d.vulnerability_flood ?? null,
        imd_decile: d.imd_decile ?? null,
        canopy_cover_pct: d.canopy_cover_pct ?? null,
        population: d.population ?? null,
        pop_density_per_ha: d.pop_density_per_ha ?? null,
        pct_over_65: d.pct_over_65 ?? null,
        pct_under_5: d.pct_under_5 ?? null,
        building_count: d.building_count ?? 0,
        data: d,
      }
    })

    const { error } = await supa
      .from("lsoas")
      .upsert(rows, { onConflict: "lsoa_code" })
    if (error) {
      console.error(`  ✘ batch ${i}-${i + slice.length}: ${error.message}`)
      process.exit(1)
    }
    written += slice.length
    if (i % (BATCH * 5) === 0) console.log(`    ${written}/${codes.length}`)
  }
  console.log(`  ✓ wrote ${written} rows for ${slug}`)
}

console.log("✓ done")
