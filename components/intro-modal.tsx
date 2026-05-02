"use client"

import { useEffect, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Trees, Droplets, Search, FileText, X } from "lucide-react"

const STORAGE_KEY = "canopy:intro-seen-v1"

/**
 * First-load explainer. Sets expectations on what Canopy is, how the agent
 * runs, and roughly how long it takes — so users don't bail mid-analysis
 * thinking it's hung. Persists dismissal in localStorage; a small "?" trigger
 * in the header re-opens it.
 */
export function IntroModal({ openOverride, onClose }: { openOverride?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined") return
    if (openOverride !== undefined) {
      setOpen(openOverride)
      return
    }
    try {
      const seen = window.localStorage.getItem(STORAGE_KEY)
      if (!seen) setOpen(true)
    } catch {
      setOpen(true)
    }
  }, [openOverride])

  const close = () => {
    setOpen(false)
    try {
      window.localStorage.setItem(STORAGE_KEY, "1")
    } catch {}
    onClose?.()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="intro-bg"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={close}
        >
          <motion.div
            initial={{ y: 12, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
            className="bg-paper-elevated border border-line-strong rounded-lg shadow-2xl w-[560px] max-w-full max-h-[85vh] overflow-y-auto shade-scroll"
          >
            <div className="p-6 space-y-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[10px] font-mono text-ink-subtle uppercase tracking-widest mb-1">
                    Welcome to
                  </p>
                  <h1 className="text-2xl font-serif font-semibold text-ink leading-tight">
                    Canopy
                  </h1>
                  <p className="text-[12px] text-ink-muted mt-1">
                    A climate-adaptation planner for UK neighbourhoods — heat + flood, together.
                  </p>
                </div>
                <button
                  onClick={close}
                  aria-label="Close"
                  className="text-ink-subtle hover:text-ink p-1 rounded hover:bg-paper-deep"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="space-y-3 text-[13px] leading-relaxed text-ink">
                <p>
                  Click any neighbourhood (LSOA) on the map. An agent then reads
                  the place, forms hypotheses, browses an intervention catalogue,
                  pulls peer-reviewed evidence, scrapes live UK funding pages,
                  and produces a <strong>grant-ready dossier</strong> — costed,
                  evidence-cited, and mapped to specific streets.
                </p>
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <Card icon={Trees} colour="text-evidence-deep" bg="bg-evidence-soft" title="Heat + flood">
                    The agent considers both axes together — many UK interventions (trees, raingardens, depave) help with both.
                  </Card>
                  <Card icon={Droplets} colour="text-flood-deep" bg="bg-flood-soft" title="Real coordinates">
                    Markers are placed on actual streets inside the polygon — pulled from OSM data, not invented.
                  </Card>
                  <Card icon={Search} colour="text-fund-deep" bg="bg-fund-soft" title="Live funding scrape">
                    Bright Data Web Unlocker checks current UK funding pages — and the agent will tell you when a grant is unrealistic, not just whether you're "eligible".
                  </Card>
                  <Card icon={FileText} colour="text-heat-deep" bg="bg-heat-soft" title="Honest dossier">
                    You'll see a realistic coverage % alongside the optimistic one. Plus an equity audit. Plus dropped candidates with reasons.
                  </Card>
                </div>
              </div>

              <div className="bg-paper-deep border border-line rounded-md p-3 space-y-2">
                <p className="text-[10px] font-mono text-ink-subtle uppercase tracking-widest">
                  What to expect
                </p>
                <ul className="text-[12px] text-ink-muted leading-relaxed space-y-1">
                  <li>
                    <strong className="text-ink">~60–120 seconds.</strong> The
                    agent calls multiple tools — you'll see each step stream in
                    the right panel.
                  </li>
                  <li>
                    <strong className="text-ink">It thinks out loud.</strong>{" "}
                    "Considered and dropped" candidates are intentional — proof
                    of decision-making, not noise.
                  </li>
                  <li>
                    <strong className="text-ink">It hits real APIs.</strong>{" "}
                    OpenAlex (evidence), Bright Data (funding pages), the open
                    web. Sometimes scrapes fail — the agent disclosures fallback
                    use.
                  </li>
                  <li>
                    <strong className="text-ink">You can ask follow-ups.</strong>{" "}
                    Once the dossier is in, type a question — "halve the
                    budget", "swap shade for cool roofs" — and it revises.
                  </li>
                </ul>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={close}
                  className="text-[12px] font-mono text-evidence-deep bg-evidence-soft hover:bg-evidence-soft/80 border border-evidence/50 rounded-md px-4 py-2 transition-colors"
                >
                  Start exploring →
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Card({
  icon: Icon,
  colour,
  bg,
  title,
  children,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  colour: string
  bg: string
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-paper border border-line rounded-md p-2.5 space-y-1">
      <div className="flex items-center gap-1.5">
        <span className={`inline-flex items-center justify-center w-5 h-5 rounded ${bg} ${colour}`}>
          <Icon size={11} />
        </span>
        <span className={`text-[11px] font-medium ${colour}`}>{title}</span>
      </div>
      <p className="text-[11px] text-ink-muted leading-relaxed">{children}</p>
    </div>
  )
}
