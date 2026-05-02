"use client"

import { useEffect, useRef, useCallback } from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { motion, AnimatePresence } from "framer-motion"
import {
  Thermometer,
  Trees,
  Building2,
  Users,
  RefreshCw,
  AlertCircle,
  Activity,
} from "lucide-react"
import { useCanopyStore } from "@/lib/store"
import type { ParsedDossier } from "@/lib/store"
import { ReasoningTrace } from "@/components/reasoning-trace"
import { DossierView } from "@/components/dossier-view"

function StatCard({
  icon: Icon,
  label,
  value,
  unit,
  color = "text-zinc-300",
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  value: number | string
  unit?: string
  color?: string
}) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-md p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={11} className="text-zinc-600" />
        <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">
          {label}
        </span>
      </div>
      <p className={`text-base font-mono font-medium ${color}`}>
        {value}
        {unit && <span className="text-xs text-zinc-600 ml-1">{unit}</span>}
      </p>
    </div>
  )
}

function extractDossier(text: string): ParsedDossier | null {
  try {
    const match = text.match(/```json\s*([\s\S]*?)```/)
    if (!match) return null
    return JSON.parse(match[1]) as ParsedDossier
  } catch {
    return null
  }
}

function extractMarkdown(text: string): string {
  // Return text before the JSON fenced block
  const idx = text.indexOf("```json")
  return idx > 0 ? text.slice(0, idx).trim() : text
}

export function AgentPanel() {
  // Granular selectors so we can verify each piece of state independently.
  // (Investigating why selectedFeature reads as null even when the agent is
  // running — see lib/store.ts singleton notes.)
  const selectedLsoa = useCanopyStore((s) => s.selectedLsoa)
  const lsoaData = useCanopyStore((s) => s.lsoaData)
  const isAgentRunning = useCanopyStore((s) => s.isAgentRunning)
  const setIsAgentRunning = useCanopyStore((s) => s.setIsAgentRunning)
  const parsedDossier = useCanopyStore((s) => s.parsedDossier)
  const setParsedDossier = useCanopyStore((s) => s.setParsedDossier)
  const setStreamingText = useCanopyStore((s) => s.setStreamingText)
  const streamingText = useCanopyStore((s) => s.streamingText)

  if (typeof window !== "undefined") {
    // eslint-disable-next-line no-console
    console.log("[AgentPanel render]", {
      selectedLsoa,
      lsoaCount: Object.keys(lsoaData).length,
      hit: selectedLsoa ? !!lsoaData[selectedLsoa] : null,
    })
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  const prevSelectedRef = useRef<string | null>(null)

  const selectedFeature = selectedLsoa ? lsoaData[selectedLsoa] : null

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/agent" }),
  })

  // Auto-run agent when a new LSOA is selected
  useEffect(() => {
    if (!selectedLsoa || selectedLsoa === prevSelectedRef.current) return
    if (status === "streaming" || status === "submitted") return
    prevSelectedRef.current = selectedLsoa
    setIsAgentRunning(true)
    setParsedDossier(null)
    setStreamingText("")
    sendMessage({ text: selectedLsoa })
  }, [selectedLsoa, status, sendMessage, setIsAgentRunning, setParsedDossier, setStreamingText])

  // Track running state
  useEffect(() => {
    setIsAgentRunning(status === "streaming" || status === "submitted")
  }, [status, setIsAgentRunning])

  // Extract full text for dossier parsing
  const fullText = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")

  // Track streaming text
  useEffect(() => {
    setStreamingText(fullText)
  }, [fullText, setStreamingText])

  // Parse dossier once streaming is done
  useEffect(() => {
    if (status === "ready" && fullText && !parsedDossier) {
      const parsed = extractDossier(fullText)
      if (parsed) setParsedDossier(parsed)
    }
  }, [status, fullText, parsedDossier, setParsedDossier])

  // Auto-scroll reasoning trace
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streamingText])

  const handleRetry = useCallback(() => {
    if (!selectedLsoa) return
    setParsedDossier(null)
    setStreamingText("")
    prevSelectedRef.current = null
  }, [selectedLsoa, setParsedDossier, setStreamingText])

  const assistantMessages = messages.filter((m) => m.role === "assistant")

  return (
    <div className="h-full flex flex-col gap-0 overflow-hidden">
      {/* ─── Selected area card ─── */}
      <div className="flex-shrink-0 border-b border-zinc-800/60 p-4">
        <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-3">
          Selected area
        </p>
        <AnimatePresence mode="wait">
          {!selectedFeature ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-zinc-600 text-xs font-mono py-2"
            >
              Click any area on the map to begin.
            </motion.div>
          ) : (
            <motion.div
              key={selectedLsoa}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="mb-2.5">
                <p className="text-base font-medium text-zinc-100 leading-tight">
                  {selectedFeature.name}
                </p>
                <p className="text-[10px] font-mono text-zinc-500 mt-0.5">
                  {selectedLsoa}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <StatCard
                  icon={Thermometer}
                  label="Vulnerability"
                  value={selectedFeature.vulnerability_score.toFixed(2)}
                  color={
                    selectedFeature.vulnerability_score >= 0.7
                      ? "text-red-400"
                      : selectedFeature.vulnerability_score >= 0.5
                      ? "text-amber-400"
                      : "text-green-400"
                  }
                />
                <StatCard
                  icon={Trees}
                  label="Canopy cover"
                  value={selectedFeature.canopy_cover_pct.toFixed(1)}
                  unit="%"
                />
                <StatCard
                  icon={Building2}
                  label="IMD decile"
                  value={selectedFeature.imd_decile}
                />
                <StatCard
                  icon={Users}
                  label="Pop. density"
                  value={selectedFeature.pop_density_per_ha.toFixed(0)}
                  unit="/ha"
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ─── Agent reasoning ─── */}
      <div className="flex-shrink-0 flex items-center gap-2 px-4 pt-4 pb-2">
        <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest flex-1">
          Agent reasoning
        </p>
        {isAgentRunning && (
          <motion.div
            animate={{ opacity: [1, 0.4] }}
            transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
            className="flex items-center gap-1 text-[9px] font-mono text-cyan-400"
          >
            <Activity size={9} />
            <span>Running</span>
          </motion.div>
        )}
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 space-y-3"
        style={{ scrollbarWidth: "thin", scrollbarColor: "#27272a transparent" }}
      >
        {/* Error state */}
        {error && (
          <div className="flex items-start gap-2 bg-red-950/30 border border-red-900/50 rounded-md p-3">
            <AlertCircle size={13} className="text-red-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs text-red-300 mb-2">Analysis failed. {error.message}</p>
              <button
                onClick={handleRetry}
                className="flex items-center gap-1.5 text-[10px] font-mono text-red-400 hover:text-red-300 transition-colors"
              >
                <RefreshCw size={10} />
                Retry
              </button>
            </div>
          </div>
        )}

        <ReasoningTrace
          messages={assistantMessages}
          isStreaming={isAgentRunning}
          streamingText={streamingText}
        />
      </div>

      {/* ─── Dossier ─── */}
      <AnimatePresence>
        {parsedDossier && (
          <motion.div
            key="dossier"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            className="flex-shrink-0 border-t border-zinc-800/60 overflow-hidden"
          >
            <div className="p-4">
              <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-3">
                Dossier
              </p>
              <DossierView
                dossier={parsedDossier}
                rawMarkdown={extractMarkdown(fullText)}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
