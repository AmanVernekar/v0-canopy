import { create } from "zustand"
import type { Map as MapLibreMap } from "maplibre-gl"
import type { UIMessage } from "ai"

export interface LsoaFeature {
  name: string
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
  vulnerability_score: number
  canopy_cover_pct: number
  imd_decile: number
  pop_density_per_ha: number
}

export interface LsoaData {
  [lsoaCode: string]: LsoaFeature
}

export interface InterventionLocation {
  lat: number
  lng: number
}

// Matches the JSON schema in lib/agent/prompts.ts. New fields are optional so
// dossiers from prior agent runs (older schema) still parse.
export type ClimateAxis = "heat" | "flood"

export interface Intervention {
  id?: string
  type: string
  axes_addressed?: ClimateAxis[]
  quantity: number
  unit: "trees" | "m²" | "structures" | "roofs" | "raingardens" | "linear_m" | string
  rationale_short: string
  target_locations: InterventionLocation[]
  indicative_cost_gbp: number
  annual_maintenance_gbp?: number
  lifecycle_years?: number
  evidence_effect_size: string
  evidence_quality: "strong" | "moderate" | "weak"
  co_benefits?: string[]
  equity_note?: string
}

export interface Fund {
  name: string
  status: "open" | "closing_soon" | "scheduled" | "unclear"
  verified_via: "scraped" | "fallback"
  deadline: string | null
  max_grant_gbp: number
  match_required_pct: number
  match_secured_pct?: number
  award_probability?: number
  covered_interventions: string[]
  covered_axes?: ClimateAxis[]
  eligibility_justification: string
  weaknesses?: string[]
  repackaging_note?: string
  url: string
}

export interface VulnerabilitySummary {
  heat_score?: number
  flood_score?: number
  headline?: string
}

export interface ComparableLsoa {
  lsoa_code: string
  name: string
  note: string
}

export interface ParsedDossier {
  lsoa_code: string
  place_archetype?: string
  vulnerability_summary?: VulnerabilitySummary
  interventions: Intervention[]
  funds: Fund[]
  total_cost_gbp: number
  total_annual_maintenance_gbp?: number
  /** Legacy field — kept so older parsed dossiers still surface a coverage number. */
  fund_coverage_pct?: number
  optimistic_coverage_pct?: number
  realistic_coverage_pct?: number
  counterfactual_2050?: string
  comparable_lsoas?: ComparableLsoa[]
  equity_audit?: string
  key_trade_offs: string[]
}

export type AgentMessage =
  | { role: "assistant"; content: string; id: string }
  | { role: "tool"; toolName: string; input: unknown; output?: unknown; id: string }

export type CitySlug = "london" | "manchester" | "birmingham"
export const CITIES: { slug: CitySlug; label: string; centre: [number, number]; zoom: number }[] = [
  { slug: "london", label: "Greater London", centre: [-0.118, 51.509], zoom: 9.5 },
  { slug: "manchester", label: "Manchester", centre: [-2.244, 53.479], zoom: 11 },
  { slug: "birmingham", label: "Birmingham", centre: [-1.898, 52.486], zoom: 10.5 },
]

interface CanopyStore {
  selectedCity: CitySlug
  selectedLsoa: string | null
  lsoaData: LsoaData
  isAgentRunning: boolean
  agentMessages: AgentMessage[]
  parsedDossier: ParsedDossier | null
  streamingText: string
  // Friendly neighbourhood name (e.g. "Walworth") looked up after selection.
  selectedAreaName: string | null
  // Non-reactive ref to the live MapLibre instance, set by lsoa-map.tsx on
  // mount. Used by the dossier PDF exporter to grab the rendered canvas.
  mapInstance: MapLibreMap | null
  setSelectedCity: (city: CitySlug) => void
  setSelectedLsoa: (code: string | null) => void
  setLsoaData: (data: LsoaData) => void
  setIsAgentRunning: (running: boolean) => void
  setAgentMessages: (messages: AgentMessage[]) => void
  appendAgentMessage: (msg: AgentMessage) => void
  setParsedDossier: (dossier: ParsedDossier | null) => void
  setStreamingText: (text: string) => void
  setSelectedAreaName: (name: string | null) => void
  setMapInstance: (m: MapLibreMap | null) => void
  // Critic pass — when on, the API route runs a second adversarial review
  // turn after the planner's first answer. Off by default (extra tokens).
  criticEnabled: boolean
  setCriticEnabled: (v: boolean) => void
  // Mirrored from useChat so the LeftSidebar can render the live
  // interventions banner without owning its own chat hook.
  liveMessages: UIMessage[]
  setLiveMessages: (m: UIMessage[]) => void
  resetAgent: () => void
}

export const useCanopyStore = create<CanopyStore>((set) => ({
  selectedCity: "london",
  selectedLsoa: null,
  lsoaData: {},
  isAgentRunning: false,
  agentMessages: [],
  parsedDossier: null,
  streamingText: "",
  selectedAreaName: null,
  mapInstance: null,

  setSelectedCity: (city) => set({ selectedCity: city, selectedLsoa: null }),
  setSelectedLsoa: (code) => set({ selectedLsoa: code }),
  setLsoaData: (data) => set({ lsoaData: data }),
  setIsAgentRunning: (running) => set({ isAgentRunning: running }),
  setAgentMessages: (messages) => set({ agentMessages: messages }),
  appendAgentMessage: (msg) =>
    set((s) => ({ agentMessages: [...s.agentMessages, msg] })),
  setParsedDossier: (dossier) => set({ parsedDossier: dossier }),
  setStreamingText: (text) => set({ streamingText: text }),
  setSelectedAreaName: (name) => set({ selectedAreaName: name }),
  setMapInstance: (m) => set({ mapInstance: m }),
  criticEnabled: false,
  setCriticEnabled: (v) => set({ criticEnabled: v }),
  liveMessages: [],
  setLiveMessages: (m) => set({ liveMessages: m }),
  resetAgent: () =>
    set({
      isAgentRunning: false,
      agentMessages: [],
      parsedDossier: null,
      streamingText: "",
      liveMessages: [],
    }),
}))
