"use client"

import { useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  ChevronDown,
  ChevronRight,
  Database,
  Search,
  MapPin,
  FileSearch,
  Globe,
  BookOpen,
  Banknote,
  Trees,
  Zap,
} from "lucide-react"
import type { UIMessage } from "ai"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

interface ReasoningTraceProps {
  messages: UIMessage[]
  isStreaming: boolean
  streamingText: string
  // When true, the empty-state placeholder ("Awaiting analysis trigger…") is
  // suppressed. Used by the follow-up trace section that lives below the
  // dossier — it should be invisible until the user actually asks something.
  hideEmptyState?: boolean
}

// Map our tools to friendly labels and icons. The subtitle is computed from
// the live tool args so the trace reads "Pulling literature · street trees,
// UK temperate" instead of a static string that's the same for every call.
type ArgsRecord = Record<string, unknown>

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}
function asStringArray(v: unknown): string[] | null {
  return Array.isArray(v)
    ? (v.filter((x) => typeof x === "string" && x.trim()) as string[])
    : null
}
function shortHost(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "")
  } catch {
    return u
  }
}

interface ToolMeta {
  label: string
  icon: React.ComponentType<{ size?: number }>
  defaultSub: string
  describe?: (args: ArgsRecord | undefined) => string | null
}

const TOOL_META: Record<string, ToolMeta> = {
  get_lsoa_context: {
    label: "Reading LSOA profile",
    icon: Database,
    defaultSub: "vulnerability · canopy · demographics · streets",
    describe: (args) => {
      const code = asString(args?.lsoa_code)
      return code ? `LSOA ${code} — vulnerability · canopy · demographics` : null
    },
  },
  query_lsoa_subset: {
    label: "Probing the data",
    icon: MapPin,
    defaultSub: "filtering streets / buildings to test a hypothesis",
    describe: (args) => {
      const target = asString(args?.target)
      const filters = (args?.filters as ArgsRecord | undefined) ?? {}
      const highways = asStringArray(filters?.highway_in)
      const namedOnly = filters?.named_only === true
      const parts: string[] = []
      if (target) parts.push(target)
      if (highways?.length) parts.push(highways.join(", "))
      if (namedOnly) parts.push("named only")
      return parts.length ? parts.join(" · ") : null
    },
  },
  search_evidence: {
    label: "Pulling literature",
    icon: BookOpen,
    defaultSub: "peer-reviewed cooling-effect studies (OpenAlex)",
    describe: (args) => {
      const intervention = asString(args?.intervention)
      const climate = asString(args?.climate_context)
      if (!intervention) return null
      return climate
        ? `cooling evidence for ${intervention} (${climate})`
        : `cooling evidence for ${intervention}`
    },
  },
  web_search: {
    label: "Searching the web",
    icon: Search,
    defaultSub: "DuckDuckGo via Bright Data — looking for current funds & news",
    describe: (args) => {
      const q = asString(args?.query)
      return q ? `“${q}”` : null
    },
  },
  search_funding_schemes: {
    label: "Shortlisting funds",
    icon: Banknote,
    defaultSub: "matching interventions to UK funding URLs",
    describe: (args) => {
      const types = asStringArray(args?.intervention_types)
      if (!types?.length) return null
      return `funds covering ${types.slice(0, 3).join(", ")}${
        types.length > 3 ? "…" : ""
      }`
    },
  },
  scrape_funding_page: {
    label: "Live scraping fund page",
    icon: Globe,
    defaultSub: "Bright Data Web Unlocker — verifying status & deadline",
    describe: (args) => {
      const url = asString(args?.url)
      return url ? shortHost(url) : null
    },
  },
  get_fallback_funds: {
    label: "Loading fallback funds",
    icon: FileSearch,
    defaultSub: "hand-verified profiles (live scrape unavailable)",
    describe: (args) => {
      const types = asStringArray(args?.intervention_types)
      return types?.length
        ? `fallbacks for ${types.slice(0, 3).join(", ")}${types.length > 3 ? "…" : ""}`
        : null
    },
  },
  intervention_catalogue: {
    label: "Browsing intervention menu",
    icon: BookOpen,
    defaultSub: "trees · roofs · paving · SuDS · shade · depave",
    describe: (args) => {
      const a = asString(args?.archetype_filter)
      return a ? `filtered for ${a}` : null
    },
  },
  propose_intervention: {
    label: "Logging intervention",
    icon: Zap,
    defaultSub: "considered / accepted / dropped",
    describe: (args) => {
      const name = asString(args?.name)
      const status = asString(args?.status)
      if (!name) return null
      return status ? `${status}: ${name}` : name
    },
  },
  critique_funding_match: {
    label: "Critiquing fund match",
    icon: Banknote,
    defaultSub: "award probability · match gap · timing · politics",
    describe: (args) => {
      const f = asString(args?.fund_name)
      return f ? `stress-test ${f}` : null
    },
  },
  compare_to_similar_lsoas: {
    label: "Comparing neighbourhoods",
    icon: MapPin,
    defaultSub: "nearest-neighbour LSOAs in this city",
    describe: (args) => {
      const code = asString(args?.lsoa_code)
      return code ? `near ${code}` : null
    },
  },
}

function getToolMeta(
  toolName: string,
  args?: ArgsRecord
): { label: string; icon: React.ComponentType<{ size?: number }>; sub: string } {
  const meta = TOOL_META[toolName]
  if (!meta) {
    return {
      label: toolName.replace(/_/g, " "),
      icon: Zap,
      sub: "",
    }
  }
  const dyn = meta.describe?.(args)
  return {
    label: meta.label,
    icon: meta.icon,
    sub: dyn ?? meta.defaultSub,
  }
}

interface ToolPart {
  type: string
  toolInvocation?: {
    toolName: string
    toolCallId: string
    state: string
    args?: unknown
    result?: unknown
  }
  toolName?: string
  state?: string
  input?: unknown
  output?: unknown
}

function ToolCallCard({ part }: { part: ToolPart }) {
  const [expanded, setExpanded] = useState(false)
  // AI SDK v6 emits parts as { type: "tool-<name>", state, input, output }.
  // Older v5 shape used "tool-invocation" with .toolInvocation. Support both.
  let toolName: string
  let state: string
  let args: unknown
  let result: unknown
  if (part.toolInvocation) {
    toolName = part.toolInvocation.toolName
    state = part.toolInvocation.state
    args = part.toolInvocation.args
    result = part.toolInvocation.result
  } else {
    toolName =
      part.toolName ?? (part.type.startsWith("tool-") ? part.type.slice(5) : part.type)
    state = part.state ?? "input-available"
    args = part.input
    result = part.output
  }

  const meta = getToolMeta(
    toolName,
    args && typeof args === "object" ? (args as ArgsRecord) : undefined
  )
  const Icon = meta.icon
  const isComplete =
    state === "result" || state === "output-available" || result != null

  return (
    <motion.div
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      className="border-l-2 border-evidence/40 bg-paper-elevated rounded-r-md overflow-hidden"
    >
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-paper-deep transition-colors text-left"
      >
        <div
          className={`flex-shrink-0 w-6 h-6 rounded flex items-center justify-center mt-0.5 ${
            isComplete ? "bg-evidence-soft text-evidence-deep" : "bg-paper-deep text-ink-muted"
          }`}
        >
          <Icon size={12} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[12px] text-ink">{meta.label}</span>
            <span
              className={`text-[8px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${
                isComplete
                  ? "text-evidence-deep bg-evidence-soft/70"
                  : "text-ink-subtle bg-paper-deep animate-pulse"
              }`}
            >
              {isComplete ? "done" : "running"}
            </span>
          </div>
          {meta.sub && (
            <p className="text-[10px] text-ink-muted font-mono mt-0.5 truncate">
              {meta.sub}
            </p>
          )}
        </div>
        {isComplete && (
          <span className="text-ink-subtle ml-1 mt-1">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </button>

      <AnimatePresence>
        {expanded && isComplete && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 pt-1 space-y-2 border-t border-line">
              {args != null && (
                <div>
                  <p className="text-[9px] font-mono text-ink-subtle uppercase tracking-widest mb-1">
                    Input
                  </p>
                  <pre className="text-[10px] font-mono text-ink-muted bg-paper-deep rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                    {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
                  </pre>
                </div>
              )}
              {result != null && (
                <div>
                  <p className="text-[9px] font-mono text-ink-subtle uppercase tracking-widest mb-1">
                    Result
                  </p>
                  <pre className="text-[10px] font-mono text-ink bg-paper-deep rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-48">
                    {typeof result === "string"
                      ? result
                      : JSON.stringify(result, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function StreamingCursor() {
  return (
    <motion.span
      animate={{ opacity: [1, 0] }}
      transition={{ duration: 0.7, repeat: Infinity }}
      className="inline-block w-[2px] h-[14px] bg-evidence ml-0.5 align-middle"
    />
  )
}

const STEP_RE = /^##\s*Step\s+(\d+)\s*[·•:.\-]\s*(.+?)\s*$/i

interface ParsedTextSegment {
  type: "step" | "prose"
  step?: number
  title?: string
  text: string
}

// Split a streaming text part into Step banners + intervening prose so we can
// render the agent's structured workflow as bold separators.
function parseTextIntoSegments(text: string): ParsedTextSegment[] {
  const lines = text.split("\n")
  const segments: ParsedTextSegment[] = []
  let buffer: string[] = []

  const flushBuffer = () => {
    const t = buffer.join("\n").trim()
    if (t) segments.push({ type: "prose", text: t })
    buffer = []
  }

  for (const line of lines) {
    const m = STEP_RE.exec(line)
    if (m) {
      flushBuffer()
      segments.push({
        type: "step",
        step: parseInt(m[1], 10),
        title: m[2].trim(),
        text: line,
      })
    } else {
      buffer.push(line)
    }
  }
  flushBuffer()
  return segments
}

function StepBanner({ step, title }: { step: number; title: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-stretch gap-2 mt-3 mb-1"
    >
      <div className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded bg-evidence-soft text-evidence-deep font-mono text-[11px] font-semibold border border-evidence/40">
        {step}
      </div>
      <div className="flex-1 flex flex-col justify-center border-l border-evidence/30 pl-2.5">
        <p className="text-[9px] font-mono text-evidence-deep uppercase tracking-widest">
          Step {step}
        </p>
        <p className="text-[13px] font-semibold text-ink leading-tight">
          {title}
        </p>
      </div>
    </motion.div>
  )
}

function TextBlock({
  text,
  isLast,
  isStreaming,
}: {
  text: string
  isLast: boolean
  isStreaming: boolean
}) {
  // Strip the JSON dossier block from visible text
  const visibleText = text.replace(/```json[\s\S]*?```/g, "").replace(/```json[\s\S]*$/, "")
  if (!visibleText.trim()) return null

  const segments = parseTextIntoSegments(visibleText)

  return (
    <div className="space-y-1.5">
      {segments.map((seg, i) => {
        if (seg.type === "step") {
          return (
            <StepBanner
              key={`step-${i}`}
              step={seg.step!}
              title={seg.title!}
            />
          )
        }
        const isLastSegment = i === segments.length - 1
        return (
          <div key={`prose-${i}`} className="prose-canopy" suppressHydrationWarning>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {seg.text}
            </ReactMarkdown>
            {isLast && isLastSegment && isStreaming && <StreamingCursor />}
          </div>
        )
      })}
    </div>
  )
}

export function ReasoningTrace({
  messages,
  isStreaming,
  streamingText,
  hideEmptyState = false,
}: ReasoningTraceProps) {
  if (messages.length === 0 && !isStreaming) {
    if (hideEmptyState) return null
    return (
      <div className="flex-1 flex items-center justify-center py-6">
        <div className="text-center space-y-2">
          <Trees size={20} className="text-ink-faint mx-auto" />
          <p className="text-ink-subtle text-xs font-mono">
            Awaiting analysis trigger…
          </p>
          <p className="text-ink-faint text-[10px] font-mono">
            Click an LSOA to start the agent
          </p>
        </div>
      </div>
    )
  }

  const elements: React.ReactNode[] = []

  messages.forEach((msg, msgIdx) => {
    if (!msg.parts) return
    msg.parts.forEach((part, partIdx) => {
      const key = `${msgIdx}-${partIdx}`
      const isLastPart =
        msgIdx === messages.length - 1 && partIdx === msg.parts.length - 1

      if (part.type === "text") {
        // For user messages, render as a small chip so follow-ups are visible
        if (msg.role === "user") {
          elements.push(
            <div
              key={key}
              className="flex items-start gap-2 mt-3 mb-1 pl-2 border-l-2 border-line-strong"
            >
              <p className="text-[11px] text-ink-muted italic">
                <span className="text-[9px] font-mono uppercase tracking-widest text-ink-subtle mr-1.5">
                  Planner
                </span>
                {(part as { text: string }).text}
              </p>
            </div>
          )
        } else {
          elements.push(
            <TextBlock
              key={key}
              text={(part as { text: string }).text}
              isLast={isLastPart}
              isStreaming={isStreaming}
            />
          )
        }
      } else if (
        part.type === "tool-invocation" ||
        part.type.startsWith("tool-")
      ) {
        elements.push(<ToolCallCard key={key} part={part as ToolPart} />)
      }
    })
  })

  // Show a "Thinking…" indicator whenever the agent is mid-flight but the last
  // visible content isn't actively streaming text (i.e. between tool calls,
  // before the first token, or after a tool result while the model decides
  // what to do next). Patterned after Claude Code's idle indicator so users
  // don't think the UI has hung.
  const lastMsg = messages[messages.length - 1]
  const lastPart = lastMsg?.parts?.[lastMsg.parts.length - 1]
  const lastPartType = (lastPart as { type?: string } | undefined)?.type
  const lastIsActiveText =
    lastMsg?.role === "assistant" && lastPartType === "text"
  const showThinking = isStreaming && !lastIsActiveText

  return (
    <div className="space-y-2 text-[12px]">
      {elements}
      {messages.length === 0 && streamingText && (
        <TextBlock text={streamingText} isLast isStreaming={isStreaming} />
      )}
      {showThinking && <ThinkingIndicator />}
    </div>
  )
}

function ThinkingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex items-center gap-2 py-1.5 pl-1"
    >
      <motion.span
        animate={{ opacity: [0.3, 1, 0.3] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        className="text-[12px] font-mono text-evidence-deep/80 italic"
      >
        Thinking
      </motion.span>
      <div className="flex gap-0.5">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            animate={{ opacity: [0.2, 1, 0.2] }}
            transition={{
              duration: 1.4,
              repeat: Infinity,
              ease: "easeInOut",
              delay: i * 0.18,
            }}
            className="w-1 h-1 rounded-full bg-evidence"
          />
        ))}
      </div>
    </motion.div>
  )
}
