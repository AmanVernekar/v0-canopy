"use client"

import { useCallback } from "react"
import {
  Download,
  FileText,
  TriangleAlert,
  CheckCircle,
  ExternalLink,
  Sparkles,
  Globe,
  HardDrive,
} from "lucide-react"
import { motion } from "framer-motion"
import jsPDF from "jspdf"
import type { ParsedDossier, Fund, Intervention } from "@/lib/store"
import { useCanopyStore } from "@/lib/store"
import type { Map as MapLibreMap } from "maplibre-gl"

interface DossierViewProps {
  dossier: ParsedDossier
  rawMarkdown: string
  areaName: string | null
}

function priorityFromCoverage(
  coverage: number,
  topVuln: number
): { label: string; color: string; bg: string; Icon: typeof TriangleAlert } {
  if (topVuln >= 0.7)
    return {
      label: "Critical priority",
      color: "text-red-400",
      bg: "bg-red-400/10 border-red-400/30",
      Icon: TriangleAlert,
    }
  if (coverage >= 60)
    return {
      label: "Fundable now",
      color: "text-green-400",
      bg: "bg-green-400/10 border-green-400/30",
      Icon: CheckCircle,
    }
  return {
    label: "Partial fund cover",
    color: "text-amber-400",
    bg: "bg-amber-400/10 border-amber-400/30",
    Icon: TriangleAlert,
  }
}

function evidenceBadge(quality: Intervention["evidence_quality"]) {
  if (quality === "strong")
    return "bg-green-400/10 border-green-400/30 text-green-400"
  if (quality === "moderate")
    return "bg-amber-400/10 border-amber-400/30 text-amber-400"
  return "bg-zinc-700 border-zinc-600 text-zinc-400"
}

function fundStatusBadge(status: Fund["status"]) {
  if (status === "open") return "bg-green-400/10 text-green-400 border-green-400/30"
  if (status === "closing_soon")
    return "bg-amber-400/10 text-amber-400 border-amber-400/30"
  if (status === "scheduled")
    return "bg-cyan-400/10 text-cyan-400 border-cyan-400/30"
  return "bg-zinc-700 text-zinc-400 border-zinc-600"
}

function getInterventionColorForPdf(type: string): [number, number, number] {
  const t = type.toLowerCase()
  if (t.includes("tree")) return [74, 222, 128] // green
  if (t.includes("cool_roof") || t.includes("cool roof")) return [96, 165, 250] // blue
  if (t.includes("green_roof") || t.includes("green roof")) return [52, 211, 153]
  if (t.includes("pavement") || t.includes("paving")) return [167, 139, 250]
  if (t.includes("shade")) return [245, 158, 11]
  if (t.includes("park") || t.includes("garden")) return [16, 185, 129]
  return [34, 211, 238]
}

// Wait for the next idle render so getCanvas().toDataURL() returns pixels
// instead of a cleared buffer. WebGL contexts with preserveDrawingBuffer can
// still hand back blank pixels if read mid-frame. One rAF + the map's
// internal idle event is the safest combination.
async function waitForMapIdle(map: MapLibreMap, timeoutMs = 1500): Promise<void> {
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
  if (map.loaded() && !map.isMoving() && !map.isZooming()) {
    map.triggerRepaint()
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
    return
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs)
    map.once("idle", () => {
      clearTimeout(t)
      resolve()
    })
  })
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
}

async function captureMapForPdf(
  map: MapLibreMap,
  dossier: ParsedDossier
): Promise<{
  dataUrl: string
  cssWidth: number
  cssHeight: number
  markers: Array<{ x: number; y: number; color: [number, number, number] }>
  legend: Array<{ label: string; color: [number, number, number] }>
} | null> {
  try {
    await waitForMapIdle(map)
    const canvas = map.getCanvas()
    const dataUrl = canvas.toDataURL("image/png")
    if (!dataUrl || dataUrl === "data:," || dataUrl.length < 200) {
      console.warn("[pdf] map canvas returned empty data URL", { len: dataUrl.length })
      return null
    }
    const container = map.getContainer()
    const cssWidth = container.clientWidth
    const cssHeight = container.clientHeight
    const markers: Array<{ x: number; y: number; color: [number, number, number] }> = []
    const seenTypes = new Map<string, [number, number, number]>()
    for (const iv of dossier.interventions) {
      const color = getInterventionColorForPdf(iv.type)
      if (!seenTypes.has(iv.type)) seenTypes.set(iv.type, color)
      for (const loc of iv.target_locations) {
        if (typeof loc.lng !== "number" || typeof loc.lat !== "number") continue
        const p = map.project([loc.lng, loc.lat])
        if (p.x < 0 || p.y < 0 || p.x > cssWidth || p.y > cssHeight) continue
        markers.push({ x: p.x, y: p.y, color })
      }
    }
    const legend = Array.from(seenTypes.entries()).map(([label, color]) => ({
      label: label.replace(/_/g, " "),
      color,
    }))
    return { dataUrl, cssWidth, cssHeight, markers, legend }
  } catch (e) {
    console.error("[pdf] captureMapForPdf failed", e)
    return null
  }
}

async function generatePdf(
  dossier: ParsedDossier,
  rawMarkdown: string,
  areaName: string | null,
  mapInstance: MapLibreMap | null
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const margin = 48
  let y = margin

  const writeLine = (
    text: string,
    opts: { size?: number; bold?: boolean; color?: [number, number, number]; gap?: number } = {}
  ) => {
    const { size = 10, bold = false, color = [40, 40, 40], gap = 4 } = opts
    doc.setFont("helvetica", bold ? "bold" : "normal")
    doc.setFontSize(size)
    doc.setTextColor(...color)
    const lines = doc.splitTextToSize(text, W - margin * 2)
    for (const line of lines) {
      if (y > H - margin) {
        doc.addPage()
        y = margin
      }
      doc.text(line, margin, y)
      y += size + gap
    }
  }

  // ── Header ──
  doc.setFillColor(20, 20, 23)
  doc.rect(0, 0, W, 80, "F")
  doc.setFont("helvetica", "bold")
  doc.setFontSize(20)
  doc.setTextColor(255, 255, 255)
  doc.text("Canopy Dossier", margin, 40)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)
  doc.setTextColor(180, 180, 200)
  doc.text(
    `${areaName ?? "Selected area"} · LSOA ${dossier.lsoa_code}`,
    margin,
    60
  )
  y = 110

  // ── Headline ──
  writeLine(
    `Total indicative cost: £${dossier.total_cost_gbp.toLocaleString()}   ·   Fund coverage: ${Math.round(dossier.fund_coverage_pct)}%`,
    { size: 11, bold: true, gap: 6 }
  )
  y += 8

  // ── Map snapshot with intervention markers ──
  if (mapInstance) {
    const snapshot = await captureMapForPdf(mapInstance, dossier)
    if (snapshot) {
      writeLine("INTERVENTION MAP", {
        size: 9,
        bold: true,
        color: [120, 120, 120],
        gap: 6,
      })
      const imgW = W - margin * 2
      const imgH = (snapshot.cssHeight / snapshot.cssWidth) * imgW
      const cappedH = Math.min(imgH, 280)
      const cappedW = (cappedH / imgH) * imgW
      const offsetX = margin + (imgW - cappedW) / 2
      try {
        doc.addImage(snapshot.dataUrl, "PNG", offsetX, y, cappedW, cappedH)
      } catch (e) {
        console.error("[pdf] addImage failed", e)
      }
      // Overlay markers as filled circles. Positions are in CSS pixels of the
      // live map; scale by the same ratio used to fit the image.
      const sx = cappedW / snapshot.cssWidth
      const sy = cappedH / snapshot.cssHeight
      for (const m of snapshot.markers) {
        doc.setFillColor(m.color[0], m.color[1], m.color[2])
        doc.setDrawColor(255, 255, 255)
        doc.setLineWidth(0.8)
        const cx = offsetX + m.x * sx
        const cy = y + m.y * sy
        doc.circle(cx, cy, 3.5, "FD")
      }
      y += cappedH + 8
      // Legend — colored dot + label per unique intervention type. Wraps at
      // page edge.
      doc.setFont("helvetica", "normal")
      doc.setFontSize(9)
      doc.setTextColor(70, 70, 70)
      const dotR = 3
      const itemPadX = 12
      const lineH = 14
      let lx = margin
      let ly = y + 4
      for (const item of snapshot.legend) {
        const labelWidth = doc.getTextWidth(item.label)
        const itemWidth = dotR * 2 + 6 + labelWidth + itemPadX
        if (lx + itemWidth > W - margin) {
          lx = margin
          ly += lineH
        }
        doc.setFillColor(item.color[0], item.color[1], item.color[2])
        doc.setDrawColor(255, 255, 255)
        doc.setLineWidth(0.6)
        doc.circle(lx + dotR, ly - dotR, dotR, "FD")
        doc.text(item.label, lx + dotR * 2 + 4, ly)
        lx += itemWidth
      }
      y = ly + 8
    }
  }

  // ── Interventions table ──
  writeLine("INTERVENTIONS", { size: 9, bold: true, color: [120, 120, 120], gap: 6 })
  for (const iv of dossier.interventions) {
    writeLine(
      `${iv.type}  —  ${iv.quantity} ${iv.unit}  ·  £${iv.indicative_cost_gbp.toLocaleString()}`,
      { size: 11, bold: true, gap: 2 }
    )
    writeLine(iv.rationale_short, { size: 9, color: [80, 80, 80], gap: 2 })
    writeLine(
      `Evidence (${iv.evidence_quality}): ${iv.evidence_effect_size}`,
      { size: 9, color: [110, 110, 110], gap: 2 }
    )
    writeLine(
      `Locations: ${iv.target_locations
        .map((l) => `${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}`)
        .join("  ·  ")}`,
      { size: 8, color: [140, 140, 140], gap: 8 }
    )
  }

  // ── Funds ──
  y += 4
  writeLine("MATCHED FUNDS", { size: 9, bold: true, color: [120, 120, 120], gap: 6 })
  for (const f of dossier.funds) {
    writeLine(
      `${f.name}  [${f.status.toUpperCase()}]  ·  £${f.max_grant_gbp.toLocaleString()} max  ·  ${f.match_required_pct}% match`,
      { size: 11, bold: true, gap: 2 }
    )
    writeLine(
      `Verified via: ${f.verified_via}${f.deadline ? `  ·  Deadline: ${f.deadline}` : ""}`,
      { size: 9, color: [110, 110, 110], gap: 2 }
    )
    writeLine(f.eligibility_justification, { size: 9, color: [80, 80, 80], gap: 2 })
    if (f.repackaging_note) {
      writeLine(`Repackaging: ${f.repackaging_note}`, {
        size: 9,
        color: [180, 100, 0],
        gap: 2,
      })
    }
    writeLine(f.url, { size: 8, color: [60, 100, 180], gap: 8 })
  }

  // ── Trade-offs ──
  if (dossier.key_trade_offs?.length) {
    y += 4
    writeLine("KEY TRADE-OFFS", {
      size: 9,
      bold: true,
      color: [120, 120, 120],
      gap: 6,
    })
    for (const t of dossier.key_trade_offs) {
      writeLine(`• ${t}`, { size: 10, color: [60, 60, 60], gap: 4 })
    }
  }

  // ── Reasoning narrative (raw markdown, stripped) ──
  if (rawMarkdown.trim()) {
    if (y > H - margin - 80) {
      doc.addPage()
      y = margin
    } else {
      y += 12
    }
    writeLine("AGENT REASONING", {
      size: 9,
      bold: true,
      color: [120, 120, 120],
      gap: 6,
    })
    // Strip markdown adornments lightly
    const clean = rawMarkdown
      .replace(/```json[\s\S]*?```/g, "")
      .replace(/^#+\s*/gm, "")
      .replace(/\*\*/g, "")
      .replace(/^\s*[-*]\s+/gm, "• ")
      .trim()
    writeLine(clean, { size: 9, color: [70, 70, 70], gap: 3 })
  }

  doc.save(`canopy-dossier-${dossier.lsoa_code}.pdf`)
}

export function DossierView({ dossier, rawMarkdown, areaName }: DossierViewProps) {
  const handleDownloadMarkdown = useCallback(() => {
    const md = buildMarkdown(dossier, rawMarkdown, areaName)
    const blob = new Blob([md], { type: "text/markdown" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `canopy-dossier-${dossier.lsoa_code}.md`
    a.click()
    URL.revokeObjectURL(url)
  }, [dossier, rawMarkdown, areaName])

  const handleDownloadPdf = useCallback(() => {
    // Read the map ref non-reactively at click time so the dossier view
    // doesn't re-render on every map move.
    const mapInstance = useCanopyStore.getState().mapInstance
    void generatePdf(dossier, rawMarkdown, areaName, mapInstance).catch((e) => {
      console.error("[pdf] generation failed", e)
    })
  }, [dossier, rawMarkdown, areaName])

  // Headline card values
  const coverage = dossier.fund_coverage_pct ?? 0
  const topVuln = 0 // not part of dossier shape, only used for label nuance
  const priority = priorityFromCoverage(coverage, topVuln)
  const PriorityIcon = priority.Icon

  const scrapedFunds = dossier.funds.filter((f) => f.verified_via === "scraped")
  const fallbackFunds = dossier.funds.filter((f) => f.verified_via === "fallback")

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      {/* ── Headline strip ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div
          className={`flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded border ${priority.bg} ${priority.color}`}
        >
          <PriorityIcon size={11} />
          <span>{priority.label}</span>
        </div>
        <div className="flex gap-4 text-right">
          <div>
            <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">
              Total cost
            </p>
            <p className="text-sm font-mono text-amber-400">
              £{dossier.total_cost_gbp.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">
              Fund coverage
            </p>
            <p className="text-sm font-mono text-cyan-400">
              {Math.round(coverage)}%
            </p>
          </div>
        </div>
      </div>

      {/* ── Interventions ── */}
      <div>
        <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-2 flex items-center gap-1.5">
          <Sparkles size={9} /> Interventions ({dossier.interventions.length})
        </p>
        <div className="space-y-2">
          {dossier.interventions.map((iv, i) => (
            <div
              key={i}
              className="bg-zinc-900/60 border border-zinc-800/60 rounded-md p-2.5 space-y-1.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium text-zinc-100 leading-tight">
                    {iv.type.replace(/_/g, " ")}
                  </p>
                  <p className="text-[10px] font-mono text-zinc-500 mt-0.5">
                    {iv.quantity} {iv.unit} · {iv.target_locations.length} sites
                  </p>
                </div>
                <span className="text-[11px] font-mono text-amber-400 whitespace-nowrap">
                  £{iv.indicative_cost_gbp.toLocaleString()}
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                {iv.rationale_short}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${evidenceBadge(iv.evidence_quality)}`}
                >
                  {iv.evidence_quality} evidence
                </span>
                <span className="text-[10px] text-zinc-500 italic">
                  {iv.evidence_effect_size}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Funds ── */}
      {dossier.funds.length > 0 && (
        <div>
          <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-2 flex items-center gap-1.5">
            <Globe size={9} /> Matched funds ({dossier.funds.length})
            {scrapedFunds.length > 0 && (
              <span className="text-cyan-400 normal-case font-sans">
                · {scrapedFunds.length} live-verified
              </span>
            )}
            {fallbackFunds.length > 0 && (
              <span className="text-zinc-500 normal-case font-sans">
                · {fallbackFunds.length} fallback
              </span>
            )}
          </p>
          <div className="space-y-2">
            {dossier.funds.map((f, i) => (
              <a
                key={i}
                href={f.url}
                target="_blank"
                rel="noreferrer"
                className="block bg-zinc-900/60 hover:bg-zinc-900 border border-zinc-800/60 hover:border-cyan-400/40 rounded-md p-2.5 space-y-1.5 transition-colors group"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-zinc-100 leading-tight group-hover:text-cyan-400 transition-colors flex items-center gap-1">
                      {f.name}
                      <ExternalLink size={9} className="opacity-50" />
                    </p>
                    <p className="text-[10px] font-mono text-zinc-500 mt-0.5">
                      Up to £{f.max_grant_gbp.toLocaleString()}
                      {f.match_required_pct > 0 && ` · ${f.match_required_pct}% match`}
                      {f.deadline && ` · deadline ${f.deadline}`}
                    </p>
                  </div>
                  <span
                    className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${fundStatusBadge(f.status)}`}
                  >
                    {f.status.replace("_", " ")}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  {f.eligibility_justification}
                </p>
                {f.repackaging_note && (
                  <p className="text-[11px] text-amber-300 leading-relaxed bg-amber-400/5 border-l-2 border-amber-400/40 pl-2 py-1">
                    <span className="font-mono uppercase text-[8px] tracking-widest text-amber-400 mr-1.5">
                      Repackage
                    </span>
                    {f.repackaging_note}
                  </p>
                )}
                <div className="flex items-center gap-1 text-[9px] font-mono text-zinc-600">
                  {f.verified_via === "scraped" ? (
                    <>
                      <Globe size={9} className="text-cyan-400/60" />
                      <span>scraped via Bright Data</span>
                    </>
                  ) : (
                    <>
                      <HardDrive size={9} />
                      <span>fallback profile</span>
                    </>
                  )}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* ── Trade-offs ── */}
      {dossier.key_trade_offs?.length > 0 && (
        <div>
          <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-2">
            Key trade-offs
          </p>
          <ul className="space-y-1">
            {dossier.key_trade_offs.map((t, i) => (
              <li
                key={i}
                className="text-[11px] text-zinc-400 leading-relaxed pl-3 relative before:content-['—'] before:absolute before:left-0 before:text-zinc-600"
              >
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Downloads ── */}
      <div className="flex gap-2">
        <button
          onClick={handleDownloadPdf}
          className="flex-1 flex items-center gap-2 text-[11px] font-mono text-zinc-300 hover:text-cyan-400 bg-cyan-400/10 hover:bg-cyan-400/15 border border-cyan-400/40 hover:border-cyan-400/60 rounded-md px-3 py-2 transition-all justify-center group"
        >
          <FileText size={12} className="group-hover:translate-y-0.5 transition-transform" />
          Download PDF
        </button>
        <button
          onClick={handleDownloadMarkdown}
          className="flex items-center gap-2 text-[11px] font-mono text-zinc-400 hover:text-zinc-200 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/60 rounded-md px-3 py-2 transition-all justify-center"
        >
          <Download size={12} />
          .md
        </button>
      </div>
    </motion.div>
  )
}

function buildMarkdown(
  dossier: ParsedDossier,
  rawMarkdown: string,
  areaName: string | null
): string {
  const lines: string[] = []
  lines.push(`# Canopy Dossier`)
  lines.push(``)
  lines.push(`**Area:** ${areaName ?? "Selected area"}`)
  lines.push(`**LSOA:** ${dossier.lsoa_code}`)
  lines.push(`**Total cost:** £${dossier.total_cost_gbp.toLocaleString()}`)
  lines.push(`**Fund coverage:** ${Math.round(dossier.fund_coverage_pct)}%`)
  lines.push(``)
  lines.push(`## Interventions`)
  for (const iv of dossier.interventions) {
    lines.push(``)
    lines.push(`### ${iv.type.replace(/_/g, " ")}`)
    lines.push(
      `- Quantity: ${iv.quantity} ${iv.unit}`,
      `- Cost: £${iv.indicative_cost_gbp.toLocaleString()}`,
      `- Evidence (${iv.evidence_quality}): ${iv.evidence_effect_size}`,
      `- Rationale: ${iv.rationale_short}`,
      `- Locations: ${iv.target_locations
        .map((l) => `(${l.lat.toFixed(4)}, ${l.lng.toFixed(4)})`)
        .join(", ")}`
    )
  }
  lines.push(``)
  lines.push(`## Matched funds`)
  for (const f of dossier.funds) {
    lines.push(``)
    lines.push(`### [${f.name}](${f.url})`)
    lines.push(
      `- Status: ${f.status} (verified via ${f.verified_via})`,
      `- Max grant: £${f.max_grant_gbp.toLocaleString()}`,
      `- Match required: ${f.match_required_pct}%`,
      f.deadline ? `- Deadline: ${f.deadline}` : `- Deadline: not stated`,
      `- Eligibility: ${f.eligibility_justification}`,
      f.repackaging_note ? `- Repackaging note: ${f.repackaging_note}` : ""
    )
  }
  if (dossier.key_trade_offs?.length) {
    lines.push(``, `## Key trade-offs`)
    for (const t of dossier.key_trade_offs) lines.push(`- ${t}`)
  }
  if (rawMarkdown.trim()) {
    lines.push(``, `---`, ``, `## Agent reasoning`, ``, rawMarkdown)
  }
  return lines.join("\n")
}
