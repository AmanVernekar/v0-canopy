"use client"

import { useCallback } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Download, TriangleAlert, CheckCircle } from "lucide-react"
import { motion } from "framer-motion"
import type { ParsedDossier } from "@/lib/store"

interface DossierViewProps {
  dossier: ParsedDossier
  rawMarkdown: string
}

const priorityConfig = {
  critical: { label: "Critical Priority", color: "text-red-400", bg: "bg-red-400/10 border-red-400/30", Icon: TriangleAlert },
  high: { label: "High Priority", color: "text-amber-400", bg: "bg-amber-400/10 border-amber-400/30", Icon: TriangleAlert },
  medium: { label: "Medium Priority", color: "text-yellow-400", bg: "bg-yellow-400/10 border-yellow-400/30", Icon: CheckCircle },
  low: { label: "Low Priority", color: "text-green-400", bg: "bg-green-400/10 border-green-400/30", Icon: CheckCircle },
}

export function DossierView({ dossier, rawMarkdown }: DossierViewProps) {
  const handleDownload = useCallback(() => {
    const blob = new Blob([rawMarkdown], { type: "text/markdown" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `shade-dossier-${dossier.lsoa_code}.md`
    a.click()
    URL.revokeObjectURL(url)
  }, [rawMarkdown, dossier.lsoa_code])

  const priority = priorityConfig[dossier.priority_level as keyof typeof priorityConfig] ?? priorityConfig.medium
  const PriorityIcon = priority.Icon

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      {/* Priority badge + cost */}
      <div className="flex items-center justify-between gap-3">
        <div
          className={`flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded border ${priority.bg} ${priority.color}`}
        >
          <PriorityIcon size={11} />
          <span>{priority.label}</span>
        </div>
        <div className="text-right">
          <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">
            Total indicative cost
          </p>
          <p className="text-sm font-mono text-amber-400">
            £{dossier.total_estimated_cost_gbp.toLocaleString()}
          </p>
        </div>
      </div>

      {/* Intervention summary chips */}
      <div className="flex flex-wrap gap-1.5">
        {dossier.interventions.map((iv, i) => (
          <span
            key={i}
            className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/60"
          >
            {iv.title}
          </span>
        ))}
      </div>

      {/* Markdown content */}
      <div className="prose prose-sm prose-invert max-w-none prose-p:text-zinc-400 prose-p:text-xs prose-headings:text-zinc-200 prose-headings:font-medium prose-strong:text-zinc-300 prose-li:text-zinc-400 prose-li:text-xs prose-code:text-cyan-300 prose-code:text-[11px] prose-blockquote:border-zinc-700 prose-blockquote:text-zinc-500">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {dossier.summary}
        </ReactMarkdown>
      </div>

      {/* Download button */}
      <button
        onClick={handleDownload}
        className="flex items-center gap-2 text-[11px] font-mono text-zinc-400 hover:text-cyan-400 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/60 hover:border-cyan-400/40 rounded-md px-3 py-2 transition-all w-full justify-center group"
      >
        <Download size={12} className="group-hover:translate-y-0.5 transition-transform" />
        Download dossier (.md)
      </button>
    </motion.div>
  )
}
