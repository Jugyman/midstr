function formatMaybe(value, fallback = '—') {
  if (value === undefined || value === null || value === '') return fallback
  return String(value)
}

function formatList(items) {
  if (!Array.isArray(items) || items.length === 0) return '—'
  return items.map((item) => `• ${item}`).join('\n')
}

export function renderClassificationMessage(result) {
  const cleanedBet =
    result.cleanedBet ||
    result.cleanedText ||
    result.normalizedBet ||
    result.rewrittenBet ||
    result.rawBetText ||
    '—'

  const classification =
    result.classification ||
    result.betType ||
    result.category ||
    'UNKNOWN'

  const confidence =
    result.confidence !== undefined && result.confidence !== null
      ? String(result.confidence)
      : '—'

  const decisionType = result.decisionType
  const settlementBasis = result.settlementBasis
  const earliestCheckTime = result.earliestCheckTime
  const latestDecisionTime = result.latestDecisionTime
  const explanation = result.explanation || result.reasoning || result.summary
  const missingFields = result.missingFields || []
  const needsResultExpectedBy =
    classification === 'AMBIGUOUS' || classification === 'MANUAL_ONLY'

  return [
    'MIDSTR bet draft',
    '',
    'Cleaned bet',
    cleanedBet,
    '',
    'Classification',
    classification,
    '',
    'Confidence',
    confidence,
    '',
    'Decision type',
    formatMaybe(decisionType),
    '',
    'Settlement basis',
    formatMaybe(settlementBasis),
    '',
    'Earliest check time',
    formatMaybe(earliestCheckTime),
    '',
    'Latest decision time',
    formatMaybe(latestDecisionTime),
    '',
    'Explanation',
    formatMaybe(explanation),
    '',
    'Missing / unclear fields',
    formatList(missingFields),
    '',
    'Result Expected By required',
    needsResultExpectedBy ? 'Yes' : 'No',
    '',
    'Choose an action below.'
  ].join('\n')
}

export function renderSigningHandoffMessage({ classification, signingUrl }) {
  const needsResultExpectedBy =
    classification === 'AMBIGUOUS' || classification === 'MANUAL_ONLY'

  return [
    'Next step: create the bet in web signer',
    '',
    'Your draft has been saved.',
    '',
    'Open the signing page below to:',
    '• review the cleaned bet',
    '• set stake / close time',
    needsResultExpectedBy
      ? '• set Result Expected By (required for this classification)'
      : '• continue without Result Expected By unless you choose to add one',
    '• connect wallet',
    '• approve and create onchain',
    '',
    'Signing URL',
    signingUrl
  ].join('\n')
}