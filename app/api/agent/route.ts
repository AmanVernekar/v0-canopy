export const maxDuration = 60

// Helpers for encoding AI SDK v6 UIMessageStream parts
function encodeChunk(part: object): string {
  return `data: ${JSON.stringify(part)}\n\n`
}

function textDelta(delta: string) {
  return encodeChunk({ type: "text-delta", textDelta: delta })
}

function toolCallStart(toolCallId: string, toolName: string) {
  return encodeChunk({
    type: "tool-call",
    toolCallId,
    toolName,
    args: {},
  })
}

function toolResult(toolCallId: string, toolName: string, result: object) {
  return encodeChunk({
    type: "tool-result",
    toolCallId,
    toolName,
    result,
  })
}

function finishChunk(reason = "stop") {
  return encodeChunk({ type: "finish", finishReason: reason, usage: { promptTokens: 150, completionTokens: 400 } })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function* generateMockStream(lsoaCode: string): AsyncGenerator<string> {
  // Opening analysis text
  const intro = `Analysing LSOA **${lsoaCode}** — cross-referencing heat vulnerability indicators, land-use data, and infrastructure registers.\n\n`
  for (const char of intro) {
    yield textDelta(char)
    await sleep(18)
  }

  // Tool call 1: fetch_land_use
  yield toolCallStart("tc_001", "fetch_land_use_data")
  await sleep(400)
  const lu = `Fetched land-use classification for ${lsoaCode}: 68% residential terraced, 14% mixed commercial-retail, 11% surface car parking, 7% other impervious surfaces. No existing tree pits recorded within 200m buffer.`
  yield toolResult("tc_001", "fetch_land_use_data", {
    classification: "residential_terraced",
    impervious_pct: 93,
    tree_pit_count: 0,
    summary: lu,
  })
  await sleep(200)

  const analysis1 =
    `Land-use data retrieved. The area shows **93% impervious surface coverage** — significantly above the borough median of 71%. No existing tree pit infrastructure in the immediate vicinity, indicating a greenfield opportunity for street tree planting.\n\nCross-referencing with EA urban heat surface temperature records (2022–2024)...\n\n`
  for (const char of analysis1) {
    yield textDelta(char)
    await sleep(14)
  }

  // Tool call 2: query_funding_registry
  yield toolCallStart("tc_002", "query_funding_registry")
  await sleep(600)
  const fr = `Found 3 active funding schemes: (1) UKRI Urban Greening Fund — up to £250k per project, deadline 15 Sept 2025. (2) NLHF Green Spaces for Health — up to £150k, open rolling. (3) GLA Urban Cooling Pilot Grant — up to £80k, London boroughs only.`
  yield toolResult("tc_002", "query_funding_registry", {
    schemes: [
      { name: "UKRI Urban Greening Fund", max_gbp: 250000, deadline: "2025-09-15" },
      { name: "NLHF Green Spaces for Health", max_gbp: 150000, deadline: "rolling" },
      { name: "GLA Urban Cooling Pilot Grant", max_gbp: 80000, deadline: "rolling" },
    ],
    summary: fr,
  })
  await sleep(200)

  const analysis2 =
    `Funding registry queried. Three active schemes are eligible for interventions in this area. The **UKRI Urban Greening Fund** offers the highest ceiling at £250k and aligns well with the proposed street tree programme. The **GLA Urban Cooling Pilot Grant** is London-specific and fast-tracked — suitable for smaller-scale cool pavements works.\n\n`
  for (const char of analysis2) {
    yield textDelta(char)
    await sleep(14)
  }

  const synthesis = `## Synthesis\n\nBased on the vulnerability profile and land-use audit, two primary interventions are recommended for immediate planning consideration:\n\n1. **Street tree installation** — 8–12 semi-mature native specimens along the primary residential streetscape, targeting the identified car park and wide-pavement sections. Projected canopy cover increase: +4.1% within 5 years.\n\n2. **Cool roofs retrofit** — coordination with the existing housing stock management programme to apply high-albedo coating to flat-roof sections of the post-war residential blocks. Estimated 1.8–2.4°C surface temperature reduction in peak summer conditions.\n\nFull dossier follows.\n\n`
  for (const char of synthesis) {
    yield textDelta(char)
    await sleep(12)
  }

  // Structured JSON dossier
  const dossier = `\`\`\`json
{
  "lsoa_code": "${lsoaCode}",
  "summary": "High-priority urban heat intervention required. Area exhibits 93% impervious cover, near-zero canopy, and IMD decile 2 — compounding heat vulnerability for a predominantly elderly and socially rented population. Two targeted interventions identified with combined indicative cost of £187,500 and strong funding pathway via UKRI and GLA schemes.",
  "priority_level": "critical",
  "total_estimated_cost_gbp": 187500,
  "interventions": [
    {
      "type": "street_trees",
      "title": "Street Tree Installation Programme",
      "rationale_short": "Zero existing canopy cover on primary residential streets. 10 semi-mature native trees would deliver +4.1% local canopy cover within 5 years, reducing peak heat island effect by up to 3°C.",
      "estimated_cost_gbp": 85000,
      "target_locations": [
        { "lat": 51.4902, "lng": -0.0871 },
        { "lat": 51.4915, "lng": -0.0854 },
        { "lat": 51.4888, "lng": -0.0862 }
      ]
    },
    {
      "type": "cool_roofs",
      "title": "Cool Roof Albedo Retrofit",
      "rationale_short": "Post-war flat-roof residential blocks absorb significant solar radiation. High-albedo coating application would reduce roof surface temperatures by 15–20°C and lower internal cooling demand.",
      "estimated_cost_gbp": 102500,
      "target_locations": [
        { "lat": 51.4895, "lng": -0.0890 },
        { "lat": 51.4878, "lng": -0.0881 },
        { "lat": 51.4908, "lng": -0.0843 }
      ]
    }
  ]
}
\`\`\``

  for (const char of dossier) {
    yield textDelta(char)
    await sleep(8)
  }

  yield finishChunk()
}

export async function POST(req: Request) {
  const body = await req.json()
  const lsoaCode: string = body?.messages?.[body.messages.length - 1]?.parts?.[0]?.text ?? body?.lsoa_code ?? "UNKNOWN"

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      try {
        for await (const chunk of generateMockStream(lsoaCode)) {
          controller.enqueue(encoder.encode(chunk))
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Vercel-AI-Data-Stream": "v1",
    },
  })
}
