import { streamText, stepCountIs } from "ai"
import { gateway } from "@ai-sdk/gateway"
import { tools } from "@/lib/agent/tools"
import { systemPrompt } from "@/lib/agent/prompts"

export const maxDuration = 60

export async function POST(req: Request) {
  // Fail loudly if the API key is missing — per context.md, no silent fallbacks.
  if (!process.env.AI_GATEWAY_API_KEY) {
    return new Response(
      JSON.stringify({
        error:
          "AI_GATEWAY_API_KEY is not set. Add it to .env.local at the project root, then restart `pnpm dev`. Get a key at https://vercel.com/dashboard → AI Gateway.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }

  const body = await req.json()

  // Two callers possible:
  //   1) AI SDK useChat — body.messages = [{ parts: [{ type:"text", text:"E01003911" }] }]
  //   2) Direct       — body.lsoa_code = "E01003911"
  const lsoaCode: string =
    body?.messages?.[body.messages.length - 1]?.parts?.[0]?.text ??
    body?.lsoa_code ??
    "UNKNOWN"

  const userPrompt = `Plan urban heat interventions for LSOA \`${lsoaCode}\`. Start with get_lsoa_context, form hypotheses about the place via query_lsoa_subset, search the evidence, and produce a grant-ready dossier with funded interventions. Use the JSON schema in the system prompt for the final block.`

  const result = streamText({
    model: gateway("anthropic/claude-sonnet-4.5"),
    system: systemPrompt,
    prompt: userPrompt,
    tools,
    // Allow the agent to chain tool calls — multiple rounds of tool/text steps.
    stopWhen: stepCountIs(20),
  })

  return result.toUIMessageStreamResponse()
}
