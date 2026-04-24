require('dotenv').config({ path: __dirname + '/../.env' })

'use strict'

const fs = require('fs')
const path = require('path')
const axios = require('axios')
const TelegramBot = require('node-telegram-bot-api')
const { DateTime } = require('luxon')
const {
  sendMyBetsScreen,
  refreshMyBetsScreen,
  handleMyBetsOpen,
} = require('./myBetsScreen.cjs')

/* -------------------------------------------------------------------------- */
/*                                  CONFIG                                    */
/* -------------------------------------------------------------------------- */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001'
const WEB_BASE_URL = process.env.WEB_BASE_URL || 'http://localhost:3000'
console.log('API_BASE_URL =', API_BASE_URL)
console.log('WEB_BASE_URL =', WEB_BASE_URL)
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Europe/London'
const BOT_DATA_DIR = process.env.BOT_DATA_DIR || path.join(process.cwd(), 'data')
const ARBITER_IMAGE_PATH = path.join(process.cwd(), 'Arbiter.png')
const MIDSTR_FAUCET_URL =
  process.env.MIDSTR_FAUCET_URL || 'https://midstr-faucet-production.up.railway.app'
const SEPOLIA_FAUCET_URL =
  process.env.SEPOLIA_FAUCET_URL || 'https://www.alchemy.com/faucets/ethereum-sepolia'

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('Missing TELEGRAM_BOT_TOKEN in environment')
}

const CONFIG = {
  stakes: [
    { label: '1,000 MIDSTR', value: '1000' },
    { label: '10,000 MIDSTR', value: '10000' },
    { label: '50,000 MIDSTR', value: '50000' },
  ],
  timezoneOptions: [
    { label: 'UK', value: 'Europe/London' },
    { label: 'UTC', value: 'UTC' },
    { label: 'Ireland', value: 'Europe/Dublin' },
    { label: 'Paris', value: 'Europe/Paris' },
    { label: 'Berlin', value: 'Europe/Berlin' },
    { label: 'Athens', value: 'Europe/Athens' },
    { label: 'Dubai', value: 'Asia/Dubai' },
    { label: 'India', value: 'Asia/Kolkata' },
    { label: 'Singapore', value: 'Asia/Singapore' },
    { label: 'Hong Kong', value: 'Asia/Hong_Kong' },
    { label: 'Tokyo', value: 'Asia/Tokyo' },
    { label: 'Sydney', value: 'Australia/Sydney' },
    { label: 'US Eastern', value: 'America/New_York' },
    { label: 'US Central', value: 'America/Chicago' },
    { label: 'US Mountain', value: 'America/Denver' },
    { label: 'US Pacific', value: 'America/Los_Angeles' },
  ],
  exampleBets: [
    'Arsenal will finish above Chelsea this season',
    'Manchester United will win their next league match',
    'The Lakers will win their next game',
    'The Celtics will finish with a better regular season record than the Knicks',
    'The Chiefs will win their next NFL game',
    'The Yankees will win their next series',
    'BTC will close above 120,000 by 31 Dec 2026',
    'ETH will outperform SOL over the next 30 days',
    'Dogecoin will reach 1 USD before XRP does',
    'Tesla will close above 300 USD this Friday',
    'Gold will trade above 3,500 USD this month',
    'The S&P 500 will finish green this week',
    'It will rain in London tomorrow',
    'Daniel will eat more Easter eggs than he planned this week',
  ],
}

/* -------------------------------------------------------------------------- */
/*                                  STORAGE                                   */
/* -------------------------------------------------------------------------- */

ensureDir(BOT_DATA_DIR)

const USERS_FILE = path.join(BOT_DATA_DIR, 'users.json')
const SESSIONS_FILE = path.join(BOT_DATA_DIR, 'sessions.json')

const usersStore = loadJson(USERS_FILE, {})
const sessionsStore = loadJson(SESSIONS_FILE, {})

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2))
      return fallback
    }
    const raw = fs.readFileSync(filePath, 'utf8')
    return raw ? JSON.parse(raw) : fallback
  } catch (err) {
    console.error(`Failed loading ${filePath}:`, err)
    return fallback
  }
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function persistUsers() {
  saveJson(USERS_FILE, usersStore)
}

function persistSessions() {
  saveJson(SESSIONS_FILE, sessionsStore)
}

/* -------------------------------------------------------------------------- */
/*                                SESSION MODEL                               */
/* -------------------------------------------------------------------------- */

const STATES = {
  IDLE: 'idle',
  AWAITING_BET_TEXT: 'awaiting_bet_text',
  REVIEWING_CLASSIFICATION: 'reviewing_classification',
  AWAITING_STAKE: 'awaiting_stake',
  AWAITING_TIMEZONE: 'awaiting_timezone',
  AWAITING_CLOSE_DATE: 'awaiting_close_date',
  AWAITING_CLOSE_TIME: 'awaiting_close_time',
  AWAITING_RESULT_DATE: 'awaiting_result_date',
  AWAITING_RESULT_TIME: 'awaiting_result_time',
  CREATING_DRAFT: 'creating_draft',
  JOIN_REVIEW: 'join_review',
  JOIN_CONFIRM: 'join_confirm',
  JOIN_HANDOFF: 'join_handoff',
  JOIN_PENDING: 'join_pending',
}

function createEmptySession() {
  return {
    state: STATES.IDLE,
    timezoneMode: null, // 'createbet' | 'settings'
    awaitingCustom: null,
    exampleIndex: 0,
    flow: {
      originalBetText: null,
      cleanedBetText: null,
      classification: null,
      explanation: null,
      settlementBasis: null,
      decisionType: null,
      earliestCheckTimeHint: null,
      latestDecisionTimeHint: null,
      requiresResultExpectedBy: false,
      missingFields: [],

      stake: null,
      timezone: null,

      closeDateLocal: null,
      closeTimeLocal: null,
      closeTimeUtc: null,

      resultDateLocal: null,
      resultTimeLocal: null,
      resultExpectedByUtc: null,

      draft: null,
    },
    join: {
      betId: null,
      invite: null,
      joinSessionId: null,
      signingUrl: null,
      status: null,
    },
  }
}

function getSession(userId) {
  if (!sessionsStore[userId]) {
    sessionsStore[userId] = createEmptySession()
    persistSessions()
  }
  return sessionsStore[userId]
}

function resetSession(userId) {
  sessionsStore[userId] = createEmptySession()
  persistSessions()
  return sessionsStore[userId]
}

function clearJoinState(userId) {
  const session = getSession(userId)
  sessionsStore[userId] = {
    ...session,
    state: STATES.IDLE,
    join: createEmptySession().join,
  }
  persistSessions()
  return sessionsStore[userId]
}

function patchSession(userId, patch) {
  const session = getSession(userId)
  sessionsStore[userId] = deepMerge(session, patch)
  persistSessions()
  return sessionsStore[userId]
}

function deepMerge(target, patch) {
  const out = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      out[key] = deepMerge(target[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

function getUserProfile(userId) {
  if (!usersStore[userId]) {
    usersStore[userId] = {
      timezone: null,
      username: null,
      firstName: null,
      updatedAt: new Date().toISOString(),
    }
    persistUsers()
  }
  return usersStore[userId]
}

function saveUserProfile(userId, patch) {
  const current = getUserProfile(userId)
  usersStore[userId] = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  persistUsers()
  return usersStore[userId]
}

/* -------------------------------------------------------------------------- */
/*                                 BOT SETUP                                  */
/* -------------------------------------------------------------------------- */

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true })

console.log('MIDSTR bot started.')

/* -------------------------------------------------------------------------- */
/*                                 TEXT HELPERS                               */
/* -------------------------------------------------------------------------- */

function arbiterIntro(text) {
  return `*The Arbiter*\n${text}`
}

function escapeMd(text) {
  if (text === null || text === undefined) return ''
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')
}

function classificationLabel(raw) {
  if (!raw) return 'Unknown'
  if (raw === 'MANUAL_ONLY') return 'MANUAL ONLY'
  return raw
}

function needsResultExpectedBy(classification) {
  return classification && classification !== 'VERIFIABLE'
}

function buildZonedDateTime(localDate, localTime, timezone) {
  if (!localDate || !localTime || !timezone) {
    return DateTime.invalid('Missing localDate/localTime/timezone')
  }

  if (localTime === '24:00') {
    return DateTime.fromISO(localDate, { zone: timezone })
      .plus({ days: 1 })
      .startOf('day')
  }

  const parts = localTime.split(':')
  if (parts.length !== 2) return DateTime.invalid('Invalid time format')

  const hour = Number(parts[0])
  const minute = Number(parts[1])

  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return DateTime.invalid('Invalid numeric time value')
  }

  return DateTime.fromISO(localDate, { zone: timezone }).set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  })
}

function parseCustomDate(text, timezone) {
  const raw = String(text || '').trim()

  let dt = DateTime.fromFormat(raw, 'yyyy-MM-dd', { zone: timezone })
  if (dt.isValid) return dt.toISODate()

  dt = DateTime.fromFormat(raw, 'dd/MM/yyyy', { zone: timezone })
  if (dt.isValid) return dt.toISODate()

  dt = DateTime.fromFormat(raw, 'd/M/yyyy', { zone: timezone })
  if (dt.isValid) return dt.toISODate()

  return null
}

function parseCustomTime(text) {
  const raw = String(text || '').trim()

  if (raw === '24' || raw === '24:00') return '24:00'

  let dt = DateTime.fromFormat(raw, 'H:mm')
  if (dt.isValid) return dt.toFormat('HH:mm')

  dt = DateTime.fromFormat(raw, 'HH:mm')
  if (dt.isValid) return dt.toFormat('HH:mm')

  dt = DateTime.fromFormat(raw, 'H')
  if (dt.isValid) return dt.toFormat('HH:00')

  return null
}

function localDateFromChoice(choice, timezone) {
  const now = DateTime.now().setZone(timezone)

  switch (choice) {
    case 'today':
      return now.toISODate()
    case 'tomorrow':
      return now.plus({ days: 1 }).toISODate()
    case 'plus3':
      return now.plus({ days: 3 }).toISODate()
    case 'plus7':
      return now.plus({ days: 7 }).toISODate()
    default:
      return null
  }
}

function isFutureOrNow(dt) {
  const now = DateTime.now().setZone(dt.zoneName)
  return dt.toMillis() >= now.toMillis()
}

function formatLocalDateTime(dateStr, timeStr, timezone) {
  const dt = buildZonedDateTime(dateStr, timeStr, timezone)
  if (!dt.isValid) return 'Not set'
  return `${dt.toFormat('dd LLL yyyy, HH:mm')} (${timezone})`
}

function formatUtc(iso) {
  if (!iso) return 'Not set'
  const dt = DateTime.fromISO(iso, { zone: 'utc' })
  if (!dt.isValid) return 'Invalid'
  return dt.toFormat("dd LLL yyyy, HH:mm 'UTC'")
}

function formatInviteLocal(iso, timezone) {
  if (!iso) return 'Not set'
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone)
  if (!dt.isValid) return 'Invalid'
  return `${dt.toFormat('dd LLL yyyy, HH:mm')} your time`
}

function formatStakeValue(stake) {
  if (stake === null || stake === undefined || stake === '') return '—'
  const n = Number(stake)
  if (Number.isNaN(n)) return String(stake)
  return `${n.toLocaleString()} MIDSTR`
}

function profileDisplayName(profile = {}) {
  if (profile.username) return `@${profile.username}`
  if (profile.firstName) return profile.firstName
  return 'Unknown user'
}

function inviteCreatorLabel(invite = {}) {
  if (invite.creatorTelegramUsername) return `@${invite.creatorTelegramUsername}`
  if (invite.creatorFirstName) return invite.creatorFirstName
  if (invite.creatorDisplayName) return invite.creatorDisplayName
  return 'Unknown user'
}

function isBondReadyClassification(classification) {
  return classification === 'AMBIGUOUS' || classification === 'MANUAL_ONLY'
}

function classificationSupportNote(classification) {
  if (classification === 'VERIFIABLE') {
    return 'This wager should resolve from an objective outcome if the result becomes clear.'
  }

  if (classification === 'AMBIGUOUS') {
    return 'This wager may need review at resolution, and challenge flow can apply if the outcome is disputed.'
  }

  if (classification === 'MANUAL_ONLY') {
    return 'This wager is likely to need manual review, and challenge flow can apply if the outcome is disputed.'
  }

  return ''
}

function pickCreateBetExample(userId) {
  const session = getSession(userId)
  const examples = CONFIG.exampleBets

  if (!examples.length) {
    return 'Arsenal will finish above Chelsea this season'
  }

  const currentIndex = Number(session.exampleIndex || 0) % examples.length
  const nextIndex = (currentIndex + 1) % examples.length

  patchSession(userId, { exampleIndex: nextIndex })

  return examples[currentIndex]
}

function draftSummary(flow) {
  const lines = [
    `*Bet:* ${escapeMd(flow.cleanedBetText || '—')}`,
    `*Classification:* ${escapeMd(classificationLabel(flow.classification))}`,
    `*Stake:* ${escapeMd(formatStakeValue(flow.stake))}`,
    `*Timezone:* ${escapeMd(flow.timezone || '—')}`,
    `*Close \\(local\\):* ${escapeMd(formatLocalDateTime(flow.closeDateLocal, flow.closeTimeLocal, flow.timezone))}`,
    `*Close \\(UTC\\):* ${escapeMd(formatUtc(flow.closeTimeUtc))}`,
  ]

  if (needsResultExpectedBy(flow.classification)) {
    lines.push(`*Result expected by \\(local\\):* ${escapeMd(formatLocalDateTime(flow.resultDateLocal, flow.resultTimeLocal, flow.timezone))}`)
    lines.push(`*Result expected by \\(UTC\\):* ${escapeMd(formatUtc(flow.resultExpectedByUtc))}`)
  }

  return lines.join('\n')
}

function joinInviteSummary(invite, timezone) {
  const lines = [
    'Bet invitation found\\.',
    'Review the wager below\\.',
    '',
    `*Wager:* ${escapeMd(invite.cleanedBetText || '—')}`,
    `*Created by:* ${escapeMd(inviteCreatorLabel(invite))}`,
    `*Stake:* ${escapeMd(formatStakeValue(invite.stake))}`,
    `*Classification:* ${escapeMd(classificationLabel(invite.classification))}`,
    `*Betting closes:* ${escapeMd(formatInviteLocal(invite.closeTimeUtc, timezone))}`,
    `*UTC:* ${escapeMd(formatUtc(invite.closeTimeUtc))}`,
  ]

  if (needsResultExpectedBy(invite.classification)) {
    lines.push(`*Result expected by:* ${escapeMd(formatInviteLocal(invite.resultExpectedByUtc, timezone))}`)
  }

  const supportNote = classificationSupportNote(invite.classification)
  if (supportNote) {
    lines.push(`*Resolution note:* ${escapeMd(supportNote)}`)
  }

  lines.push(`*Status:* ${escapeMd(invite.statusLabel || 'Awaiting opponent')}`)
  lines.push('')
  lines.push('You will be betting directly against this user\\.')

  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/*                                UI HELPERS                                  */
/* -------------------------------------------------------------------------- */

function callbackButton(text, data) {
  return { text, callback_data: data }
}

function urlButton(text, url) {
  return { text, url }
}

function inlineKeyboard(rows) {
  return {
    reply_markup: {
      inline_keyboard: rows,
    },
    parse_mode: 'MarkdownV2',
  }
}

async function sendMd(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: 'MarkdownV2',
    ...extra,
  })
}

async function safeAnswerCallback(query, text) {
  try {
    await bot.answerCallbackQuery(query.id, { text })
  } catch (_) {}
}

async function showMainMenu(chatId) {
  return sendMd(
    chatId,
    arbiterIntro(
      'Welcome\\.\n\nChoose your next step\\.\n\nYou will need *MIDSTR* and *Sepolia ETH* to place test bets\\.'
    ),
    inlineKeyboard([
      [callbackButton('Create Bet', 'nav:createbet')],
      [callbackButton('My Bets', 'nav:mybets')],
      [callbackButton('How It Works', 'nav:howto')],
      [callbackButton('Settings', 'nav:settings')],
    ])
  )
}

async function showSettingsMenu(chatId, userId) {
  const profile = getUserProfile(userId)
  const timezoneText = profile.timezone || 'Not set'

  return sendMd(
    chatId,
    arbiterIntro(`*Settings*\n\n*Timezone:* ${escapeMd(timezoneText)}`),
    inlineKeyboard([
      [callbackButton('Change Timezone', 'nav:timezone')],
      [callbackButton('Back to Start', 'nav:start')],
    ])
  )
}

async function showHowItWorksMenu(chatId) {
  const lines = [
    arbiterIntro('*How It Works*'),
    '',
    '*What you need:*',
    '• MIDSTR to place test bets',
    '• Sepolia ETH for gas',
    '',
    '*Bet types:*',
    '• *VERIFIABLE* \\- objective outcome, easier to resolve',
    '• *AMBIGUOUS* \\- may need extra review',
    '• *MANUAL ONLY* \\- likely needs manual review',
    '',
    '*Resolution:*',
    'The Arbiter proposes a result using the stored bet terms and available evidence\\.',
    '',
    '*Disputes:*',
    'If a result is disputed, challenge flow may apply on relevant bets\\. Bond handling is being prepared for those cases\\.',
    '',
    '*Wallet flow:*',
    'The signing page checks approval automatically\\. If approval is already sufficient, no separate approval step is shown\\.',
    '',
    '*Testing mode:*',
    'Use Sepolia only and a burner wallet until the full flow is fully battle\\-tested\\.',
  ]

  return sendMd(
    chatId,
    lines.join('\n'),
    inlineKeyboard([
      [urlButton('Get Test MIDSTR', MIDSTR_FAUCET_URL)],
      [urlButton('Get Sepolia ETH', SEPOLIA_FAUCET_URL)],
      [callbackButton('Back to Start', 'nav:start')],
    ])
  )
}

async function sendSessionDivider(chatId) {
  if (!fs.existsSync(ARBITER_IMAGE_PATH)) {
    await sendMd(chatId, arbiterIntro('──────────'))
    return
  }

  try {
    await bot.sendPhoto(chatId, ARBITER_IMAGE_PATH, {
      caption: '──────────',
    })
  } catch (err) {
    console.error('Failed to send Arbiter image:', err.message)
    await sendMd(chatId, arbiterIntro('──────────'))
  }
}

async function sendPostDraftMenu(chatId) {
  return sendMd(
    chatId,
    arbiterIntro('Choose your next move\\.'),
    inlineKeyboard([
      [
        callbackButton('My Bets', 'nav:mybets'),
        callbackButton('Start', 'nav:start'),
      ],
      [callbackButton('How It Works', 'nav:howto')],
      [callbackButton('Settings', 'nav:settings')],
    ])
  )
}

/* -------------------------------------------------------------------------- */
/*                              BACKEND ADAPTERS                              */
/* -------------------------------------------------------------------------- */

async function classifyBet(rawBetText) {
  const url = `${API_BASE_URL}/ai/classify-bet`
  const { data } = await axios.post(url, { rawBetText }, { timeout: 30000 })

  if (!data?.ok || !data?.classification || !data?.cleanedBetText) {
    throw new Error('AI classification returned an invalid response')
  }

  return data
}

async function createDraft(payload) {
  const url = `${API_BASE_URL}/drafts`
  const { data } = await axios.post(url, payload, { timeout: 30000 })

  if (!data?.ok || !data?.draft) {
    throw new Error(data?.error || 'Draft endpoint returned an invalid response')
  }

  return data
}

async function fetchBetInvite(betId, telegramUserId) {
  const url = `${API_BASE_URL}/bets/${encodeURIComponent(betId)}`
  const { data } = await axios.get(url, {
    params: { telegramUserId },
    timeout: 30000,
  })

  if (!data?.ok || !data?.bet) {
    throw new Error(data?.error || 'Bet lookup returned an invalid response')
  }

  return data.bet
}

async function createJoinSession(payload) {
  const url = `${API_BASE_URL}/bets/${encodeURIComponent(payload.betId)}/create-join-session`
  const { data } = await axios.post(
    url,
    {
      telegramUserId: payload.telegramUserId,
      telegramUsername: payload.telegramUsername || '',
      telegramFirstName: payload.telegramFirstName || '',
    },
    { timeout: 30000 }
  )

  if (!data?.ok || !data?.joinSessionId) {
    throw new Error(data?.error || 'Join session endpoint returned an invalid response')
  }

  return data
}

async function fetchJoinSession(joinSessionId) {
  const url = `${API_BASE_URL}/join-sessions/${encodeURIComponent(joinSessionId)}`
  const { data } = await axios.get(url, { timeout: 30000 })

  if (!data?.ok) {
    throw new Error(data?.error || 'Join session lookup returned an invalid response')
  }

  return data
}

/* -------------------------------------------------------------------------- */
/*                             FLOW STEP SENDERS                              */
/* -------------------------------------------------------------------------- */

async function startCreateBet(chatId, userId, from) {
  saveUserProfile(userId, {
    username: from.username || null,
    firstName: from.first_name || null,
  })

  const previousSession = getSession(userId)
  const previousExampleIndex = Number(previousSession.exampleIndex || 0)

  resetSession(userId)
  patchSession(userId, {
    state: STATES.AWAITING_BET_TEXT,
    timezoneMode: null,
    exampleIndex: previousExampleIndex,
  })

  const example = pickCreateBetExample(userId)

  await sendMd(
    chatId,
    arbiterIntro(
      `State your bet in one clear sentence\\.\n\nExample: *${escapeMd(example)}*`
    )
  )
}

async function showClassificationReview(chatId, userId) {
  const session = getSession(userId)
  const flow = session.flow

  patchSession(userId, { state: STATES.REVIEWING_CLASSIFICATION })

  const lines = [
    arbiterIntro('Your wager has been read\\.'),
    '',
    `*Cleaned bet:* ${escapeMd(flow.cleanedBetText)}`,
    `*Classification:* ${escapeMd(classificationLabel(flow.classification))}`,
  ]

  if (flow.decisionType) {
    lines.push(`*Decision type:* ${escapeMd(flow.decisionType)}`)
  }

  if (flow.settlementBasis) {
    lines.push(`*Settlement basis:* ${escapeMd(flow.settlementBasis)}`)
  }

  if (flow.explanation) {
    lines.push(`*Note:* ${escapeMd(flow.explanation)}`)
  }

  const supportNote = classificationSupportNote(flow.classification)
  if (supportNote) {
    lines.push(`*Resolution note:* ${escapeMd(supportNote)}`)
  }

  lines.push('', 'Choose your next step\\.')

  await sendMd(
    chatId,
    lines.join('\n'),
    inlineKeyboard([
      [
        callbackButton('Confirm', 'createbet:classify:confirm'),
        callbackButton('Edit', 'createbet:classify:edit'),
      ],
      [callbackButton('Cancel', 'createbet:cancel')],
    ])
  )
}

async function showStakeStep(chatId, userId) {
  patchSession(userId, { state: STATES.AWAITING_STAKE })

  await sendMd(
    chatId,
    arbiterIntro('Choose stake size\\.'),
    inlineKeyboard([
      [
        callbackButton('1,000 MIDSTR', 'createbet:stake:1000'),
        callbackButton('10,000 MIDSTR', 'createbet:stake:10000'),
      ],
      [callbackButton('50,000 MIDSTR', 'createbet:stake:50000')],
      [callbackButton('Cancel', 'createbet:cancel')],
    ])
  )
}

async function showTimezoneStep(chatId, userId, mode) {
  patchSession(userId, {
    state: STATES.AWAITING_TIMEZONE,
    timezoneMode: mode,
  })

  const rows = []
  for (let i = 0; i < CONFIG.timezoneOptions.length; i += 2) {
    rows.push(
      CONFIG.timezoneOptions.slice(i, i + 2).map((tz) =>
        callbackButton(tz.label, `createbet:timezone:${tz.value}`)
      )
    )
  }
  rows.push([callbackButton('Cancel', 'createbet:cancel')])

  const message =
    mode === 'settings'
      ? 'Choose your timezone\\. This only updates your saved setting\\.'
      : 'As this is your first visit, select your timezone before choosing dates and times\\.'

  await sendMd(chatId, arbiterIntro(message), inlineKeyboard(rows))
}

async function maybeShowTimezoneStep(chatId, userId) {
  const profile = getUserProfile(userId)

  if (profile.timezone) {
    patchSession(userId, {
      flow: { timezone: profile.timezone },
    })
    return showCloseDateStep(chatId, userId)
  }

  return showTimezoneStep(chatId, userId, 'createbet')
}

async function showCloseDateStep(chatId, userId) {
  patchSession(userId, {
    state: STATES.AWAITING_CLOSE_DATE,
    awaitingCustom: null,
  })

  await sendMd(
    chatId,
    arbiterIntro('Choose when betting closes\\.'),
    inlineKeyboard([
      [callbackButton('Today', 'createbet:close_date:today'), callbackButton('Tomorrow', 'createbet:close_date:tomorrow')],
      [callbackButton('+3 days', 'createbet:close_date:plus3'), callbackButton('+7 days', 'createbet:close_date:plus7')],
      [callbackButton('Custom', 'createbet:close_date:custom')],
      [callbackButton('Cancel', 'createbet:cancel')],
    ])
  )
}

async function showCloseTimeStep(chatId, userId) {
  patchSession(userId, {
    state: STATES.AWAITING_CLOSE_TIME,
    awaitingCustom: null,
  })

  const session = getSession(userId)

  await sendMd(
    chatId,
    arbiterIntro(
      `Choose the close time\\.\n\nSelected date: *${escapeMd(session.flow.closeDateLocal)}*`
    ),
    inlineKeyboard([
      [callbackButton('06:00', 'createbet:close_time:06:00'), callbackButton('12:00', 'createbet:close_time:12:00')],
      [callbackButton('18:00', 'createbet:close_time:18:00'), callbackButton('24:00', 'createbet:close_time:24:00')],
      [callbackButton('Custom', 'createbet:close_time:custom')],
      [callbackButton('Cancel', 'createbet:cancel')],
    ])
  )
}

async function showResultDateStep(chatId, userId) {
  patchSession(userId, {
    state: STATES.AWAITING_RESULT_DATE,
    awaitingCustom: null,
  })

  await sendMd(
    chatId,
    arbiterIntro('Choose when the result is expected\\.'),
    inlineKeyboard([
      [callbackButton('Today', 'createbet:result_date:today'), callbackButton('Tomorrow', 'createbet:result_date:tomorrow')],
      [callbackButton('+3 days', 'createbet:result_date:plus3'), callbackButton('+7 days', 'createbet:result_date:plus7')],
      [callbackButton('Custom', 'createbet:result_date:custom')],
      [callbackButton('Cancel', 'createbet:cancel')],
    ])
  )
}

async function showResultTimeStep(chatId, userId) {
  patchSession(userId, {
    state: STATES.AWAITING_RESULT_TIME,
    awaitingCustom: null,
  })

  const session = getSession(userId)

  await sendMd(
    chatId,
    arbiterIntro(
      `Choose the result time\\.\n\nSelected date: *${escapeMd(session.flow.resultDateLocal)}*`
    ),
    inlineKeyboard([
      [callbackButton('06:00', 'createbet:result_time:06:00'), callbackButton('12:00', 'createbet:result_time:12:00')],
      [callbackButton('18:00', 'createbet:result_time:18:00'), callbackButton('24:00', 'createbet:result_time:24:00')],
      [callbackButton('Custom', 'createbet:result_time:custom')],
      [callbackButton('Cancel', 'createbet:cancel')],
    ])
  )
}

async function createDraftStep(chatId, userId, from) {
  patchSession(userId, { state: STATES.CREATING_DRAFT })

  const session = getSession(userId)
  const flow = session.flow

  const closeDt = buildZonedDateTime(flow.closeDateLocal, flow.closeTimeLocal, flow.timezone)
  if (!closeDt.isValid) {
    patchSession(userId, { state: STATES.AWAITING_CLOSE_DATE })
    await sendMd(chatId, arbiterIntro('The close time could not be understood\\. Please choose it again\\.'))
    return showCloseDateStep(chatId, userId)
  }

  if (!isFutureOrNow(closeDt)) {
    patchSession(userId, { state: STATES.AWAITING_CLOSE_DATE })
    await sendMd(chatId, arbiterIntro('The close time must be in the future\\. Please choose again\\.'))
    return showCloseDateStep(chatId, userId)
  }

  let resultDt = null
  if (needsResultExpectedBy(flow.classification)) {
    resultDt = buildZonedDateTime(flow.resultDateLocal, flow.resultTimeLocal, flow.timezone)

    if (!resultDt.isValid) {
      patchSession(userId, { state: STATES.AWAITING_RESULT_DATE })
      await sendMd(chatId, arbiterIntro('The result time could not be understood\\. Please choose it again\\.'))
      return showResultDateStep(chatId, userId)
    }

    if (resultDt.toMillis() < closeDt.toMillis()) {
      patchSession(userId, { state: STATES.AWAITING_RESULT_DATE })
      await sendMd(chatId, arbiterIntro('Result expected by must be after betting closes\\. Please choose it again\\.'))
      return showResultDateStep(chatId, userId)
    }
  }

  const closeTimeUtc = closeDt.toUTC().toISO()
  const resultExpectedByUtc = resultDt ? resultDt.toUTC().toISO() : null

  patchSession(userId, {
    flow: {
      closeTimeUtc,
      resultExpectedByUtc,
    },
  })

  const payload = {
    telegramUserId: String(from.id),
    telegramUsername: from.username || '',
    originalBetText: flow.originalBetText,
    cleanedBetText: flow.cleanedBetText,
    classification: flow.classification,
    explanation: flow.explanation || '',
    settlementBasis: flow.settlementBasis || '',
    decisionType: flow.decisionType || 'EVENT_BASED',
    stake: flow.stake,
    closeTime: closeTimeUtc,
    resultExpectedBy: resultExpectedByUtc,
    earliestCheckTimeHint: flow.earliestCheckTimeHint || '',
    latestDecisionTimeHint: flow.latestDecisionTimeHint || '',
    timezone: flow.timezone,
  }

  await sendMd(chatId, arbiterIntro('Preparing your bet\\.'))

  try {
    const result = await createDraft(payload)

    patchSession(userId, {
      state: STATES.IDLE,
      timezoneMode: null,
      awaitingCustom: null,
      flow: {
        draft: result.draft,
      },
    })

    const signingUrl =
      result.signingUrl ||
      `${WEB_BASE_URL}/sign?draftId=${encodeURIComponent(result.draft.draftId)}`

    const lines = [
      arbiterIntro('Bet prepared\\.'),
      '',
      draftSummary(getSession(userId).flow),
      '',
      `*Reference ID:* ${escapeMd(result.draft.draftId)}`,
      `*Open signing page:* ${escapeMd(signingUrl)}`,
      '',
      'The signing page checks approval automatically\\.',
      'If your allowance is already sufficient, no separate approval step will appear\\.',
      'No funds are locked unless the transaction succeeds\\.',
    ]

    await sendMd(chatId, lines.join('\n'))
    await sendSessionDivider(chatId)
    await sendPostDraftMenu(chatId)
  } catch (err) {
    console.error('Draft creation failed:', getErrorMessage(err))
    patchSession(userId, {
      state: STATES.IDLE,
      timezoneMode: null,
    })

    await sendMd(
      chatId,
      arbiterIntro(
        `Bet preparation failed\\.\n\n${escapeMd(getErrorMessage(err))}\n\nUse /createbet to try again\\.`
      )
    )
  }
}

/* -------------------------------------------------------------------------- */
/*                              JOIN FLOW SENDERS                             */
/* -------------------------------------------------------------------------- */

async function startJoinFlow(chatId, userId, from, betId) {
  saveUserProfile(userId, {
    username: from.username || null,
    firstName: from.first_name || null,
  })

  const profile = getUserProfile(userId)
  const timezone = profile.timezone || DEFAULT_TIMEZONE

  await sendMd(chatId, arbiterIntro('Checking bet invitation\\.'))

  try {
    const invite = await fetchBetInvite(betId, userId)

    patchSession(userId, {
      state: STATES.JOIN_REVIEW,
      join: {
        betId,
        invite,
        joinSessionId: null,
        signingUrl: null,
        status: null,
      },
    })

    if (String(invite.creatorTelegramId || '') === String(userId)) {
      return showSelfInviteScreen(chatId, userId)
    }

    if (!invite.joinable) {
      return showInvalidInviteScreen(chatId, userId, invite.invalidReason)
    }

    return showJoinInviteScreen(chatId, userId)
  } catch (err) {
    console.error('Invite lookup failed:', getErrorMessage(err))
    clearJoinState(userId)

    return sendMd(
      chatId,
      arbiterIntro(
        `This invite could not be loaded\\.\n\n${escapeMd(getErrorMessage(err))}`
      ),
      inlineKeyboard([
        [callbackButton('Start', 'nav:start')],
      ])
    )
  }
}

async function showJoinInviteScreen(chatId, userId) {
  const session = getSession(userId)
  const invite = session.join.invite
  const timezone = getUserProfile(userId).timezone || DEFAULT_TIMEZONE

  patchSession(userId, { state: STATES.JOIN_REVIEW })

  return sendMd(
    chatId,
    arbiterIntro(joinInviteSummary(invite, timezone)),
    inlineKeyboard([
      [callbackButton('Join Bet', 'joinbet:review:join')],
      [callbackButton('Start', 'nav:start')],
    ])
  )
}

async function showInvalidInviteScreen(chatId, userId, reason = '') {
  clearJoinState(userId)

  let message = 'This invite is no longer valid\\.\n\nThe bet may already be live, closed, or unavailable\\.'
  if (reason) {
    message += `\n\n${escapeMd(reason)}`
  }

  return sendMd(
    chatId,
    arbiterIntro(message),
    inlineKeyboard([
      [callbackButton('Start', 'nav:start'), callbackButton('My Bets', 'nav:mybets')],
    ])
  )
}

async function showSelfInviteScreen(chatId, userId) {
  const session = getSession(userId)
  const betId = session.join.betId

  patchSession(userId, { state: STATES.JOIN_REVIEW })

  const deepLink = `https://t.me/${process.env.TELEGRAM_BOT_USERNAME || 'YourBotName'}?start=${encodeURIComponent(betId)}`

  return sendMd(
    chatId,
    arbiterIntro(
      `This is your invite link\\.\n\nShare it with your opponent so they can join\\.\n\n*Invite:* ${escapeMd(deepLink)}`
    ),
    inlineKeyboard([
      [callbackButton('My Bets', 'nav:mybets')],
      [callbackButton('Start', 'nav:start')],
    ])
  )
}

async function showJoinConfirmScreen(chatId, userId) {
  const session = getSession(userId)
  const invite = session.join.invite

  patchSession(userId, { state: STATES.JOIN_CONFIRM })

  return sendMd(
    chatId,
    arbiterIntro(
      `You are about to accept this wager\\.\n\n` +
        `*Bet:* ${escapeMd(invite.cleanedBetText || '—')}\n` +
        `*Against:* ${escapeMd(inviteCreatorLabel(invite))}\n` +
        `*Stake to lock:* ${escapeMd(formatStakeValue(invite.stake))}\n\n` +
        `By continuing, you will lock the same stake amount if the transaction succeeds\\.\n\n` +
        `The next step opens the secure signing page\\.`
    ),
    inlineKeyboard([
      [callbackButton('Continue', 'joinbet:confirm:continue')],
      [callbackButton('Back', 'joinbet:confirm:back')],
    ])
  )
}

async function showJoinHandoffScreen(chatId, userId) {
  const session = getSession(userId)
  const invite = session.join.invite
  const signingUrl = session.join.signingUrl || ''
  const isLocalSigningUrl =
    signingUrl.includes('localhost') || signingUrl.includes('127.0.0.1')

  patchSession(userId, { state: STATES.JOIN_HANDOFF })

  if (isLocalSigningUrl) {
    await sendMd(
      chatId,
      arbiterIntro(
        `Accept this bet in your wallet\\.\n\n` +
          `*Stake:* ${escapeMd(formatStakeValue(invite.stake))}\n` +
          `*Against:* ${escapeMd(inviteCreatorLabel(invite))}\n\n` +
          `The wallet page handles approval automatically if needed\\.\n` +
          `If approval is already sufficient, no extra approval step appears\\.\n\n` +
          `*Local signing link:* ${escapeMd(signingUrl)}\n\n` +
          `Open this on the same machine running the local wallet app\\.`
      ),
      inlineKeyboard([
        [callbackButton('Check Status', 'joinbet:pending:check')],
        [callbackButton('Cancel', 'joinbet:handoff:cancel')],
      ])
    )

    return showJoinPendingScreen(chatId, userId)
  }

  await sendMd(
    chatId,
    arbiterIntro(
      `Accept this bet in your wallet\\.\n\n` +
        `*Stake:* ${escapeMd(formatStakeValue(invite.stake))}\n` +
        `*Against:* ${escapeMd(inviteCreatorLabel(invite))}\n\n` +
        `The wallet page checks approval automatically if needed\\.\n` +
        `If approval is already sufficient, no separate approval step appears\\.\n\n` +
        `No funds are locked unless the transaction succeeds\\.`
    ),
    inlineKeyboard([
      [urlButton('Open Signing Page', signingUrl)],
      [callbackButton('Cancel', 'joinbet:handoff:cancel')],
    ])
  )

  return showJoinPendingScreen(chatId, userId)
}

async function showJoinPendingScreen(chatId, userId) {
  patchSession(userId, { state: STATES.JOIN_PENDING })

  return sendMd(
    chatId,
    arbiterIntro(
      `Wallet step opened\\.\nWaiting for on\\-chain confirmation\\.\n\nOnce confirmed, this bet will become active\\.`
    ),
    inlineKeyboard([
      [callbackButton('Check Status', 'joinbet:pending:check')],
      [callbackButton('Cancel', 'joinbet:pending:cancel')],
    ])
  )
}

async function showJoinStillPendingScreen(chatId, userId) {
  const session = getSession(userId)

  return sendMd(
    chatId,
    arbiterIntro(
      `Still waiting for confirmation\\.\n\nComplete the wallet signing step to join this bet\\.`
    ),
    inlineKeyboard([
      [urlButton('Open Signing Page', session.join.signingUrl)],
      [callbackButton('Check Status', 'joinbet:pending:check')],
      [callbackButton('Cancel', 'joinbet:pending:cancel')],
    ])
  )
}

async function showJoinSuccessScreen(chatId, userId) {
  patchSession(userId, {
    state: STATES.IDLE,
    join: {
      status: 'CONFIRMED',
    },
  })

  return sendMd(
    chatId,
    arbiterIntro(
      `Bet accepted\\.\n\nBoth sides are now locked\\.\n\nYou can track this wager in *My Bets*\\.`
    ),
    inlineKeyboard([
      [callbackButton('My Bets', 'nav:mybets')],
      [callbackButton('Start', 'nav:start')],
    ])
  )
}

async function showJoinFailedScreen(chatId, userId, message) {
  patchSession(userId, {
    state: STATES.IDLE,
    join: {
      status: 'FAILED',
    },
  })

  const detail = message ? `\n\n${escapeMd(message)}` : ''

  return sendMd(
    chatId,
    arbiterIntro(`Join not completed\\.\n\nNo funds were locked\\.${detail}`),
    inlineKeyboard([
      [callbackButton('Try Again', 'joinbet:retry')],
      [callbackButton('Start', 'nav:start')],
    ])
  )
}

async function showJoinCancelledScreen(chatId, userId) {
  patchSession(userId, { state: STATES.JOIN_REVIEW })

  return sendMd(
    chatId,
    arbiterIntro(
      `Join cancelled\\.\n\nYou can accept this wager anytime before it closes\\.`
    ),
    inlineKeyboard([
      [callbackButton('Join Bet', 'joinbet:review:join')],
      [callbackButton('Start', 'nav:start')],
    ])
  )
}

async function handleJoinStatusCheck(chatId, userId) {
  const session = getSession(userId)
  const joinSessionId = session.join.joinSessionId

  if (!joinSessionId) {
    return sendMd(
      chatId,
      arbiterIntro('No join session is active\\.'),
      inlineKeyboard([
        [callbackButton('Start', 'nav:start')],
      ])
    )
  }

  try {
    const result = await fetchJoinSession(joinSessionId)
    const status = String(result.status || '').toUpperCase()

    patchSession(userId, {
      join: {
        status,
      },
    })

    if (status === 'CONFIRMED' || status === 'SUCCESS' || result.betStatus === 'ACTIVE') {
      return showJoinSuccessScreen(chatId, userId)
    }

    if (status === 'FAILED') {
      return showJoinFailedScreen(chatId, userId, result.message || '')
    }

    if (status === 'EXPIRED') {
      return sendMd(
        chatId,
        arbiterIntro(
          `This signing session has expired\\.\n\nPlease start again\\.`
        ),
        inlineKeyboard([
          [callbackButton('Join Bet', 'joinbet:review:join')],
          [callbackButton('Start', 'nav:start')],
        ])
      )
    }

    if (status === 'TAKEN' || status === 'ALREADY_JOINED') {
      clearJoinState(userId)
      return sendMd(
        chatId,
        arbiterIntro('This bet already has an opponent\\.'),
        inlineKeyboard([
          [callbackButton('Start', 'nav:start')],
          [callbackButton('My Bets', 'nav:mybets')],
        ])
      )
    }

    return showJoinStillPendingScreen(chatId, userId)
  } catch (err) {
    console.error('Join status check failed:', getErrorMessage(err))
    return sendMd(
      chatId,
      arbiterIntro(
        `Status check failed\\.\n\n${escapeMd(getErrorMessage(err))}`
      ),
      inlineKeyboard([
        [callbackButton('Check Status', 'joinbet:pending:check')],
        [callbackButton('Start', 'nav:start')],
      ])
    )
  }
}

async function createJoinSessionStep(chatId, userId, from) {
  const session = getSession(userId)
  const invite = session.join.invite

  if (!invite || !session.join.betId) {
    return sendMd(
      chatId,
      arbiterIntro('That bet is no longer loaded\\. Please open the invite again\\.'),
      inlineKeyboard([
        [callbackButton('Start', 'nav:start')],
      ])
    )
  }

  try {
    await sendMd(chatId, arbiterIntro('Preparing secure signing link\\.'))

    const result = await createJoinSession({
      betId: session.join.betId,
      telegramUserId: userId,
      telegramUsername: from.username || '',
      telegramFirstName: from.first_name || '',
    })

    const signingUrl =
      result.signingUrl ||
      `${WEB_BASE_URL}/join/${encodeURIComponent(result.joinSessionId)}`

    patchSession(userId, {
      join: {
        joinSessionId: result.joinSessionId,
        signingUrl,
        status: 'PENDING',
      },
    })

    return showJoinHandoffScreen(chatId, userId)
  } catch (err) {
    console.error('Create join session failed:', getErrorMessage(err))
    return sendMd(
      chatId,
      arbiterIntro(
        `This bet could not be prepared for joining\\.\n\n${escapeMd(getErrorMessage(err))}`
      ),
      inlineKeyboard([
        [callbackButton('Back', 'joinbet:confirm:back')],
        [callbackButton('Start', 'nav:start')],
      ])
    )
  }
}

/* -------------------------------------------------------------------------- */
/*                           COMMAND + TEXT HANDLERS                          */
/* -------------------------------------------------------------------------- */

bot.onText(/^\/start(?:\s+(.+))?$/i, async (msg, match) => {
  const userId = String(msg.from.id)
  const payload = (match && match[1] ? String(match[1]).trim() : '') || ''

  saveUserProfile(userId, {
    username: msg.from.username || null,
    firstName: msg.from.first_name || null,
  })

  if (payload && (/^BET[_-]/i.test(payload))) {
    return startJoinFlow(msg.chat.id, userId, msg.from, payload)
  }

  await showMainMenu(msg.chat.id)
})

bot.onText(/^\/mybets$/i, async (msg) => {
  try {
    await sendMyBetsScreen(bot, msg.chat.id, msg.from.id)
  } catch (err) {
    console.error('mybets error:', err)
    await bot.sendMessage(msg.chat.id, 'Failed to load your bets.')
  }
})

bot.onText(/^\/settings$/i, async (msg) => {
  const userId = String(msg.from.id)

  saveUserProfile(userId, {
    username: msg.from.username || null,
    firstName: msg.from.first_name || null,
  })

  await showSettingsMenu(msg.chat.id, userId)
})

bot.onText(/^\/createbet$/i, async (msg) => {
  await startCreateBet(msg.chat.id, String(msg.from.id), msg.from)
})

bot.onText(/^\/cancel$/i, async (msg) => {
  resetSession(String(msg.from.id))
  await sendMd(msg.chat.id, arbiterIntro('Flow cancelled\\.'))
})

bot.onText(/^\/mytimezone$/i, async (msg) => {
  const userId = String(msg.from.id)
  const profile = getUserProfile(userId)

  if (!profile.timezone) {
    await sendMd(
      msg.chat.id,
      arbiterIntro('You have not set a timezone yet\\. Please choose one\\.')
    )
    return showTimezoneStep(msg.chat.id, userId, 'settings')
  }

  await showSettingsMenu(msg.chat.id, userId)
})

bot.on('message', async (msg) => {
  try {
    if (!msg.text) return
    if (msg.text.startsWith('/')) return

    const userId = String(msg.from.id)
    const chatId = msg.chat.id
    const session = getSession(userId)
    const timezone = session.flow.timezone || getUserProfile(userId).timezone || DEFAULT_TIMEZONE

    if (session.state === STATES.AWAITING_BET_TEXT) {
      const betText = msg.text.trim()

      if (betText.length < 6) {
        await sendMd(chatId, arbiterIntro('Please make the wager text a little clearer\\.'))
        return
      }

      patchSession(userId, {
        flow: {
          originalBetText: betText,
        },
      })

      await sendMd(chatId, arbiterIntro('Reading wager text\\.'))

      try {
        const result = await classifyBet(betText)

        patchSession(userId, {
          flow: {
            cleanedBetText: result.cleanedBetText,
            classification: result.classification,
            explanation: result.explanation || '',
            settlementBasis: result.settlementBasis || '',
            decisionType: result.decisionType || 'EVENT_BASED',
            earliestCheckTimeHint: result.earliestCheckTimeHint || '',
            latestDecisionTimeHint: result.latestDecisionTimeHint || '',
            requiresResultExpectedBy: !!result.requiresResultExpectedBy,
            missingFields: Array.isArray(result.missingFields) ? result.missingFields : [],
          },
        })

        await showClassificationReview(chatId, userId)
      } catch (err) {
        console.error('Classification failed:', getErrorMessage(err))
        await sendMd(
          chatId,
          arbiterIntro(
            `I could not classify that wager\\.\n\n${escapeMd(getErrorMessage(err))}\n\nSend the bet text again or use /cancel\\.`
          )
        )
      }

      return
    }

    if (session.awaitingCustom?.kind === 'close_date') {
      const parsed = parseCustomDate(msg.text, timezone)
      if (!parsed) {
        await sendMd(chatId, arbiterIntro('Send date as *2026\\-04\\-25* or *25/04/2026*\\.'))
        return
      }

      patchSession(userId, {
        awaitingCustom: null,
        flow: { closeDateLocal: parsed },
      })

      return showCloseTimeStep(chatId, userId)
    }

    if (session.awaitingCustom?.kind === 'close_time') {
      const parsed = parseCustomTime(msg.text)
      if (!parsed) {
        await sendMd(chatId, arbiterIntro('Send close time as *6*, *18*, *18:30* or *24:00*\\.'))
        return
      }

      patchSession(userId, {
        awaitingCustom: null,
        flow: { closeTimeLocal: parsed },
      })

      if (needsResultExpectedBy(getSession(userId).flow.classification)) {
        return showResultDateStep(chatId, userId)
      }

      return createDraftStep(chatId, userId, msg.from)
    }

    if (session.awaitingCustom?.kind === 'result_date') {
      const parsed = parseCustomDate(msg.text, timezone)
      if (!parsed) {
        await sendMd(chatId, arbiterIntro('Send date as *2026\\-04\\-25* or *25/04/2026*\\.'))
        return
      }

      patchSession(userId, {
        awaitingCustom: null,
        flow: { resultDateLocal: parsed },
      })

      return showResultTimeStep(chatId, userId)
    }

    if (session.awaitingCustom?.kind === 'result_time') {
      const parsed = parseCustomTime(msg.text)
      if (!parsed) {
        await sendMd(chatId, arbiterIntro('Send result time as *6*, *18*, *18:30* or *24:00*\\.'))
        return
      }

      patchSession(userId, {
        awaitingCustom: null,
        flow: { resultTimeLocal: parsed },
      })

      return createDraftStep(chatId, userId, msg.from)
    }
  } catch (err) {
    console.error('Message handler error:', err)
  }
})

/* -------------------------------------------------------------------------- */
/*                              CALLBACK HANDLER                              */
/* -------------------------------------------------------------------------- */

bot.on('callback_query', async (query) => {
  try {
    const userId = String(query.from.id)
    const chatId = query.message.chat.id
    const from = query.from
    const data = query.data || ''
    const session = getSession(userId)

    if (data === 'nav:createbet') {
      await safeAnswerCallback(query, 'New bet')
      return startCreateBet(chatId, userId, from)
    }

    if (data === 'nav:start') {
      await safeAnswerCallback(query, 'Start')
      return showMainMenu(chatId)
    }

    if (data === 'nav:settings') {
      await safeAnswerCallback(query, 'Settings')
      return showSettingsMenu(chatId, userId)
    }

    if (data === 'nav:timezone') {
      await safeAnswerCallback(query, 'Timezone')
      return showTimezoneStep(chatId, userId, 'settings')
    }

    if (data === 'nav:howto') {
      await safeAnswerCallback(query, 'How it works')
      return showHowItWorksMenu(chatId)
    }

    if (data === 'mybets_refresh' || data.startsWith('mybets_refresh_') || data.startsWith('mybets_filter_')) {
      await safeAnswerCallback(query, 'Refreshing')
      try {
        return await refreshMyBetsScreen(bot, query)
      } catch (err) {
        console.error('mybets_refresh error:', err)
        return bot.sendMessage(chatId, 'Could not refresh My Bets.')
      }
    }

    if (data.startsWith('mybets_open_')) {
      await safeAnswerCallback(query, 'Opening bet')
      try {
        return await handleMyBetsOpen(bot, query)
      } catch (err) {
        console.error('mybets_open error:', err)
        return bot.sendMessage(chatId, 'Could not open bet.')
      }
    }

    if (data === 'nav:mybets') {
      await safeAnswerCallback(query, 'My Bets')
      try {
        return await sendMyBetsScreen(bot, chatId, userId)
      } catch (err) {
        console.error('nav:mybets error:', err)
        return bot.sendMessage(chatId, 'Failed to load your bets.')
      }
    }

    if (data === 'joinbet:review:join') {
      await safeAnswerCallback(query, 'Join bet')
      return showJoinConfirmScreen(chatId, userId)
    }

    if (data === 'joinbet:confirm:back') {
      await safeAnswerCallback(query, 'Back')
      return showJoinInviteScreen(chatId, userId)
    }

    if (data === 'joinbet:confirm:continue') {
      await safeAnswerCallback(query, 'Continue')
      return createJoinSessionStep(chatId, userId, from)
    }

    if (data === 'joinbet:handoff:cancel') {
      await safeAnswerCallback(query, 'Cancelled')
      return showJoinCancelledScreen(chatId, userId)
    }

    if (data === 'joinbet:pending:cancel') {
      await safeAnswerCallback(query, 'Cancelled')
      return showJoinCancelledScreen(chatId, userId)
    }

    if (data === 'joinbet:pending:check') {
      await safeAnswerCallback(query, 'Checking status')
      return handleJoinStatusCheck(chatId, userId)
    }

    if (data === 'joinbet:retry') {
      await safeAnswerCallback(query, 'Try again')
      return showJoinConfirmScreen(chatId, userId)
    }

    if (!data.startsWith('createbet:')) {
      await safeAnswerCallback(query, 'Unhandled action')
      return
    }

    const parts = data.split(':')
    const action = parts[1]
    const value = parts.slice(2).join(':')

    if (action === 'cancel') {
      resetSession(userId)
      await safeAnswerCallback(query, 'Cancelled')
      await sendMd(chatId, arbiterIntro('Flow cancelled\\.'))
      return
    }

    if (action === 'classify' && value === 'confirm') {
      await safeAnswerCallback(query, 'Confirmed')
      return showStakeStep(chatId, userId)
    }

    if (action === 'classify' && value === 'edit') {
      patchSession(userId, {
        state: STATES.AWAITING_BET_TEXT,
        flow: {
          cleanedBetText: null,
          classification: null,
          explanation: null,
          settlementBasis: null,
          decisionType: null,
          earliestCheckTimeHint: null,
          latestDecisionTimeHint: null,
          requiresResultExpectedBy: false,
          missingFields: [],
        },
      })
      await safeAnswerCallback(query, 'Edit your bet')
      await sendMd(chatId, arbiterIntro('Send the revised wager text\\.'))
      return
    }

    if (action === 'stake') {
      patchSession(userId, {
        flow: { stake: value },
      })
      await safeAnswerCallback(query, `Stake ${value}`)
      return maybeShowTimezoneStep(chatId, userId)
    }

    if (action === 'timezone') {
      saveUserProfile(userId, {
        timezone: value,
        username: from.username || null,
        firstName: from.first_name || null,
      })

      patchSession(userId, {
        flow: { timezone: value },
      })

      await safeAnswerCallback(query, 'Timezone saved')

      if (session.timezoneMode === 'settings') {
        patchSession(userId, {
          state: STATES.IDLE,
          timezoneMode: null,
        })
        return showSettingsMenu(chatId, userId)
      }

      patchSession(userId, {
        timezoneMode: null,
      })
      return showCloseDateStep(chatId, userId)
    }

    if (action === 'close_date') {
      const timezone = session.flow.timezone || getUserProfile(userId).timezone || DEFAULT_TIMEZONE

      if (value === 'custom') {
        patchSession(userId, {
          state: STATES.AWAITING_CLOSE_DATE,
          awaitingCustom: { kind: 'close_date' },
        })
        await safeAnswerCallback(query, 'Send custom date')
        await sendMd(chatId, arbiterIntro('Send close date as *YYYY\\-MM\\-DD* or *DD/MM/YYYY*\\.'))
        return
      }

      const date = localDateFromChoice(value, timezone)

      patchSession(userId, {
        flow: { closeDateLocal: date },
      })

      await safeAnswerCallback(query, 'Close date set')
      return showCloseTimeStep(chatId, userId)
    }

    if (action === 'close_time') {
      if (value === 'custom') {
        patchSession(userId, {
          state: STATES.AWAITING_CLOSE_TIME,
          awaitingCustom: { kind: 'close_time' },
        })
        await safeAnswerCallback(query, 'Send custom time')
        await sendMd(chatId, arbiterIntro('Send close time as *6*, *18*, *18:30* or *24:00*\\.'))
        return
      }

      patchSession(userId, {
        flow: { closeTimeLocal: value },
      })

      await safeAnswerCallback(query, 'Close time set')

      if (needsResultExpectedBy(getSession(userId).flow.classification)) {
        return showResultDateStep(chatId, userId)
      }

      return createDraftStep(chatId, userId, from)
    }

    if (action === 'result_date') {
      const timezone = session.flow.timezone || getUserProfile(userId).timezone || DEFAULT_TIMEZONE

      if (value === 'custom') {
        patchSession(userId, {
          state: STATES.AWAITING_RESULT_DATE,
          awaitingCustom: { kind: 'result_date' },
        })
        await safeAnswerCallback(query, 'Send custom date')
        await sendMd(chatId, arbiterIntro('Send result date as *YYYY\\-MM\\-DD* or *DD/MM/YYYY*\\.'))
        return
      }

      const date = localDateFromChoice(value, timezone)

      patchSession(userId, {
        flow: { resultDateLocal: date },
      })

      await safeAnswerCallback(query, 'Result date set')
      return showResultTimeStep(chatId, userId)
    }

    if (action === 'result_time') {
      if (value === 'custom') {
        patchSession(userId, {
          state: STATES.AWAITING_RESULT_TIME,
          awaitingCustom: { kind: 'result_time' },
        })
        await safeAnswerCallback(query, 'Send custom time')
        await sendMd(chatId, arbiterIntro('Send result time as *6*, *18*, *18:30* or *24:00*\\.'))
        return
      }

      patchSession(userId, {
        flow: { resultTimeLocal: value },
      })

      await safeAnswerCallback(query, 'Result time set')
      return createDraftStep(chatId, userId, from)
    }

    await safeAnswerCallback(query, 'Unhandled action')
  } catch (err) {
    console.error('Callback handler error:', err)
    try {
      await bot.answerCallbackQuery(query.id, { text: 'Something went wrong' })
    } catch (_) {}
  }
})

/* -------------------------------------------------------------------------- */
/*                                  HELPERS                                   */
/* -------------------------------------------------------------------------- */

function getErrorMessage(err) {
  if (err.response?.data) {
    if (typeof err.response.data === 'string') return err.response.data
    if (err.response.data.error) return err.response.data.error
    return JSON.stringify(err.response.data)
  }
  return err.message || 'Unknown error'
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err)
})

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
})