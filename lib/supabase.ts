/**
 * Supabase clients.
 *
 * Two flavours:
 *   - browserSupabase()   — anon-key client, safe to import into "use client"
 *                            components; subject to RLS.
 *   - serverSupabase()    — service-role client; ONLY used inside route
 *                            handlers. Never import this from client files.
 *
 * The factory pattern keeps the keys out of the client bundle (Next.js will
 * still ship NEXT_PUBLIC_SUPABASE_ANON_KEY by design).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

let _browser: SupabaseClient | null = null
let _server: SupabaseClient | null = null

export function browserSupabase(): SupabaseClient {
  if (_browser) return _browser
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error(
      "Supabase env vars missing. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local."
    )
  }
  _browser = createClient(url, key, {
    auth: { persistSession: false },
  })
  return _browser
}

export function serverSupabase(): SupabaseClient {
  if (_server) return _server
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      "Server Supabase env vars missing. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local."
    )
  }
  _server = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return _server
}
