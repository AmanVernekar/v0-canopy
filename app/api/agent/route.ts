import { streamText, stepCountIs, convertToModelMessages, type UIMessage } from "ai"
import { anthropic } from "@ai-sdk/anthropic"
import { tools } from "@/lib/agent/tools"
import { systemPrompt } from "@/lib/agent/prompts"

export const maxDuration = 60

export async function POST(req: Request) {
  // Fail loudly if the API key is missing — per context.md, no silent fallbacks.
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({
        error:
          "ANTHROPIC_API_KEY is not set. Add it to .env.local at the project root, then restart `pnpm dev`. Get a key at https://console.anthropic.com/settings/keys.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }

  const body = await req.json()
  const uiMessages: UIMessage[] = body?.messages ?? []

  // Detect first turn (LSOA-trigger) vs follow-up by counting prior assistant
  // messages — first user turn always carries an LSOA code only.
  const hasPriorAssistant = uiMessages.some((m) => m.role === "assistant")

  let messages: Awaited<ReturnType<typeof convertToModelMessages>>
  if (!hasPriorAssistant) {
    // First turn — wrap the bare LSOA code in the analysis prompt
    const lsoaCode =
      uiMessages[uiMessages.length - 1]?.parts?.find(
        (p): p is { type: "text"; text: string } => p.type === "text"
      )?.text ?? body?.lsoa_code ?? "UNKNOWN"

    messages = [
      {
        role: "user" as const,
        content: `Plan urban heat interventions for LSOA \`${lsoaCode}\`.

Follow the STEP structure in the system prompt — emit each "## Step N:" heading verbatim so the planner can follow your reasoning. Start with get_lsoa_context, form hypotheses via query_lsoa_subset, search the evidence, then call search_funding_schemes AND scrape each candidate URL with scrape_funding_page (Bright Data) to verify status. End with the JSON block exactly as specified.`,
      },
    ]
  } else {
    // Follow-up Q&A — pass the full conversation back, prefixed with a brief
    // reminder so the model stays in dossier-context.
    messages = await convertToModelMessages(uiMessages)
  }

  const result = streamText({
    model: anthropic("claude-sonnet-4-5"),
    system: hasPriorAssistant
      ? `${systemPrompt}\n\n# Follow-up mode\n\nThe planner is asking a follow-up question about the dossier you just produced. Answer concisely with the same evidence-led tone. You can call tools again if a question demands fresh data. If the user asks you to revise interventions or funds, emit a new \`\`\`json block with the updated dossier (same schema). Otherwise, no JSON block needed.`
      : systemPrompt,
    messages,
    tools,
    // Allow the agent to chain tool calls — multiple rounds of tool/text steps.
    stopWhen: stepCountIs(20),
  })

  return result.toUIMessageStreamResponse()
}
