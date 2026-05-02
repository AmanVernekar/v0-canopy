import { interpolateYlOrRd } from "d3-scale-chromatic"

/**
 * Map a normalised [0, 1] vulnerability score to a hex colour
 * using the YlOrRd sequential scale.
 */
export function vulnerabilityColour(normalisedScore: number): string {
  // Clamp to [0, 1]
  const t = Math.max(0, Math.min(1, normalisedScore))
  return interpolateYlOrRd(t)
}

/**
 * Normalise a raw vulnerability score given the observed min/max range.
 */
export function normaliseScore(
  score: number,
  min: number,
  max: number
): number {
  if (max === min) return 0.5
  return (score - min) / (max - min)
}

// Cyan accent for selected LSOA
export const SELECTED_STROKE = "#22d3ee" // cyan-400
export const DEFAULT_STROKE = "rgba(255,255,255,0.5)"
export const HOVER_STROKE = "rgba(255,255,255,0.9)"
