"use client"

import { useEffect, useRef, useCallback, useState } from "react"
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
  Send,
  MessageSquare,
  Square as SquareIcon,
} from "lucide-react"
import { useCanopyStore } from "@/lib/store"
import type { ParsedDossier } from "@/lib/store"
import { ReasoningTrace } from "@/components/reasoning-trace"
import { DossierView } from "@/components/dossier-view"
import { InfoTooltip, TERM_DEFINITIONS } from "@/components/info-tooltip"
import { resolveAreaName } from "@/lib/area-name"

function StatCard({
  icon: Icon,
  label,
  value,
  unit,
  color = "text-zinc-300",
  tooltip,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  value: number | string
  unit?: string
  color?: string
  tooltip?: { title: string; body: React.ReactNode }
}) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-md p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={11} className="text-zinc-600" />
        <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">
          {label}
        </span>
        {tooltip && <InfoTooltip title={tooltip.title} body={tooltip.body} />}
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
    // Find the LAST fenced JSON block (so follow-up turns can update the dossier).
    const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
    if (matches.length === 0) return null
    const last = matches[matches.length - 1][1]
    return JSON.parse(last) as ParsedDossier
  } catch {
    return null
  }
}

function extractMarkdown(text: string): string {
  return text.replace(/```json[\s\S]*?```/g, "").trim()
}

export function AgentPanel() {
  const selectedLsoa = useCanopyStore((s) => s.selectedLsoa)
  const lsoaData = useCanopyStore((s) => s.lsoaData)
  const isAgentRunning = useCanopyStore((s) => s.isAgentRunning)
  const setIsAgentRunning = useCanopyStore((s) => s.setIsAgentRunning)
  const parsedDossier = useCanopyStore((s) => s.parsedDossier)
  const setParsedDossier = useCanopyStore((s) => s.setParsedDossier)
  const setStreamingText = useCanopyStore((s) => s.setStreamingText)
  const streamingText = useCanopyStore((s) => s.streamingText)
  const selectedAreaName = useCanopyStore((s) => s.selectedAreaName)
  const setSelectedAreaName = useCanopyStore((s) => s.setSelectedAreaName)

  const scrollRef = useRef<HTMLDivElement>(null)
  const prevSelectedRef = useRef<string | null>(null)
  const [followupText, setFollowupText] = useState("")

  const selectedFeature = selectedLsoa ? lsoaData[selectedLsoa] : null

  const { messages, sendMessage, status, error, setMessages, stop } = useChat({
    transport: new DefaultChatTransport({ api: "/api/agent" }),
  })

  // Auto-run agent when a new LSOA is selected, and reset chat state.
  useEffect(() => {
    if (!selectedLsoa || selectedLsoa === prevSelectedRef.current) return
    if (status === "streaming" || status === "submitted") return
    prevSelectedRef.current = selectedLsoa
    setIsAgentRunning(true)
    setParsedDossier(null)
    setStreamingText("")
    setSelectedAreaName(null)
    setMessages([])
    sendMessage({ text: selectedLsoa })
  }, [
    selectedLsoa,
    status,
    sendMessage,
    setIsAgentRunning,
    setParsedDossier,
    setStreamingText,
    setSelectedAreaName,
    setMessages,
  ])

  // Resolve a friendly area name when an LSOA is selected.
  useEffect(() => {
    if (!selectedLsoa || !selectedFeature) return
    let cancelled = false
    resolveAreaName(selectedLsoa, selectedFeature.geometry).then((name) => {
      if (!cancelled) setSelectedAreaName(name)
    })
    return () => {
      cancelled = true
    }
  }, [selectedLsoa, selectedFeature, setSelectedAreaName])

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
    .join("\n\n")

  // Track streaming text
  useEffect(() => {
    setStreamingText(fullText)
  }, [fullText, setStreamingText])

  // Parse / re-parse dossier whenever a turn completes (so follow-ups can
  // emit an updated JSON block and refresh the map).
  useEffect(() => {
    if (status !== "ready" || !fullText) return
    const parsed = extractDossier(fullText)
    if (parsed) setParsedDossier(parsed)
  }, [status, fullText, setParsedDossier])

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
    setMessages([])
    prevSelectedRef.current = null
  }, [selectedLsoa, setParsedDossier, setStreamingText, setMessages])

  const handleSendFollowup = useCallback(() => {
    const t = followupText.trim()
    if (!t || isAgentRunning) return
    setFollowupText("")
    sendMessage({ text: t })
  }, [followupText, isAgentRunning, sendMessage])

  // Split messages into the initial run vs follow-ups so the dossier can sit
  // *between* them — follow-up Q&A then naturally renders at the bottom and
  // the user doesn't have to scroll up past the dossier to see their answer.
  const firstAssistantIdx = messages.findIndex((m) => m.role === "assistant")
  const initialMessages =
    firstAssistantIdx === -1 ? messages : messages.slice(0, firstAssistantIdx + 1)
  const followupMessages =
    firstAssistantIdx === -1 ? [] : messages.slice(firstAssistantIdx + 1)
  const isStreamingFollowup = isAgentRunning && followupMessages.length > 0
  const isStreamingInitial = isAgentRunning && !isStreamingFollowup

  return (
    <div className="h-full flex flex-col gap-0 overflow-hidden">
      {/* ─── Selected area card ─── */}
      <div className="flex-shrink-0 border-b border-zinc-800/60 p-4">
        <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-3 flex items-center gap-1.5">
          Selected area
          <InfoTooltip {...TERM_DEFINITIONS.lsoa} />
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
                  {selectedAreaName ?? selectedFeature.name}
                </p>
                <p className="text-[10px] font-mono text-zinc-500 mt-0.5">
                  {selectedAreaName
                    ? `${selectedFeature.name} · ${selectedLsoa}`
                    : selectedLsoa}
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
                  tooltip={TERM_DEFINITIONS.vulnerability}
                />
                <StatCard
                  icon={Trees}
                  label="Canopy cover"
                  value={selectedFeature.canopy_cover_pct.toFixed(1)}
                  unit="%"
                  tooltip={TERM_DEFINITIONS.canopy}
                />
                <StatCard
                  icon={Building2}
                  label="IMD decile"
                  value={selectedFeature.imd_decile}
                  tooltip={TERM_DEFINITIONS.imd}
                />
                <StatCard
                  icon={Users}
                  label="Pop. density"
                  value={selectedFeature.pop_density_per_ha.toFixed(0)}
                  unit="/ha"
                  tooltip={TERM_DEFINITIONS.density}
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
          <>
            <motion.div
              animate={{ opacity: [1, 0.4] }}
              transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
              className="flex items-center gap-1 text-[9px] font-mono text-cyan-400"
            >
              <Activity size={9} />
              <span>Running</span>
            </motion.div>
            <button
              onClick={() => stop()}
              className="flex items-center gap-1 text-[9px] font-mono text-red-400 hover:text-red-300 bg-red-400/10 hover:bg-red-400/20 border border-red-400/30 rounded px-1.5 py-0.5 transition-colors uppercase tracking-widest"
              aria-label="Stop analysis"
            >
              <SquareIcon size={8} fill="currentColor" />
              <span>Stop</span>
            </button>
          </>
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
          messages={initialMessages}
          isStreaming={isStreamingInitial}
          streamingText={streamingText}
        />

        {/* ── Dossier panel sits between the initial run and any follow-ups ── */}
        <AnimatePresence>
          {parsedDossier && (
            <motion.div
              key="dossier"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="border-t border-zinc-800/60 pt-4 mt-4"
            >
              <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-3">
                Dossier
              </p>
              <DossierView
                dossier={parsedDossier}
                rawMarkdown={extractMarkdown(fullText)}
                areaName={selectedAreaName}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Follow-up Q&A trace, below the dossier ── */}
        {(followupMessages.length > 0 || isStreamingFollowup) && (
          <div className="border-t border-zinc-800/60 pt-4 mt-4">
            <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-3 flex items-center gap-1.5">
              <MessageSquare size={10} /> Follow-up
            </p>
            <ReasoningTrace
              messages={followupMessages}
              isStreaming={isStreamingFollowup}
              streamingText=""
              hideEmptyState
            />
          </div>
        )}
      </div>

      {/* ─── Follow-up chat input ─── */}
      {(parsedDossier || messages.length > 1) && (
        <div className="flex-shrink-0 border-t border-zinc-800/60 p-3 bg-zinc-950">
          <div className="flex items-center gap-1.5 mb-2">
            <MessageSquare size={10} className="text-zinc-600" />
            <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">
              Ask a follow-up
            </p>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleSendFollowup()
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={followupText}
              onChange={(e) => setFollowupText(e.target.value)}
              placeholder="e.g. swap shade structures for cool roofs — what changes?"
              disabled={isAgentRunning}
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-400/50 transition-colors disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isAgentRunning || !followupText.trim()}
              className="flex items-center gap-1.5 bg-cyan-400/15 hover:bg-cyan-400/25 disabled:opacity-30 disabled:cursor-not-allowed border border-cyan-400/40 rounded-md px-3 py-2 text-[11px] font-mono text-cyan-400 transition-colors"
            >
              <Send size={11} />
              Ask
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
