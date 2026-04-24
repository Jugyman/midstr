const BACKEND_BASE_URL =
  process.env.BACKEND_BASE_URL ||
  process.env.API_BASE_URL ||
  'http://localhost:3001'

const FILTERS = {
  ALL: 'all',
  OPEN: 'open',
  ACTIVE: 'active',
  RESOLVED: 'resolved',
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function shortText(text, max = 90) {
  const value = String(text || '')
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

function formatStake(stake, tokenSymbol) {
  if (stake === null || stake === undefined || stake === '') {
    return `— ${tokenSymbol || 'MIDSTR'}`
  }

  const numeric = Number(stake)
  if (Number.isNaN(numeric)) {
    return `${stake} ${tokenSymbol || 'MIDSTR'}`
  }

  return `${numeric.toLocaleString()} ${tokenSymbol || 'MIDSTR'}`
}

function normalizeStatus(status) {
  return String(status || '').trim().toUpperCase()
}

function displayStatus(status) {
  const s = normalizeStatus(status)

  if (s === 'CREATED') return 'Open'
  if (s === 'ACTIVE') return 'Active'
  if (s === 'CLOSED') return 'Awaiting Result'
  if (s === 'WAITING_RESULT') return 'Awaiting Result'
  if (s === 'RESOLUTION_WINDOW') return 'Resolution Window'
  if (s === 'DISPUTED') return 'Disputed'
  if (['RESOLVED', 'FINALISED', 'FINALIZED'].includes(s)) return 'Resolved'
  if (s === 'CANCELLED') return 'Cancelled'
  if (s === 'EXPIRED') return 'Expired'

  return s || 'Unknown'
}

function statusEmoji(status) {
  const s = normalizeStatus(status)

  if (s === 'CREATED') return '🟡'
  if (s === 'ACTIVE') return '🟢'
  if (s === 'CLOSED') return '⏳'
  if (s === 'WAITING_RESULT') return '⌛'
  if (s === 'RESOLUTION_WINDOW') return '⚖️'
  if (s === 'DISPUTED') return '🚨'
  if (['RESOLVED', 'FINALISED', 'FINALIZED'].includes(s)) return '✅'
  if (['CANCELLED', 'EXPIRED'].includes(s)) return '⚫'

  return '•'
}

function isOpenStatus(status) {
  return normalizeStatus(status) === 'CREATED'
}

function isActiveStatus(status) {
  const s = normalizeStatus(status)
  return s === 'ACTIVE' || s === 'CLOSED' || s === 'WAITING_RESULT' || s === 'RESOLUTION_WINDOW' || s === 'DISPUTED'
}

function isResolvedStatus(status) {
  const s = normalizeStatus(status)
  return ['RESOLVED', 'FINALISED', 'FINALIZED', 'CANCELLED', 'EXPIRED'].includes(s)
}

function isLegacyHiddenStatus(status) {
  const s = normalizeStatus(status)
  return s === 'DRAFT_PENDING_SIGNATURE' || s === 'DRAFT'
}

function getUsableBetId(bet) {
  return (
    bet?.betId ||
    bet?.id ||
    bet?.bet?.betId ||
    ''
  )
}

function getCleanedBetTitle(bet) {
  return (
    bet?.cleanedBet ||
    bet?.cleanedBetText ||
    bet?.betText ||
    bet?.rawBetText ||
    'Untitled bet'
  )
}

function getRoleLabel(bet) {
  if (bet?.role === 'CREATOR') return 'Creator'
  if (bet?.role === 'TAKER') return 'Taker'
  return 'User'
}

function getSortTime(bet) {
  return (
    Date.parse(bet?.updatedAt || '') ||
    Date.parse(bet?.createdAt || '') ||
    Date.parse(bet?.closeAt || '') ||
    0
  )
}

function sortNewestFirst(items) {
  return [...items].sort((a, b) => getSortTime(b) - getSortTime(a))
}

function normaliseBetShape(bet) {
  const status = normalizeStatus(bet?.status || bet?.statusLabel || '')
  const betId = getUsableBetId(bet)

  return {
    ...bet,
    betId,
    status,
    statusDisplay: displayStatus(status),
    cleanedBet: getCleanedBetTitle(bet),
    roleLabel: getRoleLabel(bet),
    _usable: Boolean(betId),
    _hiddenLegacy: isLegacyHiddenStatus(status),
  }
}

function isVisibleInMyBets(bet) {
  if (!bet?._usable) return false
  if (bet?._hiddenLegacy) return false
  return true
}

function summarise(bets) {
  const visible = bets.filter(isVisibleInMyBets)

  return {
    total: visible.length,
    open: visible.filter((bet) => isOpenStatus(bet.status)).length,
    active: visible.filter((bet) => isActiveStatus(bet.status)).length,
    resolved: visible.filter((bet) => isResolvedStatus(bet.status)).length,
  }
}

function getFilterFromCallbackData(data) {
  const raw = String(data || '')

  if (raw.startsWith('mybets_filter_')) {
    return raw.replace('mybets_filter_', '') || FILTERS.ALL
  }

  if (raw.startsWith('mybets_refresh_')) {
    return raw.replace('mybets_refresh_', '') || FILTERS.ALL
  }

  if (raw.startsWith('mybets_open_')) {
    const payload = raw.replace('mybets_open_', '')
    const parts = payload.split('__')
    return parts[0] || FILTERS.ALL
  }

  return FILTERS.ALL
}

function getBetIdFromCallbackData(data) {
  const raw = String(data || '')

  if (!raw.startsWith('mybets_open_')) return ''

  const payload = raw.replace('mybets_open_', '')
  const parts = payload.split('__')

  if (parts.length === 1) return parts[0] || ''
  return parts.slice(1).join('__') || ''
}

function selectVisibleBets(bets, filter) {
  const visible = sortNewestFirst(bets.filter(isVisibleInMyBets))

  if (filter === FILTERS.OPEN) {
    return visible.filter((bet) => isOpenStatus(bet.status))
  }

  if (filter === FILTERS.ACTIVE) {
    return visible.filter((bet) => isActiveStatus(bet.status))
  }

  if (filter === FILTERS.RESOLVED) {
    return visible.filter((bet) => isResolvedStatus(bet.status)).slice(0, 10)
  }

  const liveBets = visible.filter((bet) => isOpenStatus(bet.status) || isActiveStatus(bet.status))
  const historyBets = visible.filter((bet) => !(isOpenStatus(bet.status) || isActiveStatus(bet.status)))

  if (liveBets.length >= 10) {
    return liveBets
  }

  return [...liveBets, ...historyBets].slice(0, 10)
}

function classificationLabel(value) {
  const raw = String(value || '').trim().toUpperCase()
  if (!raw) return ''
  if (raw === 'MANUAL_ONLY') return 'Manual Only'
  return raw.charAt(0) + raw.slice(1).toLowerCase()
}

function resolutionNoteForClassification(classification) {
  const raw = String(classification || '').trim().toUpperCase()

  if (raw === 'AMBIGUOUS') {
    return 'This bet may need review at resolution. Challenge flow can apply if the outcome is disputed.'
  }

  if (raw === 'MANUAL_ONLY') {
    return 'This bet is likely to need manual review at resolution. Challenge flow can apply if the outcome is disputed.'
  }

  return ''
}

function buildBetLine(bet) {
  const emoji = statusEmoji(bet.status)
  const title = shortText(bet.cleanedBet, 80)
  const stake = formatStake(bet.stake ?? bet.stakeAmount, bet.tokenSymbol)

  return (
    `${emoji} <b>${escapeHtml(title)}</b>\n` +
    `Role: ${escapeHtml(bet.roleLabel)}\n` +
    `Status: <b>${escapeHtml(bet.statusDisplay || 'Unknown')}</b>\n` +
    `Stake: ${escapeHtml(stake)}\n` +
    `Bet ID: <code>${escapeHtml(bet.betId)}</code>`
  )
}

function filterLabel(filter) {
  if (filter === FILTERS.OPEN) return 'Open'
  if (filter === FILTERS.ACTIVE) return 'Active'
  if (filter === FILTERS.RESOLVED) return 'Resolved'
  return 'All'
}

function buildMyBetsMessage(summary, visibleBets, filter) {
  const header =
    `📜 <b>My Bets</b>\n\n` +
    `View: <b>${escapeHtml(filterLabel(filter))}</b>\n` +
    `Total: <b>${summary.total}</b>\n` +
    `Open: <b>${summary.open}</b> | Active: <b>${summary.active}</b> | Resolved: <b>${summary.resolved}</b>\n\n`

  if (!visibleBets.length) {
    return header + `No bets in this view yet.`
  }

  const body = visibleBets
    .map((bet, index) => `${index + 1}.\n${buildBetLine(bet)}`)
    .join('\n\n')

  return header + body
}

function filterButton(text, filter, currentFilter) {
  const prefix = currentFilter === filter ? '• ' : ''
  return {
    text: `${prefix}${text}`,
    callback_data: `mybets_filter_${filter}`,
  }
}

function buildMyBetsKeyboard(visibleBets, currentFilter) {
  const rows = [
    [
      filterButton('All', FILTERS.ALL, currentFilter),
      filterButton('Open', FILTERS.OPEN, currentFilter),
    ],
    [
      filterButton('Active', FILTERS.ACTIVE, currentFilter),
      filterButton('Resolved', FILTERS.RESOLVED, currentFilter),
    ],
  ]

  const topBetButtons = visibleBets
    .slice(0, 5)
    .filter((bet) => bet.betId)
    .map((bet) => [
      {
        text: `Open ${bet.betId}`,
        callback_data: `mybets_open_${currentFilter}__${bet.betId}`,
      },
    ])

  rows.push(...topBetButtons)

  rows.push([
    { text: '🔄 Refresh', callback_data: `mybets_refresh_${currentFilter}` },
    { text: '🏠 Back', callback_data: 'nav:start' },
  ])

  return {
    inline_keyboard: rows,
  }
}

async function fetchJson(url) {
  const response = await fetch(url)

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`HTTP ${response.status}: ${text}`)
  }

  return response.json()
}

async function loadMyBets(telegramUserId) {
  const betsRes = await fetchJson(`${BACKEND_BASE_URL}/users/${telegramUserId}/bets`)
  const rawBets = Array.isArray(betsRes.bets) ? betsRes.bets : []
  const bets = rawBets.map(normaliseBetShape)

  return {
    summary: summarise(bets),
    bets,
  }
}

async function sendMyBetsScreen(bot, chatId, telegramUserId, filter = FILTERS.ALL) {
  const { summary, bets } = await loadMyBets(telegramUserId)
  const visibleBets = selectVisibleBets(bets, filter)

  return bot.sendMessage(chatId, buildMyBetsMessage(summary, visibleBets, filter), {
    parse_mode: 'HTML',
    reply_markup: buildMyBetsKeyboard(visibleBets, filter),
  })
}

async function refreshMyBetsScreen(bot, query) {
  const chatId = query.message.chat.id
  const messageId = query.message.message_id
  const telegramUserId = query.from.id
  const filter = getFilterFromCallbackData(query.data)

  const { summary, bets } = await loadMyBets(telegramUserId)
  const visibleBets = selectVisibleBets(bets, filter)

  return bot.editMessageText(buildMyBetsMessage(summary, visibleBets, filter), {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: buildMyBetsKeyboard(visibleBets, filter),
  })
}

async function handleMyBetsOpen(bot, query, backendBaseUrl = BACKEND_BASE_URL) {
  const betId = getBetIdFromCallbackData(query.data)
  const chatId = query.message.chat.id
  const filter = getFilterFromCallbackData(query.data)

  if (!betId || betId === 'undefined') {
    return bot.answerCallbackQuery(query.id, {
      text: 'This bet is not available.',
      show_alert: false,
    })
  }

  const response = await fetchJson(`${backendBaseUrl}/bets/${betId}`)
  const bet = normaliseBetShape(response.bet || response.data || response)

  const role =
    String(
      bet.creatorTelegramUserId ??
      bet.creatorTelegramId ??
      bet.creatorUserId ??
      bet.telegramUserId ??
      ''
    ) === String(query.from.id)
      ? 'Creator'
      : bet.roleLabel || 'Taker'

  const lines = [
    `🎯 <b>Bet Details</b>`,
    ``,
    `<b>${escapeHtml(bet.cleanedBet)}</b>`,
    ``,
    `Bet ID: <code>${escapeHtml(bet.betId || betId)}</code>`,
    `Role: ${escapeHtml(role)}`,
    `Status: <b>${escapeHtml(bet.statusDisplay || 'Unknown')}</b>`,
    `Stake: ${escapeHtml(formatStake(bet.stake ?? bet.stakeAmount, bet.tokenSymbol || 'MIDSTR'))}`,
  ]

  if (bet.classification) {
    lines.push(`Classification: ${escapeHtml(classificationLabel(bet.classification))}`)
  }

  if (bet.closeAt || bet.closeTimeUtc || bet.closeTime) {
    lines.push(`Open until: ${escapeHtml(bet.closeAt || bet.closeTimeUtc || bet.closeTime)}`)
  }

  if (bet.resultExpectedBy || bet.resultExpectedByUtc) {
    lines.push(`Result expected by: ${escapeHtml(bet.resultExpectedBy || bet.resultExpectedByUtc)}`)
  }

  const resolutionNote = resolutionNoteForClassification(bet.classification)
  if (resolutionNote) {
    lines.push(`Resolution note: ${escapeHtml(resolutionNote)}`)
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '📜 Back to My Bets', callback_data: `mybets_filter_${filter}` }],
      [{ text: '🏠 Back', callback_data: 'nav:start' }],
    ],
  }

  return bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  })
}

module.exports = {
  loadMyBets,
  sendMyBetsScreen,
  refreshMyBetsScreen,
  handleMyBetsOpen,
}