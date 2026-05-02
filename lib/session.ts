/**
 * Anonymous session id, persisted in localStorage.
 *
 * Used as the partition key for `analyses` rows in Supabase so a planner's
 * dossiers survive a refresh — without needing auth. Idempotent + SSR-safe.
 */
const KEY = "canopy:session-id-v1"

export function getSessionId(): string {
  if (typeof window === "undefined") return ""
  try {
    let id = window.localStorage.getItem(KEY)
    if (!id) {
      // crypto.randomUUID is widely supported in modern browsers; fall back
      // to a less-collision-resistant random if not present.
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      window.localStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return ""
  }
}
