"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { HelpCircle, MapPin } from "lucide-react"
import { AgentPanel } from "@/components/agent-panel"
// Static import keeps lib/store in a single bundle, so AgentPanel and LsoaMap
// share the same Zustand instance. We delay actually rendering LsoaMap until
// client-side mount because maplibre touches window.
import { LsoaMap } from "@/components/lsoa-map"
import { IntroModal } from "@/components/intro-modal"
import { LeftSidebar } from "@/components/left-sidebar"
import { useCanopyStore, CITIES, type CitySlug } from "@/lib/store"

// Minimum widths in percent so a column can't be dragged into invisibility.
const MIN_LEFT_PCT = 12
const MIN_RIGHT_PCT = 18
const MIN_CENTRE_PCT = 28
const STORAGE_KEY = "canopy:column-widths-v1"

export default function Page() {
  const [mounted, setMounted] = useState(false)
  const [introOpen, setIntroOpen] = useState<boolean | undefined>(undefined)
  const selectedCity = useCanopyStore((s) => s.selectedCity)
  const setSelectedCity = useCanopyStore((s) => s.setSelectedCity)

  // Column widths in percent. Centre column is computed (100 - left - right)
  // so the layout always fills the viewport regardless of drag direction.
  const [leftPct, setLeftPct] = useState(22)
  const [rightPct, setRightPct] = useState(30)
  const draggingRef = useRef<"left" | "right" | null>(null)

  useEffect(() => {
    setMounted(true)
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (typeof parsed?.left === "number" && typeof parsed?.right === "number") {
          setLeftPct(parsed.left)
          setRightPct(parsed.right)
        }
      }
    } catch {
      /* ignore */
    }
  }, [])

  // Persist widths after each drag ends — debounced via the dragend handler.
  const persist = useCallback((l: number, r: number) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: l, right: r }))
    } catch {
      /* ignore */
    }
  }, [])

  // Live drag — bind document-level listeners so the user can drag past the
  // handle without losing capture. Compute new widths as percent of viewport.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return
      const vw = window.innerWidth || 1
      const xPct = (e.clientX / vw) * 100

      if (draggingRef.current === "left") {
        // Drag handle is between left and centre. The new leftPct is xPct.
        const newLeft = Math.max(MIN_LEFT_PCT, Math.min(xPct, 100 - rightPct - MIN_CENTRE_PCT))
        setLeftPct(newLeft)
      } else {
        // Drag handle is between centre and right. The new rightPct is
        // (100 - xPct), since x is measured from the LEFT viewport edge.
        const newRight = Math.max(MIN_RIGHT_PCT, Math.min(100 - xPct, 100 - leftPct - MIN_CENTRE_PCT))
        setRightPct(newRight)
      }
    }
    const onUp = () => {
      if (draggingRef.current) {
        draggingRef.current = null
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
        persist(leftPct, rightPct)
      }
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    return () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
  }, [leftPct, rightPct, persist])

  const startDrag = (which: "left" | "right") => (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = which
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }

  const centrePct = Math.max(MIN_CENTRE_PCT, 100 - leftPct - rightPct)

  return (
    <main className="flex h-screen w-screen overflow-hidden bg-paper text-ink">
      {/* ── Left strip — saved analyses + live interventions banner ── */}
      <aside style={{ width: `${leftPct}%` }} className="flex flex-col h-full">
        {/* Spacer to align with map header */}
        <div className="flex-shrink-0 h-12 border-b border-line bg-paper-elevated/95 flex items-center px-4">
          <span className="text-[10px] font-mono text-ink-subtle uppercase tracking-widest">
            Context
          </span>
        </div>
        <div className="flex-1 min-h-0">
          <LeftSidebar />
        </div>
      </aside>

      {/* Resize handle — left/centre */}
      <ResizeHandle onMouseDown={startDrag("left")} />

      {/* ── Centre column — map ── */}
      <section
        className="relative flex flex-col"
        style={{ width: `${centrePct}%` }}
      >
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
          {/* City selector */}
          <div className="flex items-center gap-1.5 mr-2">
            <MapPin size={11} className="text-ink-subtle" />
            <select
              value={selectedCity}
              onChange={(e) => setSelectedCity(e.target.value as CitySlug)}
              aria-label="Select city"
              className="bg-paper border border-line rounded px-2 py-1 text-[11px] font-mono text-ink hover:border-line-strong focus:outline-none focus:border-evidence/60 transition-colors"
            >
              {CITIES.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
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

      {/* Resize handle — centre/right */}
      <ResizeHandle onMouseDown={startDrag("right")} />

      {/* ── Right column — agent / dossier ── */}
      <section
        className="flex flex-col overflow-y-auto shade-scroll bg-paper"
        style={{ width: `${rightPct}%` }}
      >
        <AgentPanel />
      </section>

      {/* First-load intro + reopen-via-help-button. */}
      <IntroModal openOverride={introOpen} onClose={() => setIntroOpen(undefined)} />
    </main>
  )
}

/**
 * Vertical drag-to-resize splitter. 4px wide visible band; widens on hover.
 * Cursor changes to col-resize on the whole document during drag (set by the
 * parent's startDrag) so the user can drag freely without losing capture.
 */
function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onMouseDown}
      className="group relative flex-shrink-0 w-1 cursor-col-resize bg-line hover:bg-line-strong transition-colors"
    >
      {/* Wider invisible hit area for easier grabbing without making the
          visible band thicker. */}
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
      {/* Subtle handle indicator on hover */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 bg-ink-faint opacity-0 group-hover:opacity-60 rounded transition-opacity" />
    </div>
  )
}
