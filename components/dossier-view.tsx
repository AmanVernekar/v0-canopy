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
      color: "text-heat-deep",
      bg: "bg-heat-soft border-heat/40",
      Icon: TriangleAlert,
    }
  if (coverage >= 60)
    return {
      label: "Fundable now",
      color: "text-evidence-deep",
      bg: "bg-evidence-soft border-evidence/40",
      Icon: CheckCircle,
    }
  return {
    label: "Partial fund cover",
    color: "text-fund-deep",
    bg: "bg-fund-soft border-fund/40",
    Icon: TriangleAlert,
  }
}

function evidenceBadge(quality: Intervention["evidence_quality"]) {
  if (quality === "strong")
    return "bg-evidence-soft border-evidence/40 text-evidence-deep"
  if (quality === "moderate")
    return "bg-fund-soft border-fund/40 text-fund-deep"
  return "bg-paper-deep border-line-strong text-ink-muted"
}

function fundStatusBadge(status: Fund["status"]) {
  if (status === "open") return "bg-evidence-soft text-evidence-deep border-evidence/40"
  if (status === "closing_soon")
    return "bg-fund-soft text-fund-deep border-fund/40"
  if (status === "scheduled")
    return "bg-flood-soft text-flood-deep border-flood/40"
  return "bg-paper-deep text-ink-muted border-line-strong"
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

// ─── Bid-pack export ─────────────────────────────────────────────────────
// Single-page executive summary + pre-filled answers to the standard UK
// environment-grant question stems. The "save real work" view: planners
// rarely send the full dossier to a fund body; they paraphrase from it. The
// bid pack does the paraphrasing.
async function generateBidPack(
  dossier: ParsedDossier,
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
  doc.setFillColor(247, 244, 238)
  doc.rect(0, 0, W, 90, "F")
  doc.setDrawColor(74, 103, 65)
  doc.setLineWidth(2)
  doc.line(0, 90, W, 90)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(22)
  doc.setTextColor(31, 29, 24)
  doc.text("Climate Adaptation Bid Pack", margin, 42)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)
  doc.setTextColor(74, 103, 65)
  doc.text(
    `${areaName ?? "Selected area"} · LSOA ${dossier.lsoa_code}` +
      (dossier.place_archetype ? ` · ${dossier.place_archetype}` : ""),
    margin,
    62
  )
  doc.setFontSize(8)
  doc.setTextColor(140, 133, 118)
  doc.text(
    `Prepared by Canopy · ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`,
    margin,
    78
  )
  y = 110

  // ── Executive summary panel ──
  writeLine("EXECUTIVE SUMMARY", {
    size: 9,
    bold: true,
    color: [120, 120, 120],
    gap: 6,
  })
  if (dossier.counterfactual_2050) {
    writeLine(`Without action: ${dossier.counterfactual_2050}`, {
      size: 11,
      bold: true,
      color: [125, 38, 21],
      gap: 6,
    })
  }
  const optimistic = dossier.optimistic_coverage_pct ?? dossier.fund_coverage_pct ?? 0
  const realistic = dossier.realistic_coverage_pct ?? optimistic
  writeLine(
    `Total programme cost: £${dossier.total_cost_gbp.toLocaleString()}` +
      (dossier.total_annual_maintenance_gbp != null
        ? ` capital · £${dossier.total_annual_maintenance_gbp.toLocaleString()}/year ongoing`
        : ""),
    { size: 11, bold: true, gap: 4 }
  )
  writeLine(
    `Realistic fund coverage (risk-adjusted): ${Math.round(realistic)}%   ·   Optimistic: ${Math.round(optimistic)}%`,
    { size: 10, color: [80, 80, 80], gap: 6 }
  )
  if (dossier.vulnerability_summary?.headline) {
    writeLine(dossier.vulnerability_summary.headline, {
      size: 10,
      color: [80, 80, 80],
      gap: 8,
    })
  }

  // ── Map snapshot (compact) ──
  if (mapInstance) {
    const snapshot = await captureMapForPdf(mapInstance, dossier)
    if (snapshot) {
      const imgW = (W - margin * 2) * 0.75
      const imgH = (snapshot.cssHeight / snapshot.cssWidth) * imgW
      const cappedH = Math.min(imgH, 180)
      const cappedW = (cappedH / imgH) * imgW
      const offsetX = margin + ((W - margin * 2) - cappedW) / 2
      try {
        doc.addImage(snapshot.dataUrl, "PNG", offsetX, y, cappedW, cappedH)
      } catch {}
      const sx = cappedW / snapshot.cssWidth
      const sy = cappedH / snapshot.cssHeight
      for (const m of snapshot.markers) {
        doc.setFillColor(m.color[0], m.color[1], m.color[2])
        doc.setDrawColor(255, 255, 255)
        doc.setLineWidth(0.7)
        doc.circle(offsetX + m.x * sx, y + m.y * sy, 3, "FD")
      }
      y += cappedH + 12
    }
  }

  // ── Pre-filled grant questions ──
  writeLine("STANDARD GRANT QUESTIONS — DRAFT ANSWERS", {
    size: 9,
    bold: true,
    color: [120, 120, 120],
    gap: 6,
  })

  const acceptedInterventions = dossier.interventions
  const liveFunds = dossier.funds.filter((f) => f.status === "open" || f.status === "closing_soon")
  const topFund = liveFunds.sort(
    (a, b) => (b.award_probability ?? 0.3) - (a.award_probability ?? 0.3)
  )[0]

  const qa: { q: string; a: string }[] = [
    {
      q: "What is the proposed project and where will it be delivered?",
      a:
        `${acceptedInterventions.length} interventions across ${areaName ?? dossier.lsoa_code} (LSOA ${dossier.lsoa_code}` +
        (dossier.place_archetype ? `, ${dossier.place_archetype}` : "") +
        `): ${acceptedInterventions
          .slice(0, 4)
          .map((iv) => iv.type.replace(/_/g, " "))
          .join("; ")}${acceptedInterventions.length > 4 ? "; and more" : ""}.`,
    },
    {
      q: "What is the project's value-for-money case?",
      a:
        `Total capital cost £${dossier.total_cost_gbp.toLocaleString()}` +
        (dossier.total_annual_maintenance_gbp != null
          ? `, with ~£${dossier.total_annual_maintenance_gbp.toLocaleString()}/year maintenance`
          : "") +
        `. ` +
        (acceptedInterventions
          .filter((iv) => iv.evidence_quality === "strong")
          .map((iv) => `${iv.type}: ${iv.evidence_effect_size}`)
          .slice(0, 2)
          .join(" ") || "Evidence-cited per intervention; see appendix.") +
        " Risk-adjusted fund coverage estimated at " +
        Math.round(realistic) +
        "%.",
    },
    {
      q: "How does this contribute to climate adaptation?",
      a: dossier.counterfactual_2050
        ? `Counterfactual: ${dossier.counterfactual_2050} The proposal directly reduces these risks via ${[
            ...new Set(acceptedInterventions.flatMap((iv) => iv.axes_addressed ?? [])),
          ].join(" and ")} interventions across the LSOA.`
        : `Reduces both heat and surface-water flood risk across the LSOA via ${[
            ...new Set(acceptedInterventions.flatMap((iv) => iv.axes_addressed ?? [])),
          ].join(" and ")} interventions.`,
    },
    {
      q: "What are the biodiversity / co-benefits?",
      a:
        [...new Set(acceptedInterventions.flatMap((iv) => iv.co_benefits ?? []))]
          .slice(0, 6)
          .join("; ") || "See per-intervention rationale in appendix.",
    },
    {
      q: "What is the equity case?",
      a:
        dossier.equity_audit ??
        "Targets a high-vulnerability LSOA — see vulnerability composite (heat + flood) and demographic profile in appendix.",
    },
    {
      q: "What is the proposed match funding?",
      a: liveFunds.length
        ? liveFunds
            .map(
              (f) =>
                `${f.name}: up to £${f.max_grant_gbp.toLocaleString()}, ${f.match_required_pct}% match required` +
                (f.match_secured_pct ? ` (${f.match_secured_pct}% secured)` : " — match-source TBC")
            )
            .join(". ")
        : "To be sourced via council capital programme; specific scheme to be selected on this dossier.",
    },
    {
      q: "What community engagement is planned?",
      a:
        "Standard borough consultation: ward-councillor briefing, residents' association engagement, school engagement where school sites are involved, statutory pre-app where Highways changes are proposed. Engagement plan tracked alongside design milestones.",
    },
    {
      q: "What are the key delivery risks?",
      a: dossier.key_trade_offs?.length
        ? dossier.key_trade_offs.join("; ")
        : "Programme phasing risk and statutory approvals — managed through standard delivery governance.",
    },
  ]

  for (const { q, a } of qa) {
    writeLine(q, { size: 10, bold: true, gap: 3 })
    writeLine(a, { size: 9, color: [60, 60, 60], gap: 8 })
  }

  // ── Top recommended fund ──
  if (topFund) {
    if (y > H - margin - 100) {
      doc.addPage()
      y = margin
    }
    writeLine("RECOMMENDED FIRST APPLICATION", {
      size: 9,
      bold: true,
      color: [120, 120, 120],
      gap: 6,
    })
    writeLine(topFund.name, { size: 12, bold: true, gap: 3 })
    writeLine(
      `Up to £${topFund.max_grant_gbp.toLocaleString()}` +
        (topFund.deadline ? `  ·  Deadline ${topFund.deadline}` : "") +
        (topFund.award_probability != null
          ? `  ·  Estimated award probability ${Math.round(topFund.award_probability * 100)}%`
          : ""),
      { size: 10, color: [80, 80, 80], gap: 4 }
    )
    writeLine(topFund.eligibility_justification, { size: 9, color: [80, 80, 80], gap: 4 })
    if (topFund.weaknesses && topFund.weaknesses.length) {
      writeLine(`Risks to address: ${topFund.weaknesses.join("; ")}`, {
        size: 9,
        color: [125, 38, 21],
        gap: 4,
      })
    }
    writeLine(topFund.url, { size: 8, color: [60, 100, 180], gap: 6 })
  }

  doc.save(`canopy-bidpack-${dossier.lsoa_code}.pdf`)
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

  const handleDownloadBidPack = useCallback(() => {
    const mapInstance = useCanopyStore.getState().mapInstance
    void generateBidPack(dossier, areaName, mapInstance).catch((e) => {
      console.error("[bid-pack] generation failed", e)
    })
  }, [dossier, areaName])

  // Headline numbers — prefer the realistic (risk-adjusted) coverage when the
  // agent supplied it. Older dossiers only have fund_coverage_pct.
  const optimistic =
    dossier.optimistic_coverage_pct ?? dossier.fund_coverage_pct ?? 0
  const realistic = dossier.realistic_coverage_pct
  const coverageForPriority = realistic ?? optimistic
  const topVuln = dossier.vulnerability_summary?.heat_score ?? 0
  const priority = priorityFromCoverage(coverageForPriority, topVuln)
  const PriorityIcon = priority.Icon

  const scrapedFunds = dossier.funds.filter((f) => f.verified_via === "scraped")
  const fallbackFunds = dossier.funds.filter((f) => f.verified_via === "fallback")
  const heatScore = dossier.vulnerability_summary?.heat_score
  const floodScore = dossier.vulnerability_summary?.flood_score

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
            <p className="text-[9px] font-mono text-ink-subtle uppercase tracking-widest">
              Total cost
            </p>
            <p className="text-sm font-mono text-fund-deep">
              £{dossier.total_cost_gbp.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-[9px] font-mono text-ink-subtle uppercase tracking-widest">
              Realistic coverage
            </p>
            <p className="text-sm font-mono text-evidence-deep">
              {Math.round(realistic ?? optimistic)}%
            </p>
            {realistic != null && realistic !== optimistic && (
              <p className="text-[9px] font-mono text-ink-subtle">
                optimistic {Math.round(optimistic)}%
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Counterfactual urgency line ── */}
      {dossier.counterfactual_2050 && (
        <div className="bg-heat-soft/60 border-l-2 border-heat rounded-r-md p-2.5">
          <p className="text-[9px] font-mono text-heat-deep uppercase tracking-widest mb-0.5">
            If nothing changes
          </p>
          <p className="text-[12px] font-medium text-heat-deep leading-relaxed">
            {dossier.counterfactual_2050}
          </p>
        </div>
      )}

      {/* ── Place + vulnerability strip ── */}
      {(dossier.place_archetype || heatScore != null || floodScore != null) && (
        <div className="bg-paper-deep border border-line rounded-md p-2.5 flex flex-wrap items-center gap-3">
          {dossier.place_archetype && (
            <span className="text-[11px] font-serif italic text-ink">
              {dossier.place_archetype}
            </span>
          )}
          {heatScore != null && (
            <span className="text-[10px] font-mono inline-flex items-center gap-1">
              <span className="text-ink-subtle uppercase tracking-widest">Heat</span>
              <span className="text-heat-deep">{heatScore.toFixed(2)}</span>
            </span>
          )}
          {floodScore != null && floodScore > 0 && (
            <span className="text-[10px] font-mono inline-flex items-center gap-1">
              <span className="text-ink-subtle uppercase tracking-widest">Flood</span>
              <span className="text-flood-deep">{floodScore.toFixed(2)}</span>
            </span>
          )}
          {dossier.vulnerability_summary?.headline && (
            <span className="text-[11px] text-ink-muted italic flex-1 min-w-[200px]">
              {dossier.vulnerability_summary.headline}
            </span>
          )}
        </div>
      )}

      {/* ── Interventions ── */}
      <div>
        <p className="text-[9px] font-mono text-ink-subtle uppercase tracking-widest mb-2 flex items-center gap-1.5">
          <Sparkles size={9} /> Interventions ({dossier.interventions.length})
        </p>
        <div className="space-y-2">
          {dossier.interventions.map((iv, i) => (
            <div
              key={i}
              className="bg-paper-elevated border border-line rounded-md p-2.5 space-y-1.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium text-ink leading-tight">
                    {iv.type.replace(/_/g, " ")}
                  </p>
                  <p className="text-[10px] font-mono text-ink-muted mt-0.5">
                    {iv.quantity} {iv.unit} · {iv.target_locations.length} sites
                    {iv.annual_maintenance_gbp != null && (
                      <> · £{iv.annual_maintenance_gbp.toLocaleString()}/yr maint.</>
                    )}
                  </p>
                </div>
                <span className="text-[11px] font-mono text-fund-deep whitespace-nowrap">
                  £{iv.indicative_cost_gbp.toLocaleString()}
                </span>
              </div>
              <p className="text-[11px] text-ink-muted leading-relaxed">
                {iv.rationale_short}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                {iv.axes_addressed?.map((axis) => (
                  <span
                    key={axis}
                    className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                      axis === "heat"
                        ? "bg-heat-soft border-heat/40 text-heat-deep"
                        : "bg-flood-soft border-flood/40 text-flood-deep"
                    }`}
                  >
                    {axis}
                  </span>
                ))}
                <span
                  className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${evidenceBadge(iv.evidence_quality)}`}
                >
                  {iv.evidence_quality} evidence
                </span>
                <span className="text-[10px] text-ink-muted italic flex-1 min-w-[120px]">
                  {iv.evidence_effect_size}
                </span>
              </div>
              {iv.co_benefits && iv.co_benefits.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {iv.co_benefits.map((cb, ci) => (
                    <span
                      key={ci}
                      className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-paper-deep text-ink-muted border border-line"
                    >
                      + {cb}
                    </span>
                  ))}
                </div>
              )}
              {iv.equity_note && (
                <p className="text-[10px] text-ink-muted italic leading-relaxed pl-2 border-l-2 border-line-strong">
                  {iv.equity_note}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Funds ── */}
      {dossier.funds.length > 0 && (
        <div>
          <p className="text-[9px] font-mono text-ink-subtle uppercase tracking-widest mb-2 flex items-center gap-1.5">
            <Globe size={9} /> Matched funds ({dossier.funds.length})
            {scrapedFunds.length > 0 && (
              <span className="text-evidence-deep normal-case font-sans">
                · {scrapedFunds.length} live-verified
              </span>
            )}
            {fallbackFunds.length > 0 && (
              <span className="text-ink-muted normal-case font-sans">
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
                className="block bg-paper-elevated hover:bg-paper-elevated border border-line hover:border-evidence/40 rounded-md p-2.5 space-y-1.5 transition-colors group"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-ink leading-tight group-hover:text-evidence-deep transition-colors flex items-center gap-1">
                      {f.name}
                      <ExternalLink size={9} className="opacity-50" />
                    </p>
                    <p className="text-[10px] font-mono text-ink-muted mt-0.5">
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
                <p className="text-[11px] text-ink-muted leading-relaxed">
                  {f.eligibility_justification}
                </p>
                {/* Risk-adjusted probability + match gap */}
                {(f.award_probability != null || f.match_secured_pct != null) && (
                  <div className="flex flex-wrap gap-2 text-[10px] font-mono">
                    {f.award_probability != null && (
                      <span className="inline-flex items-center gap-1">
                        <span className="text-ink-subtle uppercase tracking-widest text-[8px]">
                          award prob
                        </span>
                        <span
                          className={
                            f.award_probability >= 0.5
                              ? "text-evidence-deep"
                              : f.award_probability >= 0.25
                              ? "text-fund-deep"
                              : "text-heat-deep"
                          }
                        >
                          {Math.round(f.award_probability * 100)}%
                        </span>
                      </span>
                    )}
                    {f.match_required_pct > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <span className="text-ink-subtle uppercase tracking-widest text-[8px]">
                          match
                        </span>
                        <span
                          className={
                            (f.match_secured_pct ?? 0) >= f.match_required_pct
                              ? "text-evidence-deep"
                              : "text-heat-deep"
                          }
                        >
                          {f.match_secured_pct ?? 0}/{f.match_required_pct}%
                        </span>
                      </span>
                    )}
                  </div>
                )}
                {f.weaknesses && f.weaknesses.length > 0 && (
                  <div className="bg-heat-soft/40 border-l-2 border-heat/40 pl-2 py-1 space-y-0.5">
                    <p className="font-mono uppercase text-[8px] tracking-widest text-heat-deep">
                      Risks
                    </p>
                    {f.weaknesses.map((w, wi) => (
                      <p key={wi} className="text-[10px] text-heat-deep leading-relaxed">
                        — {w}
                      </p>
                    ))}
                  </div>
                )}
                {f.repackaging_note && (
                  <p className="text-[11px] text-fund-deep leading-relaxed bg-fund-soft/40 border-l-2 border-fund/50 pl-2 py-1">
                    <span className="font-mono uppercase text-[8px] tracking-widest text-fund-deep mr-1.5">
                      Repackage
                    </span>
                    {f.repackaging_note}
                  </p>
                )}
                <div className="flex items-center gap-1 text-[9px] font-mono text-ink-subtle">
                  {f.verified_via === "scraped" ? (
                    <>
                      <Globe size={9} className="text-evidence-deep/60" />
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

      {/* ── Comparable LSOAs ── */}
      {dossier.comparable_lsoas && dossier.comparable_lsoas.length > 0 && (
        <div className="bg-flood-soft/40 border-l-2 border-flood/50 rounded-r-md p-2.5 space-y-1.5">
          <p className="text-[9px] font-mono text-flood-deep uppercase tracking-widest">
            Compared to similar neighbourhoods
          </p>
          <div className="space-y-1.5">
            {dossier.comparable_lsoas.map((c, i) => (
              <div key={i} className="text-[11px] text-ink leading-relaxed">
                <span className="font-mono text-flood-deep">
                  {c.name} ({c.lsoa_code})
                </span>
                <span className="text-ink-muted"> — {c.note}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Equity audit ── */}
      {dossier.equity_audit && (
        <div className="bg-evidence-soft/50 border-l-2 border-evidence/50 rounded-r-md p-2.5 space-y-1">
          <p className="text-[9px] font-mono text-evidence-deep uppercase tracking-widest">
            Equity audit
          </p>
          <p className="text-[11px] text-ink leading-relaxed">
            {dossier.equity_audit}
          </p>
        </div>
      )}

      {/* ── Trade-offs ── */}
      {dossier.key_trade_offs?.length > 0 && (
        <div>
          <p className="text-[9px] font-mono text-ink-subtle uppercase tracking-widest mb-2">
            Key trade-offs
          </p>
          <ul className="space-y-1">
            {dossier.key_trade_offs.map((t, i) => (
              <li
                key={i}
                className="text-[11px] text-ink-muted leading-relaxed pl-3 relative before:content-['—'] before:absolute before:left-0 before:text-ink-subtle"
              >
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Downloads ── */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={handleDownloadPdf}
          className="flex items-center gap-2 text-[11px] font-mono text-evidence-deep bg-evidence-soft hover:bg-evidence-soft/80 border border-evidence/40 hover:border-evidence/60 rounded-md px-3 py-2 transition-all justify-center group"
        >
          <FileText size={12} className="group-hover:translate-y-0.5 transition-transform" />
          Full dossier PDF
        </button>
        <button
          onClick={handleDownloadBidPack}
          className="flex items-center gap-2 text-[11px] font-mono text-fund-deep bg-fund-soft hover:bg-fund-soft/80 border border-fund/40 hover:border-fund/60 rounded-md px-3 py-2 transition-all justify-center group"
          title="One-page exec summary + pre-filled standard UK env-grant questions"
        >
          <FileText size={12} className="group-hover:translate-y-0.5 transition-transform" />
          Bid pack
        </button>
        <button
          onClick={handleDownloadMarkdown}
          className="col-span-2 flex items-center gap-2 text-[11px] font-mono text-ink-muted hover:text-ink bg-paper-elevated hover:bg-paper-deep border border-line-strong/70 rounded-md px-3 py-2 transition-all justify-center"
        >
          <Download size={12} />
          Download as .md
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
