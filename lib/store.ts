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

export interface Intervention {
  type: string
  title: string
  rationale_short: string
  estimated_cost_gbp: number
  target_locations: InterventionLocation[]
}

export interface ParsedDossier {
  lsoa_code: string
  summary: string
  interventions: Intervention[]
  total_estimated_cost_gbp: number
  priority_level: string
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
  setSelectedLsoa: (code: string | null) => void
  setLsoaData: (data: LsoaData) => void
  setIsAgentRunning: (running: boolean) => void
  setAgentMessages: (messages: AgentMessage[]) => void
  appendAgentMessage: (msg: AgentMessage) => void
  setParsedDossier: (dossier: ParsedDossier | null) => void
  setStreamingText: (text: string) => void
  resetAgent: () => void
}

export const useCanopyStore = create<CanopyStore>((set) => ({
  selectedLsoa: null,
  lsoaData: {},
  isAgentRunning: false,
  agentMessages: [],
  parsedDossier: null,
  streamingText: "",

  setSelectedLsoa: (code) => set({ selectedLsoa: code }),
  setLsoaData: (data) => set({ lsoaData: data }),
  setIsAgentRunning: (running) => set({ isAgentRunning: running }),
  setAgentMessages: (messages) => set({ agentMessages: messages }),
  appendAgentMessage: (msg) =>
    set((s) => ({ agentMessages: [...s.agentMessages, msg] })),
  setParsedDossier: (dossier) => set({ parsedDossier: dossier }),
  setStreamingText: (text) => set({ streamingText: text }),
  resetAgent: () =>
    set({
      isAgentRunning: false,
      agentMessages: [],
      parsedDossier: null,
      streamingText: "",
    }),
}))
