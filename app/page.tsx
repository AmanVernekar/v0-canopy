"use client"

import dynamic from "next/dynamic"
import { AgentPanel } from "@/components/agent-panel"

// MapLibre requires browser APIs — load client-only
const LsoaMap = dynamic(
  () => import("@/components/lsoa-map").then((m) => m.LsoaMap),
  { ssr: false }
)

export default function Page() {
  return (
    <main className="flex h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-200">
      {/* ── Left column: 60% ── */}
      <section className="relative flex flex-col" style={{ width: "60%" }}>
        {/* Header bar */}
        <header className="flex-shrink-0 flex items-center gap-3 px-5 h-12 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-sm z-20">
          <div className="flex items-baseline gap-2.5">
            <span
              className="text-lg font-semibold tracking-tight text-zinc-100"
              style={{ fontFamily: "var(--font-geist-sans)", letterSpacing: "-0.03em" }}
            >
              Shade
            </span>
            <span className="text-[11px] text-zinc-600 font-mono hidden sm:inline">
              Urban heat intervention planner
            </span>
          </div>
          <div className="flex-1" />
          <a
            href="#"
            className="text-[11px] font-mono text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            About
          </a>
        </header>

        {/* Map fills remaining height */}
        <div className="flex-1 relative">
          <LsoaMap />
        </div>
      </section>

      {/* ── Right column: 40% ── */}
      <section
        className="flex flex-col border-l border-zinc-800/60 overflow-y-auto shade-scroll"
        style={{ width: "40%", scrollbarWidth: "thin", scrollbarColor: "#27272a transparent" }}
      >
        <AgentPanel />
      </section>
    </main>
  )
}
