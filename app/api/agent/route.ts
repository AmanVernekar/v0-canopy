import { streamText, stepCountIs, convertToModelMessages, type UIMessage, type ModelMessage } from "ai"
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
  const hasPriorAssistant = uiMessages.some((m) => m.role === "assistant")

  const systemText = hasPriorAssistant
    ? `${systemPrompt}\n\n# Follow-up mode\n\nThe planner is asking a follow-up question about the dossier you just produced. Answer concisely with the same evidence-led tone. You can call tools again if a question demands fresh data. If the user asks you to revise interventions or funds, emit a new \`\`\`json block with the updated dossier (same schema). Otherwise, no JSON block needed.`
    : systemPrompt

  let convoMessages: ModelMessage[]
  if (!hasPriorAssistant) {
    const lsoaCode =
      uiMessages[uiMessages.length - 1]?.parts?.find(
        (p): p is { type: "text"; text: string } => p.type === "text"
      )?.text ?? body?.lsoa_code ?? "UNKNOWN"

    convoMessages = [
      {
        role: "user",
        content: `Plan urban heat interventions for LSOA \`${lsoaCode}\`.

Follow the STEP structure in the system prompt — emit each "## Step N:" heading verbatim so the planner can follow your reasoning. Start with get_lsoa_context, form hypotheses via query_lsoa_subset, search the evidence, then call search_funding_schemes AND scrape each candidate URL with scrape_funding_page (Bright Data) to verify status. End with the JSON block exactly as specified.`,
      },
    ]
  } else {
    convoMessages = await convertToModelMessages(uiMessages)
  }

  // Prompt caching: mark the system prompt as ephemeral-cacheable. Anthropic caches
  // everything up to and including this block, so the system text + tool definitions
  // (which the SDK serialises after `system`) are reused across the agent's tool-loop
  // steps and across follow-up turns. Cache reads cost ~10% of normal input tokens.
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: systemText,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    },
    ...convoMessages,
  ]

  const result = streamText({
    model: anthropic("claude-sonnet-4-5"),
    messages,
    tools,
    // Cap output ceiling — the default (64k) bloats accounting and isn't needed.
    maxOutputTokens: 8192,
    // Allow the agent to chain tool calls — multiple rounds of tool/text steps.
    stopWhen: stepCountIs(20),
  })

  return result.toUIMessageStreamResponse()
}
