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

interface ReasoningTraceProps {
  messages: UIMessage[]
  isStreaming: boolean
  streamingText: string
}

// Map our 6 tool names to friendly labels and icons so the trace reads like
// a human-readable workflow log, not a function-call dump.
const TOOL_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ size?: number }>; sub: string }
> = {
  get_lsoa_context: {
    label: "Reading LSOA profile",
    icon: Database,
    sub: "vulnerability · canopy · demographics · streets",
  },
  query_lsoa_subset: {
    label: "Probing the data",
    icon: MapPin,
    sub: "filtering streets / buildings to test a hypothesis",
  },
  search_evidence: {
    label: "Pulling literature",
    icon: BookOpen,
    sub: "OpenAlex peer-reviewed cooling-effect studies",
  },
  search_funding_schemes: {
    label: "Shortlisting funds",
    icon: Banknote,
    sub: "matching interventions to UK funding URLs",
  },
  scrape_funding_page: {
    label: "Live scraping fund page",
    icon: Globe,
    sub: "Bright Data Web Unlocker — verifying status & deadline",
  },
  get_fallback_funds: {
    label: "Loading fallback funds",
    icon: FileSearch,
    sub: "hand-verified profiles (live scrape unavailable)",
  },
}

function getToolMeta(toolName: string) {
  return (
    TOOL_META[toolName] ?? {
      label: toolName.replace(/_/g, " "),
      icon: Zap,
      sub: "",
    }
  )
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

  const meta = getToolMeta(toolName)
  const Icon = meta.icon
  const isComplete =
    state === "result" || state === "output-available" || result != null

  return (
    <motion.div
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      className="border-l-2 border-cyan-400/30 bg-zinc-900/60 rounded-r-md overflow-hidden"
    >
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-zinc-800/40 transition-colors text-left"
      >
        <div
          className={`flex-shrink-0 w-6 h-6 rounded flex items-center justify-center mt-0.5 ${
            isComplete ? "bg-cyan-400/15 text-cyan-400" : "bg-zinc-700/60 text-zinc-500"
          }`}
        >
          <Icon size={12} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[12px] text-zinc-200">{meta.label}</span>
            <span
              className={`text-[8px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${
                isComplete
                  ? "text-cyan-400/80 bg-cyan-400/10"
                  : "text-zinc-600 bg-zinc-800 animate-pulse"
              }`}
            >
              {isComplete ? "done" : "running"}
            </span>
          </div>
          {meta.sub && (
            <p className="text-[10px] text-zinc-500 font-mono mt-0.5 truncate">
              {meta.sub}
            </p>
          )}
        </div>
        {isComplete && (
          <span className="text-zinc-600 ml-1 mt-1">
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
            <div className="px-3 pb-3 pt-1 space-y-2 border-t border-zinc-800/60">
              {args != null && (
                <div>
                  <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-1">
                    Input
                  </p>
                  <pre className="text-[10px] font-mono text-zinc-400 bg-zinc-950/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                    {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
                  </pre>
                </div>
              )}
              {result != null && (
                <div>
                  <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-1">
                    Result
                  </p>
                  <pre className="text-[10px] font-mono text-zinc-300 bg-zinc-950/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-48">
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
      className="inline-block w-[2px] h-[14px] bg-cyan-400 ml-0.5 align-middle"
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
      <div className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded bg-cyan-400/15 text-cyan-400 font-mono text-[11px] font-semibold border border-cyan-400/30">
        {step}
      </div>
      <div className="flex-1 flex flex-col justify-center border-l border-cyan-400/20 pl-2.5">
        <p className="text-[9px] font-mono text-cyan-400 uppercase tracking-widest">
          Step {step}
        </p>
        <p className="text-[13px] font-semibold text-zinc-100 leading-tight">
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
          <p
            key={`prose-${i}`}
            className="text-[12px] leading-relaxed text-zinc-300 font-sans whitespace-pre-wrap"
            suppressHydrationWarning
          >
            {seg.text}
            {isLast && isLastSegment && isStreaming && <StreamingCursor />}
          </p>
        )
      })}
    </div>
  )
}

export function ReasoningTrace({
  messages,
  isStreaming,
  streamingText,
}: ReasoningTraceProps) {
  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="flex-1 flex items-center justify-center py-6">
        <div className="text-center space-y-2">
          <Trees size={20} className="text-zinc-700 mx-auto" />
          <p className="text-zinc-600 text-xs font-mono">
            Awaiting analysis trigger…
          </p>
          <p className="text-zinc-700 text-[10px] font-mono">
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
              className="flex items-start gap-2 mt-3 mb-1 pl-2 border-l-2 border-zinc-700"
            >
              <p className="text-[11px] text-zinc-500 italic">
                <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-600 mr-1.5">
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

  return (
    <div className="space-y-2 text-[12px]">
      {elements}
      {messages.length === 0 && streamingText && (
        <TextBlock text={streamingText} isLast isStreaming={isStreaming} />
      )}
    </div>
  )
}
