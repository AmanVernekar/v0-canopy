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
  Zap,
} from "lucide-react"
import type { UIMessage } from "ai"

interface ReasoningTraceProps {
  messages: UIMessage[]
  isStreaming: boolean
  streamingText: string
}

function getToolIcon(toolName: string) {
  if (toolName.includes("land_use")) return Database
  if (toolName.includes("funding")) return Search
  if (toolName.includes("location") || toolName.includes("map")) return MapPin
  if (toolName.includes("document") || toolName.includes("file")) return FileSearch
  return Zap
}

function ToolCallCard({ part }: { part: { type: "tool-invocation"; toolInvocation: { toolName: string; toolCallId: string; state: string; args?: unknown; result?: unknown } } }) {
  const [expanded, setExpanded] = useState(false)
  const { toolName, state, args, result } = part.toolInvocation
  const Icon = getToolIcon(toolName)
  const isComplete = state === "result"

  const displayName = toolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())

  return (
    <motion.div
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      className="group border-l-2 border-cyan-400/30 bg-zinc-900/60 rounded-r-md overflow-hidden"
    >
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-zinc-800/40 transition-colors text-left"
      >
        <div
          className={`flex-shrink-0 w-5 h-5 rounded flex items-center justify-center ${
            isComplete ? "bg-cyan-400/15 text-cyan-400" : "bg-zinc-700/60 text-zinc-500"
          }`}
        >
          <Icon size={11} />
        </div>
        <span className="font-mono text-[11px] text-zinc-400 flex-1 truncate">
          {displayName}
        </span>
        <span
          className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${
            isComplete
              ? "text-cyan-400/80 bg-cyan-400/10"
              : "text-zinc-600 bg-zinc-800 animate-pulse"
          }`}
        >
          {isComplete ? "done" : "running"}
        </span>
        {isComplete && (
          <span className="text-zinc-600 ml-1">
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
              {args && (
                <div>
                  <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-1">
                    Input
                  </p>
                  <pre className="text-[10px] font-mono text-zinc-400 bg-zinc-950/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                    {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
                  </pre>
                </div>
              )}
              {result && (
                <div>
                  <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-1">
                    Result
                  </p>
                  <pre className="text-[10px] font-mono text-zinc-300 bg-zinc-950/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                    {typeof result === "string"
                      ? result
                      : (result as { summary?: string })?.summary ??
                        JSON.stringify(result, null, 2)}
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
      transition={{ duration: 0.7, repeat: Infinity, ease: "steps(1)" }}
      className="inline-block w-[2px] h-[14px] bg-cyan-400 ml-0.5 align-middle"
    />
  )
}

function TextBlock({ text, isLast, isStreaming }: { text: string; isLast: boolean; isStreaming: boolean }) {
  // Strip the JSON dossier block from visible text
  const visibleText = text.replace(/```json[\s\S]*?```/g, "")

  if (!visibleText.trim()) return null

  return (
    <div className="text-[12px] leading-relaxed text-zinc-300 font-sans whitespace-pre-wrap">
      {visibleText}
      {isLast && isStreaming && <StreamingCursor />}
    </div>
  )
}

export function ReasoningTrace({ messages, isStreaming, streamingText }: ReasoningTraceProps) {
  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-zinc-600 text-xs font-mono">Awaiting analysis trigger…</p>
      </div>
    )
  }

  // Render from messages array (AI SDK UIMessage format)
  const renderMessages = () => {
    const elements: React.ReactNode[] = []

    messages.forEach((msg, msgIdx) => {
      if (!msg.parts) return
      msg.parts.forEach((part, partIdx) => {
        const key = `${msgIdx}-${partIdx}`

        if (part.type === "text") {
          const isLastPart =
            msgIdx === messages.length - 1 &&
            partIdx === msg.parts.length - 1

          elements.push(
            <TextBlock
              key={key}
              text={part.text}
              isLast={isLastPart}
              isStreaming={isStreaming}
            />
          )
        } else if (part.type === "tool-invocation") {
          elements.push(
            <ToolCallCard
              key={key}
              part={part as { type: "tool-invocation"; toolInvocation: { toolName: string; toolCallId: string; state: string; args?: unknown; result?: unknown } }}
            />
          )
        }
      })
    })

    return elements
  }

  return (
    <div className="space-y-2.5 text-[12px]">
      {renderMessages()}
      {/* If we have raw streaming text but no messages yet */}
      {messages.length === 0 && streamingText && (
        <TextBlock text={streamingText} isLast isStreaming={isStreaming} />
      )}
    </div>
  )
}
