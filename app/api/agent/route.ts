import { streamText, stepCountIs, convertToModelMessages, type UIMessage, type ModelMessage } from "ai"
import { anthropic } from "@ai-sdk/anthropic"
import { tools } from "@/lib/agent/tools"
import { systemPrompt } from "@/lib/agent/prompts"

export const maxDuration = 300

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
  // Optional adversarial review pass — appends a Step 8 instruction so the
  // agent self-critiques the dossier in the same stream. Off by default
  // (extra tokens) — controlled by a toggle in the UI.
  const criticEnabled = Boolean(body?.criticEnabled)

  const criticAddendum = `

## Step 8 · Adversarial self-review (critic pass)
After emitting the JSON dossier, take ONE more pass as a sceptical senior climate officer would. List 3–5 weaknesses across the WHOLE proposal — not just funding. Examples to consider: Are the interventions actually heterogeneous, or did you default to similar suggestions? Is evidence over-stated for any "strong" rating? Did you under-weight maintenance burden? Did the equity audit gloss over a real fairness risk? Are there feasible interventions you skipped? For each weakness, propose either (a) a specific revision to the dossier or (b) accept the trade-off explicitly. If revisions are warranted, emit a SECOND fenced \`\`\`json block with the updated dossier (same schema) — it must be the LAST json block in your response.`

  const baseSystem = criticEnabled ? `${systemPrompt}${criticAddendum}` : systemPrompt
  const systemText = hasPriorAssistant
    ? `${baseSystem}\n\n# Follow-up mode\n\nThe planner is asking a follow-up question about the dossier you just produced. Answer concisely with the same evidence-led tone. You can call tools again if a question demands fresh data. If the user asks you to revise interventions or funds, emit a new \`\`\`json block with the updated dossier (same schema). Otherwise, no JSON block needed.`
    : baseSystem

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
    // Suppress the SDK's prompt-injection warning. We're putting our own
    // hardcoded system prompt in messages[0] specifically so we can attach
    // anthropic cacheControl — none of it is user-supplied.
    allowSystemInMessages: true,
  })

  return result.toUIMessageStreamResponse()
}
