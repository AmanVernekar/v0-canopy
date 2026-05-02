import { NextResponse } from "next/server"
import { serverSupabase } from "@/lib/supabase"

/**
 * Per-session analysis persistence.
 *
 * Schema lives in supabase/migrations/0001_init.sql.
 *
 *   GET  /api/analyses?session=<id>&lsoa=<code>   → one analysis (or 204)
 *   GET  /api/analyses?session=<id>               → list for the session
 *   POST /api/analyses                            → upsert (body: full row)
 */
export async function GET(req: Request) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json(
      { error: "Supabase not configured" },
      { status: 503 }
    )
  }
  const url = new URL(req.url)
  const session = url.searchParams.get("session")
  const lsoa = url.searchParams.get("lsoa")
  if (!session) {
    return NextResponse.json({ error: "session required" }, { status: 400 })
  }
  const supa = serverSupabase()
  if (lsoa) {
    const { data, error } = await supa
      .from("analyses")
      .select("*")
      .eq("session_id", session)
      .eq("lsoa_code", lsoa)
      .maybeSingle()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!data) return new NextResponse(null, { status: 204 })
    return NextResponse.json(data)
  }
  const { data, error } = await supa
    .from("analyses")
    .select("id, lsoa_code, area_name, updated_at, created_at, parsed_dossier")
    .eq("session_id", session)
    .order("updated_at", { ascending: false })
    .limit(50)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ analyses: data ?? [] })
}

export async function POST(req: Request) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json(
      { error: "Supabase not configured" },
      { status: 503 }
    )
  }
  let body: {
    session_id?: string
    lsoa_code?: string
    area_name?: string | null
    messages?: unknown
    parsed_dossier?: unknown
    critic_enabled?: boolean
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 })
  }
  if (!body.session_id || !body.lsoa_code || body.messages === undefined) {
    return NextResponse.json(
      { error: "session_id, lsoa_code, messages required" },
      { status: 400 }
    )
  }
  const supa = serverSupabase()
  const { data, error } = await supa
    .from("analyses")
    .upsert(
      {
        session_id: body.session_id,
        lsoa_code: body.lsoa_code,
        area_name: body.area_name ?? null,
        messages: body.messages,
        parsed_dossier: body.parsed_dossier ?? null,
        critic_enabled: body.critic_enabled ?? false,
      },
      { onConflict: "session_id,lsoa_code" }
    )
    .select()
    .maybeSingle()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, analysis: data })
}
