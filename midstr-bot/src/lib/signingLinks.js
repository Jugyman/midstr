import { config } from '../config.js'

export function buildCreateBetSigningUrl({ draftId, telegramUserId }) {
  const url = new URL('/create-bet', config.publicWebAppBaseUrl)

  url.searchParams.set('draftId', draftId)
  url.searchParams.set('tgUserId', String(telegramUserId))

  return url.toString()
}