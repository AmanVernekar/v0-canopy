import { create } from "zustand"

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

// Matches the JSON schema in context.md exactly.
export interface Intervention {
  type: string
  quantity: number
  unit: "trees" | "m²" | "structures" | "roofs" | string
  rationale_short: string
  target_locations: InterventionLocation[]
  indicative_cost_gbp: number
  evidence_effect_size: string
  evidence_quality: "strong" | "moderate" | "weak"
}

export interface Fund {
  name: string
  status: "open" | "closing_soon" | "scheduled" | "unclear"
  verified_via: "scraped" | "fallback"
  deadline: string | null
  max_grant_gbp: number
  match_required_pct: number
  covered_interventions: string[]
  eligibility_justification: string
  repackaging_note?: string
  url: string
}

export interface ParsedDossier {
  lsoa_code: string
  interventions: Intervention[]
  funds: Fund[]
  total_cost_gbp: number
  fund_coverage_pct: number
  key_trade_offs: string[]
}

export type AgentMessage =
  | { role: "assistant"; content: string; id: string }
  | { role: "tool"; toolName: string; input: unknown; output?: unknown; id: string }

interface CanopyStore {
  selectedLsoa: string | null
  lsoaData: LsoaData
  isAgentRunning: boolean
  agentMessages: AgentMessage[]
  parsedDossier: ParsedDossier | null
  streamingText: string
  // Friendly neighbourhood name (e.g. "Walworth") looked up after selection.
  selectedAreaName: string | null
  setSelectedLsoa: (code: string | null) => void
  setLsoaData: (data: LsoaData) => void
  setIsAgentRunning: (running: boolean) => void
  setAgentMessages: (messages: AgentMessage[]) => void
  appendAgentMessage: (msg: AgentMessage) => void
  setParsedDossier: (dossier: ParsedDossier | null) => void
  setStreamingText: (text: string) => void
  setSelectedAreaName: (name: string | null) => void
  resetAgent: () => void
}

export const useCanopyStore = create<CanopyStore>((set) => ({
  selectedLsoa: null,
  lsoaData: {},
  isAgentRunning: false,
  agentMessages: [],
  parsedDossier: null,
  streamingText: "",
  selectedAreaName: null,

  setSelectedLsoa: (code) => set({ selectedLsoa: code }),
  setLsoaData: (data) => set({ lsoaData: data }),
  setIsAgentRunning: (running) => set({ isAgentRunning: running }),
  setAgentMessages: (messages) => set({ agentMessages: messages }),
  appendAgentMessage: (msg) =>
    set((s) => ({ agentMessages: [...s.agentMessages, msg] })),
  setParsedDossier: (dossier) => set({ parsedDossier: dossier }),
  setStreamingText: (text) => set({ streamingText: text }),
  setSelectedAreaName: (name) => set({ selectedAreaName: name }),
  resetAgent: () =>
    set({
      isAgentRunning: false,
      agentMessages: [],
      parsedDossier: null,
      streamingText: "",
    }),
}))
