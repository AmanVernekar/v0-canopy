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
import { InterventionsBanner } from "@/components/interventions-banner"
import { InfoTooltip, TERM_DEFINITIONS } from "@/components/info-tooltip"
import { resolveAreaName } from "@/lib/area-name"
import { getSessionId } from "@/lib/session"
import type { UIMessage } from "ai"

function StatCard({
  icon: Icon,
  label,
  value,
  unit,
  color = "text-ink",
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
    <div className="bg-paper-elevated border border-line rounded-md p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={11} className="text-ink-subtle" />
        <span className="text-[9px] font-mono text-ink-subtle uppercase tracking-widest">
          {label}
        </span>
        {tooltip && <InfoTooltip title={tooltip.title} body={tooltip.body} />}
      </div>
      <p className={`text-base font-mono font-medium ${color}`}>
        {value}
        {unit && <span className="text-xs text-ink-subtle ml-1">{unit}</span>}
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
  const criticEnabled = useCanopyStore((s) => s.criticEnabled)
  const setCriticEnabled = useCanopyStore((s) => s.setCriticEnabled)

  const scrollRef = useRef<HTMLDivElement>(null)
  const prevSelectedRef = useRef<string | null>(null)
  const [followupText, setFollowupText] = useState("")

  const selectedFeature = selectedLsoa ? lsoaData[selectedLsoa] : null

  const { messages, sendMessage, status, error, setMessages, stop } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/agent",
      // Read the current value of the critic toggle at send-time, not at
      // hook-init time, so flipping the toggle takes effect on the next run
      // without re-mounting the chat.
      body: () => ({ criticEnabled: useCanopyStore.getState().criticEnabled }),
    }),
  })

  // Auto-run agent when a new LSOA is selected. If a saved analysis exists
  // for this (session, lsoa) in Supabase, hydrate it instead of re-running.
  useEffect(() => {
    if (!selectedLsoa || selectedLsoa === prevSelectedRef.current) return
    if (status === "streaming" || status === "submitted") return
    prevSelectedRef.current = selectedLsoa
    setParsedDossier(null)
    setStreamingText("")
    setSelectedAreaName(null)
    setMessages([])

    let cancelled = false
    const sid = getSessionId()
    ;(async () => {
      // Try restoring a previous analysis. Silent failure means we just run
      // the agent fresh.
      try {
        if (sid) {
          const r = await fetch(
            `/api/analyses?session=${encodeURIComponent(sid)}&lsoa=${encodeURIComponent(selectedLsoa)}`
          )
          if (r.status === 200) {
            const row = await r.json()
            if (cancelled) return
            const restoredMessages = (row?.messages ?? []) as UIMessage[]
            const restoredDossier = (row?.parsed_dossier ?? null) as ParsedDossier | null
            if (Array.isArray(restoredMessages) && restoredMessages.length > 0) {
              setMessages(restoredMessages)
              if (restoredDossier) setParsedDossier(restoredDossier)
              if (row?.area_name) setSelectedAreaName(row.area_name)
              return
            }
          }
        }
      } catch {
        // proceed to fresh run
      }
      if (cancelled) return
      setIsAgentRunning(true)
      sendMessage({ text: selectedLsoa })
    })()

    return () => {
      cancelled = true
    }
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

  // Persist completed turns to Supabase so the dossier survives a refresh
  // and re-clicking the LSOA hydrates instantly. Best-effort — silent failure.
  useEffect(() => {
    if (status !== "ready" || !selectedLsoa || messages.length === 0) return
    const sid = getSessionId()
    if (!sid) return
    const parsed = extractDossier(fullText)
    fetch("/api/analyses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sid,
        lsoa_code: selectedLsoa,
        area_name: selectedAreaName,
        messages,
        parsed_dossier: parsed,
        critic_enabled: criticEnabled,
      }),
    }).catch(() => {
      /* silent */
    })
  }, [status, selectedLsoa, messages, fullText, selectedAreaName, criticEnabled])

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
      <div className="flex-shrink-0 border-b border-line p-4">
        <p className="text-[9px] font-mono text-ink-subtle uppercase tracking-widest mb-3 flex items-center gap-1.5">
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
              className="text-ink-subtle text-xs font-mono py-2"
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
                <p className="text-base font-medium text-ink leading-tight">
                  {selectedAreaName ?? selectedFeature.name}
                </p>
                <p className="text-[10px] font-mono text-ink-muted mt-0.5">
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
                      ? "text-heat-deep"
                      : selectedFeature.vulnerability_score >= 0.5
                      ? "text-heat"
                      : "text-success"
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

      {/* ─── Live interventions banner — fed by propose_intervention tool ─── */}
      {messages.length > 0 && (
        <div className="flex-shrink-0 px-4 pt-3">
          <InterventionsBanner messages={messages} />
        </div>
      )}

      {/* ─── Agent reasoning ─── */}
      <div className="flex-shrink-0 flex items-center gap-2 px-4 pt-4 pb-2">
        <p className="text-[9px] font-mono text-ink-subtle uppercase tracking-widest flex-1">
          Agent reasoning
        </p>
        {/* Critic-pass toggle. Adversarial self-review at the end — extra
            tokens, off by default. Disabled while a run is in flight. */}
        <button
          type="button"
          onClick={() => setCriticEnabled(!criticEnabled)}
          disabled={isAgentRunning}
          aria-pressed={criticEnabled}
          title="When on, the agent runs an adversarial review pass after the dossier and may revise it."
          className={`flex items-center gap-1 text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border transition-colors disabled:opacity-50 ${
            criticEnabled
              ? "bg-evidence-soft border-evidence/50 text-evidence-deep"
              : "bg-paper-deep border-line-strong text-ink-subtle hover:text-ink-muted"
          }`}
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              criticEnabled ? "bg-evidence" : "bg-ink-faint"
            }`}
          />
          <span>Critic</span>
        </button>
        {isAgentRunning && (
          <>
            <motion.div
              animate={{ opacity: [1, 0.4] }}
              transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
              className="flex items-center gap-1 text-[9px] font-mono text-evidence"
            >
              <Activity size={9} />
              <span>Running</span>
            </motion.div>
            <button
              onClick={() => stop()}
              className="flex items-center gap-1 text-[9px] font-mono text-danger hover:text-heat-deep bg-heat-soft/60 hover:bg-heat-soft border border-danger/40 rounded px-1.5 py-0.5 transition-colors uppercase tracking-widest"
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
          <div className="flex items-start gap-2 bg-heat-soft border border-danger/30 rounded-md p-3">
            <AlertCircle size={13} className="text-danger flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs text-heat-deep mb-2">Analysis failed. {error.message}</p>
              <button
                onClick={handleRetry}
                className="flex items-center gap-1.5 text-[10px] font-mono text-danger hover:text-heat-deep transition-colors"
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
              className="border-t border-line pt-4 mt-4"
            >
              <p className="text-[9px] font-mono text-ink-subtle uppercase tracking-widest mb-3">
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
          <div className="border-t border-line pt-4 mt-4">
            <p className="text-[9px] font-mono text-ink-subtle uppercase tracking-widest mb-3 flex items-center gap-1.5">
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
        <div className="flex-shrink-0 border-t border-line p-3 bg-paper-elevated">
          <div className="flex items-center gap-1.5 mb-2">
            <MessageSquare size={10} className="text-ink-subtle" />
            <p className="text-[9px] font-mono text-ink-subtle uppercase tracking-widest">
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
              className="flex-1 bg-paper border border-line rounded-md px-3 py-2 text-[12px] text-ink placeholder:text-ink-subtle focus:outline-none focus:border-evidence/60 transition-colors disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isAgentRunning || !followupText.trim()}
              className="flex items-center gap-1.5 bg-evidence-soft hover:bg-evidence-soft/80 disabled:opacity-30 disabled:cursor-not-allowed border border-evidence/40 rounded-md px-3 py-2 text-[11px] font-mono text-evidence-deep transition-colors"
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
