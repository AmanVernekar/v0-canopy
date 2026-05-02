"use client"

import { motion, AnimatePresence } from "framer-motion"
import { CheckCircle2, CircleDashed, XCircle, Sparkles } from "lucide-react"
import type { UIMessage } from "ai"

/**
 * Live decision banner.
 *
 * Subscribes to the agent's `propose_intervention` tool calls in the message
 * stream. The agent calls this tool once per candidate (status: 'considering'
 * → 'accepted' | 'dropped') and the banner reflects state in real time —
 * including dropped candidates with reasons. Reads decision-making out loud,
 * which is the most agentic-feeling thing in the UI.
 */
type Status = "considering" | "accepted" | "dropped"
type Axis = "heat" | "flood"

interface ProposalArgs {
  id?: string
  name?: string
  status?: Status
  axes_addressed?: Axis[]
  rationale?: string
  target_streets?: string[]
  evidence_quality?: "strong" | "moderate" | "weak"
  catalogue_archetype?: string
}

interface ToolPart {
  type: string
  toolName?: string
  input?: ProposalArgs
  // AI SDK v5 input/output naming
  args?: ProposalArgs
}

function readPart(p: ToolPart): ProposalArgs | null {
  if (
    p.type !== "tool-propose_intervention" &&
    p.type !== "tool-invocation" // older shape
  ) {
    return null
  }
  // tool-* parts in v5 use `input`. Older shape used `args`.
  const a = p.input ?? p.args
  if (!a || typeof a !== "object") return null
  return a as ProposalArgs
}

function collectProposals(messages: UIMessage[]): Map<string, ProposalArgs> {
  // Walk all messages in order, collapse by id, last call wins. The agent is
  // expected to reuse the same id when transitioning a candidate from
  // 'considering' to 'accepted' / 'dropped'.
  const out = new Map<string, ProposalArgs>()
  for (const m of messages) {
    if (!m.parts) continue
    for (const p of m.parts as ToolPart[]) {
      if (p.type === "tool-propose_intervention" || p.toolName === "propose_intervention") {
        const a = readPart(p)
        if (a?.id) out.set(a.id, a)
      }
    }
  }
  return out
}

const statusMeta: Record<
  Status,
  {
    label: string
    Icon: typeof CheckCircle2
    badge: string
    card: string
    text: string
  }
> = {
  considering: {
    label: "Considering",
    Icon: CircleDashed,
    badge: "bg-paper-deep border-line-strong text-ink-muted",
    card: "bg-paper-elevated border-line",
    text: "text-ink",
  },
  accepted: {
    label: "Accepted",
    Icon: CheckCircle2,
    badge: "bg-evidence-soft border-evidence/50 text-evidence-deep",
    card: "bg-evidence-soft/40 border-evidence/40",
    text: "text-ink",
  },
  dropped: {
    label: "Dropped",
    Icon: XCircle,
    badge: "bg-heat-soft border-heat/40 text-heat-deep",
    card: "bg-heat-soft/40 border-heat/30 opacity-80",
    text: "text-ink-muted line-through-on-name",
  },
}

export function InterventionsBanner({ messages }: { messages: UIMessage[] }) {
  const proposals = collectProposals(messages)
  if (proposals.size === 0) return null

  const items = Array.from(proposals.values())
  const counts = items.reduce(
    (acc, p) => {
      const s = (p.status ?? "considering") as Status
      acc[s] = (acc[s] ?? 0) + 1
      return acc
    },
    {} as Record<Status, number>
  )

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-2"
    >
      <div className="flex items-center gap-2">
        <p className="text-[9px] font-mono text-ink-subtle uppercase tracking-widest flex-1 flex items-center gap-1.5">
          <Sparkles size={9} /> Interventions on the table
        </p>
        <div className="flex items-center gap-1 text-[9px] font-mono">
          {counts.considering ? (
            <span className="text-ink-subtle">{counts.considering} pending</span>
          ) : null}
          {counts.accepted ? (
            <span className="text-evidence-deep">· {counts.accepted} accepted</span>
          ) : null}
          {counts.dropped ? (
            <span className="text-heat-deep">· {counts.dropped} dropped</span>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-1.5">
        <AnimatePresence initial={false}>
          {items.map((p) => {
            const status = (p.status ?? "considering") as Status
            const meta = statusMeta[status]
            const Icon = meta.Icon
            return (
              <motion.div
                key={p.id ?? p.name ?? Math.random().toString(36)}
                layout
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -4 }}
                className={`border rounded-md p-2 ${meta.card}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Icon
                      size={12}
                      className={
                        status === "accepted"
                          ? "text-evidence-deep flex-shrink-0"
                          : status === "dropped"
                          ? "text-heat-deep flex-shrink-0"
                          : "text-ink-subtle flex-shrink-0"
                      }
                    />
                    <span
                      className={`text-[12px] font-medium leading-tight ${meta.text} ${
                        status === "dropped" ? "line-through decoration-ink-subtle/50" : ""
                      }`}
                    >
                      {p.name ?? p.id}
                    </span>
                  </div>
                  <span
                    className={`text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border whitespace-nowrap ${meta.badge}`}
                  >
                    {meta.label}
                  </span>
                </div>
                {p.rationale && (
                  <p className="text-[11px] text-ink-muted leading-relaxed mt-1">
                    {p.rationale}
                  </p>
                )}
                <div className="flex items-center flex-wrap gap-1 mt-1.5">
                  {p.axes_addressed?.map((axis) => (
                    <span
                      key={axis}
                      className={`text-[8px] font-mono uppercase tracking-widest px-1 py-0.5 rounded border ${
                        axis === "heat"
                          ? "bg-heat-soft border-heat/30 text-heat-deep"
                          : "bg-flood-soft border-flood/30 text-flood-deep"
                      }`}
                    >
                      {axis}
                    </span>
                  ))}
                  {p.evidence_quality && (
                    <span className="text-[8px] font-mono uppercase tracking-widest px-1 py-0.5 rounded border border-line-strong text-ink-muted">
                      {p.evidence_quality} evidence
                    </span>
                  )}
                  {p.target_streets && p.target_streets.length > 0 && (
                    <span className="text-[10px] text-ink-subtle italic ml-1">
                      → {p.target_streets.slice(0, 2).join(", ")}
                      {p.target_streets.length > 2 && "…"}
                    </span>
                  )}
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
