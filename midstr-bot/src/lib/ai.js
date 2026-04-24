import { config } from '../config.js'

export async function classifyBet(rawBetText) {
  const response = await fetch(`${config.aiBackendUrl}/ai/classify-bet`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      rawBetText
    })
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `AI classify request failed: ${response.status} ${response.statusText} ${body}`
    )
  }

  const json = await response.json()

  if (!json?.ok) {
    throw new Error(`AI backend returned non-ok payload: ${JSON.stringify(json)}`)
  }

  return json
}