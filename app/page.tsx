"use client"

import { useEffect, useState } from "react"
import { HelpCircle } from "lucide-react"
import { AgentPanel } from "@/components/agent-panel"
// Static import keeps lib/store in a single bundle, so AgentPanel and LsoaMap
// share the same Zustand instance. We delay actually rendering LsoaMap until
// client-side mount because maplibre touches window.
import { LsoaMap } from "@/components/lsoa-map"
import { IntroModal } from "@/components/intro-modal"

export default function Page() {
  const [mounted, setMounted] = useState(false)
  const [introOpen, setIntroOpen] = useState<boolean | undefined>(undefined)
  useEffect(() => setMounted(true), [])

  return (
    <main className="flex h-screen w-screen overflow-hidden bg-paper text-ink">
      {/* ── Left column: 60% — map (intentionally dark, sits like an
          ink illustration on cream paper) ── */}
      <section className="relative flex flex-col" style={{ width: "60%" }}>
        {/* Header bar — paper-toned, document-like */}
        <header className="flex-shrink-0 flex items-center gap-3 px-5 h-12 border-b border-line bg-paper-elevated/95 backdrop-blur-sm z-20">
          <div className="flex items-baseline gap-2.5">
            <span
              className="text-lg font-semibold tracking-tight text-ink font-serif"
              style={{ letterSpacing: "-0.01em" }}
            >
              Canopy
            </span>
            <span className="text-[11px] text-ink-subtle font-mono hidden sm:inline">
              Climate adaptation planner · heat + flood
            </span>
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setIntroOpen(true)}
            aria-label="Show intro"
            className="flex items-center gap-1 text-[11px] font-mono text-ink-subtle hover:text-ink transition-colors"
          >
            <HelpCircle size={12} />
            How this works
          </button>
        </header>

        {/* Map fills remaining height */}
        <div className="flex-1 relative">
          {mounted && <LsoaMap />}
        </div>
      </section>

      {/* ── Right column: 40% — agent / dossier ── */}
      <section
        className="flex flex-col border-l border-line overflow-y-auto shade-scroll bg-paper"
        style={{ width: "40%" }}
      >
        <AgentPanel />
      </section>

      {/* First-load intro + reopen-via-help-button. */}
      <IntroModal openOverride={introOpen} onClose={() => setIntroOpen(undefined)} />
    </main>
  )
}
