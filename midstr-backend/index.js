import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import OpenAI from "openai";
import { ethers } from "ethers";
import { fileURLToPath } from "url";
import myBetsRoutes from "./myBetsRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();

const PORT = process.env.PORT || 3001;
const WEB_BASE_URL = process.env.WEB_BASE_URL || "http://localhost:3000";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const DATA_DIR = path.join(__dirname, "data");
const DRAFTS_FILE = path.join(DATA_DIR, "drafts.json");
const JOINS_FILE = path.join(DATA_DIR, "joinSessions.json");

const RESOLUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const RESOLUTION_TYPES = {
  VERIFIABLE: 0,
  AMBIGUOUS: 1,
  MANUAL_ONLY: 2,
};

const CHAIN_STATUS = {
  0: "NONE",
  1: "CREATED",
  2: "LIVE",
  3: "CLOSED",
  4: "WAITING_RESULT",
  5: "RESOLUTION_WINDOW_OPEN",
  6: "DISPUTED",
  7: "FINALISED",
  8: "SETTLED",
  9: "CANCELLED",
};

const SIDE_LABELS = {
  0: "None",
  1: "Creator",
  2: "Taker",
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(
  cors({
    origin: true,
  })
);

app.use(express.json());

/* -------------------------------------------------------------------------- */
/*                                  HELPERS                                   */
/* -------------------------------------------------------------------------- */

function buildDraftId() {
  return `DRAFT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function buildJoinSessionId() {
  return `JOIN-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function isValidIso(iso) {
  return typeof iso === "string" && !Number.isNaN(Date.parse(iso));
}

function parseIso(iso) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function isoFromUnixSeconds(value) {
  const n = Number(value || 0);
  if (!n) return null;
  return new Date(n * 1000).toISOString();
}

function unixSecondsFromIso(iso) {
  const ms = parseIso(iso);
  if (!ms) return 0;
  return Math.floor(ms / 1000);
}

function looksClearlyVerifiable(text) {
  const t = String(text || "").toLowerCase();

  const priceTarget =
    /\b(btc|bitcoin|eth|ethereum|sol|solana|gold|nasdaq|s&p|sp500)\b/.test(t) &&
    /\b(hit|hits|reach|reaches|above|below|over|under|at least|at or above|at or below|close above|close below)\b/.test(
      t
    );

  const matchOutcome =
    /\b(vs|versus|against|beat|beats|defeat|defeats|draw|draws|lose|loses|win|wins)\b/.test(
      t
    ) &&
    /\b(match|game|fixture|final|semi-final|semifinal)\b/.test(t);

  const leagueOutcome =
    /\b(win|wins|winner|champion|champions)\b/.test(t) &&
    /\b(league|premier league|champions league|world cup|nba|nfl|mlb|cup|tournament|title|season)\b/.test(
      t
    );

  return priceTarget || matchOutcome || leagueOutcome;
}

function normalizeUsername(username) {
  return String(username || "").replace(/^@/, "").trim();
}

function normalizeStake(stake) {
  if (stake === null || stake === undefined || stake === "") return null;
  const n = Number(stake);
  if (Number.isNaN(n) || n <= 0) return null;
  return String(n);
}

function normalizeTokenAmount(value, fallback = "0") {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) return fallback;
  return String(n);
}

function challengeBondForStake(stake) {
  const n = Number(stake || 0);
  if (Number.isNaN(n) || n <= 0) return "0";
  return String(n * 0.5);
}

function deriveBetIdFromDraftId(draftId) {
  const suffix = String(draftId || "").replace(/^DRAFT[-_]?/i, "");
  return `BET-${suffix}`;
}

function deriveDraftIdCandidates(inputId) {
  const raw = String(inputId || "").trim();

  if (!raw) return [];

  const suffix = raw.replace(/^(BET|DRAFT)[-_]?/i, "");
  const candidates = [
    raw,
    `DRAFT-${suffix}`,
    `DRAFT_${suffix}`,
    `BET-${suffix}`,
    `BET_${suffix}`,
  ];

  return [...new Set(candidates)];
}

function normaliseClassification(value) {
  return String(value || "").trim().toUpperCase();
}

function manualOnlyWarning(classification) {
  const c = normaliseClassification(classification);

  if (c !== "MANUAL_ONLY") return "";

  return [
    "Manual Only warning:",
    "Only invite people you trust.",
    "Manual Only bets may fail to resolve fairly.",
    "Dishonest users may refuse to concede.",
  ].join(" ");
}

function resolutionWarningForClassification(classification) {
  const c = normaliseClassification(classification);

  if (c === "MANUAL_ONLY") {
    return manualOnlyWarning(c);
  }

  if (c === "AMBIGUOUS") {
    return "Ambiguous bet warning: AI can suggest an outcome, but the loser may challenge by posting a bond.";
  }

  return "Verifiable bet: AI proposes the result from public evidence. The loser can concede or challenge by posting a bond.";
}

function ensureDraftDefaults(draft) {
  if (!draft || typeof draft !== "object") return draft;

  const classification = normaliseClassification(draft.classification);
  const stake = normalizeStake(draft.stake) || "0";

  const defaultChallengeBond = challengeBondForStake(stake);
  const existingBondAmount = normalizeTokenAmount(draft.bondAmount, "0");

  const shouldHaveChallengeBond =
    classification === "VERIFIABLE" ||
    classification === "AMBIGUOUS" ||
    classification === "MANUAL_ONLY";

  const fixedBondAmount =
    shouldHaveChallengeBond && Number(existingBondAmount) <= 0
      ? defaultChallengeBond
      : existingBondAmount;

  const totalCreatorUpfront = normalizeTokenAmount(
    draft.totalCreatorUpfront,
    stake
  );
  const totalTakerUpfront = normalizeTokenAmount(
    draft.totalTakerUpfront,
    stake
  );

  return {
    ...draft,
    betId: draft.betId || deriveBetIdFromDraftId(draft.draftId),
    creatorFundingStatus: draft.creatorFundingStatus || "PENDING",
    creatorFundingTxHash: draft.creatorFundingTxHash || "",
    creatorCreateTxHash: draft.creatorCreateTxHash || "",
    creatorWallet: draft.creatorWallet || "",
    takerTelegramUserId: draft.takerTelegramUserId || "",
    takerTelegramUsername: draft.takerTelegramUsername || "",
    takerWallet: draft.takerWallet || "",
    takerFundingStatus: draft.takerFundingStatus || "",
    takerFundingTxHash: draft.takerFundingTxHash || "",
    onChainBetId:
      draft.onChainBetId === null || draft.onChainBetId === undefined
        ? null
        : Number(draft.onChainBetId),
    requiresBond: shouldHaveChallengeBond,
    bondAmount: fixedBondAmount,
    bondToken: draft.bondToken || "MIDSTR",
    bondMode: draft.bondMode || "CHALLENGE_ONLY",
    totalCreatorUpfront,
    totalTakerUpfront,
    resultExpectedBy: draft.resultExpectedBy || null,
    resolutionSuggestion: draft.resolutionSuggestion || null,
    resolutionSuggestionAt: draft.resolutionSuggestionAt || "",
    resolutionProposedTxHash: draft.resolutionProposedTxHash || "",
    disputeFinaliseTxHash: draft.disputeFinaliseTxHash || "",
    resolutionUpdatedAt: draft.resolutionUpdatedAt || "",
  };
}

function getRelatedJoinSessions(joinStore, draftOrBetId) {
  const targetBetId =
    typeof draftOrBetId === "string"
      ? draftOrBetId
      : draftOrBetId?.betId || deriveBetIdFromDraftId(draftOrBetId?.draftId);

  return ensureJoinStoreShape(joinStore).joinSessions.filter(
    (session) => String(session.betId || "") === String(targetBetId || "")
  );
}

function hasConfirmedJoinSession(joinStore, draft) {
  return getRelatedJoinSessions(joinStore, draft).some(
    (session) => String(session.status || "").toUpperCase() === "CONFIRMED"
  );
}

function getResolutionWindowInfo(draft) {
  const resultExpectedByMs = parseIso(draft?.resultExpectedBy || "");
  if (!resultExpectedByMs) {
    return {
      hasResultExpectedBy: false,
      resultExpectedBy: null,
      windowStart: null,
      windowEnd: null,
      windowOpen: false,
      windowExpired: false,
    };
  }

  const windowEndMs = resultExpectedByMs + RESOLUTION_WINDOW_MS;
  const now = Date.now();

  return {
    hasResultExpectedBy: true,
    resultExpectedBy: new Date(resultExpectedByMs).toISOString(),
    windowStart: new Date(resultExpectedByMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
    windowOpen: now >= resultExpectedByMs && now < windowEndMs,
    windowExpired: now >= windowEndMs,
  };
}

function deriveEffectiveBetStatus(draft, joinStore) {
  const safeDraft = ensureDraftDefaults(draft);
  const rawStatus = String(safeDraft.status || "").toUpperCase();
  const joined =
    safeDraft.takerWallet ||
    safeDraft.takerFundingTxHash ||
    String(safeDraft.takerFundingStatus || "").toUpperCase() === "FUNDED" ||
    hasConfirmedJoinSession(joinStore, safeDraft);

  if (["SETTLED", "RESOLVED", "FINALISED", "FINALIZED"].includes(rawStatus)) {
    return "RESOLVED";
  }

  if (rawStatus === "DISPUTED") {
    return "DISPUTED";
  }

  if (["CANCELLED", "EXPIRED"].includes(rawStatus)) {
    return rawStatus;
  }

  if (!joined) {
    if (rawStatus === "CREATED" || rawStatus === "AWAITING_TAKER") {
      return "CREATED";
    }
    return rawStatus || "CREATED";
  }

  const windowInfo = getResolutionWindowInfo(safeDraft);

  if (windowInfo.windowOpen || windowInfo.windowExpired) {
    if (safeDraft.resolutionSuggestion || safeDraft.resolutionProposedTxHash) {
      return "RESOLUTION_WINDOW";
    }

    return "WAITING_RESULT";
  }

  if (isValidIso(safeDraft.closeTime) && parseIso(safeDraft.closeTime) <= Date.now()) {
    return "CLOSED";
  }

  return "ACTIVE";
}

function getJoinableStatusLabel(draft, joinStore) {
  const effectiveStatus = deriveEffectiveBetStatus(draft, joinStore);

  if (effectiveStatus === "ACTIVE") return "Active";
  if (effectiveStatus === "CLOSED") return "Awaiting Result";
  if (effectiveStatus === "WAITING_RESULT") return "Awaiting Result";
  if (effectiveStatus === "RESOLUTION_WINDOW") return "Resolution Window";
  if (effectiveStatus === "DISPUTED") return "Disputed";
  if (effectiveStatus === "RESOLVED") return "Resolved";
  if (effectiveStatus === "CANCELLED") return "Cancelled";
  if (effectiveStatus === "EXPIRED") return "Expired";

  return "Awaiting opponent";
}

function isDraftJoinable(draft, joinStore) {
  const safeDraft = ensureDraftDefaults(draft);
  const effectiveStatus = deriveEffectiveBetStatus(safeDraft, joinStore);

  if (effectiveStatus === "ACTIVE") {
    return { joinable: false, reason: "This bet already has an opponent." };
  }

  if (
    effectiveStatus === "CANCELLED" ||
    effectiveStatus === "EXPIRED" ||
    effectiveStatus === "RESOLVED" ||
    String(safeDraft.status || "").toUpperCase() === "FINALISED" ||
    String(safeDraft.status || "").toUpperCase() === "FINALIZED"
  ) {
    return { joinable: false, reason: "This invite is no longer valid." };
  }

  if (!isValidIso(safeDraft.closeTime)) {
    return { joinable: false, reason: "This bet has no valid close time." };
  }

  if (parseIso(safeDraft.closeTime) <= Date.now()) {
    return { joinable: false, reason: "Betting has already closed for this wager." };
  }

  return { joinable: true, reason: "" };
}

function ensureDraftStoreShape(store) {
  if (!store || typeof store !== "object") return { drafts: [] };
  if (!Array.isArray(store.drafts)) return { drafts: [] };

  return {
    drafts: store.drafts.map(ensureDraftDefaults),
  };
}

function ensureJoinStoreShape(store) {
  if (!store || typeof store !== "object") return { joinSessions: [] };
  if (!Array.isArray(store.joinSessions)) return { joinSessions: [] };
  return store;
}

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(DRAFTS_FILE);
  } catch {
    await fs.writeFile(
      DRAFTS_FILE,
      JSON.stringify({ drafts: [] }, null, 2),
      "utf8"
    );
  }

  try {
    await fs.access(JOINS_FILE);
  } catch {
    await fs.writeFile(
      JOINS_FILE,
      JSON.stringify({ joinSessions: [] }, null, 2),
      "utf8"
    );
  }
}

async function readDraftStore() {
  await ensureDataFiles();
  const raw = await fs.readFile(DRAFTS_FILE, "utf8");
  return ensureDraftStoreShape(JSON.parse(raw));
}

async function writeDraftStore(store) {
  await ensureDataFiles();
  const safeStore = ensureDraftStoreShape(store);
  await fs.writeFile(DRAFTS_FILE, JSON.stringify(safeStore, null, 2), "utf8");
}

async function readJoinStore() {
  await ensureDataFiles();
  const raw = await fs.readFile(JOINS_FILE, "utf8");
  return ensureJoinStoreShape(JSON.parse(raw));
}

async function writeJoinStore(store) {
  await ensureDataFiles();
  const safeStore = ensureJoinStoreShape(store);
  await fs.writeFile(JOINS_FILE, JSON.stringify(safeStore, null, 2), "utf8");
}

function findDraftByBetId(store, betId) {
  const candidates = deriveDraftIdCandidates(betId);

  return store.drafts.find((draft) => {
    const draftId = String(draft.draftId || "");
    const derivedBetId = deriveBetIdFromDraftId(draftId);
    const explicitBetId = String(draft.betId || "");
    return (
      candidates.includes(draftId) ||
      candidates.includes(derivedBetId) ||
      candidates.includes(explicitBetId)
    );
  });
}

function getUserRoleForDraft(draft, telegramUserId) {
  const userId = String(telegramUserId || "");

  if (!userId) return "UNKNOWN";
  if (String(draft.telegramUserId || "") === userId) return "CREATOR";
  if (String(draft.takerTelegramUserId || "") === userId) return "TAKER";

  return "UNKNOWN";
}

function sideForRole(role) {
  if (role === "CREATOR") return 1;
  if (role === "TAKER") return 2;
  return 0;
}

function oppositeSide(side) {
  if (side === 1) return 2;
  if (side === 2) return 1;
  return 0;
}

function parseChainBet(raw) {
  if (!raw) return null;

  return {
    creatorWallet: raw.creatorWallet,
    takerWallet: raw.takerWallet,
    stake: raw.stake?.toString?.() || "0",
    resolutionType: Number(raw.resolutionType),
    status: Number(raw.status),
    statusName: CHAIN_STATUS[Number(raw.status)] || "UNKNOWN",
    closeTimeUtc: Number(raw.closeTimeUtc),
    closeTimeIso: isoFromUnixSeconds(raw.closeTimeUtc),
    resultExpectedByUtc: Number(raw.resultExpectedByUtc),
    resultExpectedByIso: isoFromUnixSeconds(raw.resultExpectedByUtc),
    proposalTimeUtc: Number(raw.proposalTimeUtc),
    proposalTimeIso: isoFromUnixSeconds(raw.proposalTimeUtc),
    finalisedAtUtc: Number(raw.finalisedAtUtc),
    finalisedAtIso: isoFromUnixSeconds(raw.finalisedAtUtc),
    proposedWinnerSide: Number(raw.proposedWinnerSide),
    proposedWinnerLabel: SIDE_LABELS[Number(raw.proposedWinnerSide)] || "Unknown",
    finalWinnerSide: Number(raw.finalWinnerSide),
    finalWinnerLabel: SIDE_LABELS[Number(raw.finalWinnerSide)] || "Unknown",
    challengerWallet: raw.challengerWallet,
    challengeBond: raw.challengeBond?.toString?.() || "0",
    challengeCorrect: Boolean(raw.challengeCorrect),
    creatorFunded: Boolean(raw.creatorFunded),
    takerFunded: Boolean(raw.takerFunded),
    settled: Boolean(raw.settled),
  };
}

function actionUrl(betId, action) {
  return `${WEB_BASE_URL}/resolve/${encodeURIComponent(betId)}?action=${encodeURIComponent(action)}`;
}

async function classifyBetWithAI(betText) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing in midstr-backend");
  }

  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: [
          "You are The Arbiter, the MIDSTR V1 wager classifier.",
          "Return JSON only using the provided schema.",
          "",
          "Classification rules:",
          "- VERIFIABLE = objective external outcome; resolvable from public market data, official match results, official competition winners, or equivalent external facts.",
          "- AMBIGUOUS = partly objective but not precise enough, or missing a decisive rule/result point.",
          "- MANUAL_ONLY = subjective, taste-based, opinion-based, or inherently not externally resolvable.",
          "",
          "Important locked MIDSTR rule:",
          "- Result Expected By is required for all classifications.",
          "- Result Expected By starts the global 7-day resolution response window.",
          "",
          "Very important:",
          "- BTC/crypto price target bets are usually VERIFIABLE.",
          "- Match winners and league/tournament winners are usually VERIFIABLE.",
          "- Do NOT mark a clearly objective wager as AMBIGUOUS merely because it is future-facing.",
          "",
          "Output brief, practical explanations.",
          "Clean the user's wager into a single clear sentence without changing meaning.",
        ].join("\n"),
      },
      {
        role: "user",
        content: `Classify this wager:\n\n${betText}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "midstr_bet_classification",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            cleanedBetText: { type: "string" },
            classification: {
              type: "string",
              enum: ["VERIFIABLE", "AMBIGUOUS", "MANUAL_ONLY"],
            },
            explanation: { type: "string" },
            settlementBasis: { type: "string" },
            decisionType: {
              type: "string",
              enum: ["EVENT_BASED", "TIME_BASED"],
            },
            earliestCheckTimeHint: { type: "string" },
            latestDecisionTimeHint: { type: "string" },
            missingFields: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: [
            "cleanedBetText",
            "classification",
            "explanation",
            "settlementBasis",
            "decisionType",
            "earliestCheckTimeHint",
            "latestDecisionTimeHint",
            "missingFields",
          ],
        },
      },
    },
  });

  const msg = response.choices?.[0]?.message;
  const parsed = JSON.parse(msg?.content || "{}");

  parsed.requiresResultExpectedBy = true;
  parsed.missingFields = Array.isArray(parsed.missingFields)
    ? parsed.missingFields
    : [];

  if (
    looksClearlyVerifiable(betText) &&
    parsed.classification !== "VERIFIABLE"
  ) {
    parsed.classification = "VERIFIABLE";
    parsed.explanation =
      "This wager appears objective and externally checkable from public data or official results.";
    parsed.settlementBasis =
      "Resolve using public market data or official competition/result data.";
    parsed.decisionType = "EVENT_BASED";
  }

  if (!parsed.missingFields.includes("resultExpectedBy")) {
    parsed.missingFields.unshift("resultExpectedBy");
  }

  return parsed;
}

/* -------------------------------------------------------------------------- */
/*                              CONTRACT HELPERS                              */
/* -------------------------------------------------------------------------- */

const ESCROW_V3_ABI = [
  "function proposeResultVerifiable(uint256 betId, uint8 winnerSide) external",
  "function finaliseDispute(uint256 betId, uint8 finalWinnerSide, bool challengeCorrect) external",
  "function refreshStatus(uint256 betId) external",
  "function arbiterResolver() view returns (address)",
  "function challengeBondAmount(uint256 betId) view returns (uint256)",
  "function callerRewardAmount(uint256 betId) view returns (uint256)",
  "function potAmount(uint256 betId) view returns (uint256)",
  "function canClaimWin(uint256 betId, address user) view returns (bool)",
  "function canConcede(uint256 betId, address user) view returns (bool)",
  "function canChallenge(uint256 betId, address user) view returns (bool)",
  "function canSettle(uint256 betId) view returns (bool)",
  "function canTimeoutResolve(uint256 betId) view returns (bool)",
  "function getWindowStart(uint256 betId) view returns (uint256)",
  "function bets(uint256) view returns (address creatorWallet,address takerWallet,uint256 stake,uint8 resolutionType,uint8 status,uint64 closeTimeUtc,uint64 resultExpectedByUtc,uint64 proposalTimeUtc,uint64 finalisedAtUtc,uint8 proposedWinnerSide,uint8 finalWinnerSide,address challengerWallet,uint256 challengeBond,bool challengeCorrect,bool creatorFunded,bool takerFunded,bool settled)",
];

function getProvider() {
  if (!process.env.SEPOLIA_RPC_URL) {
    throw new Error("SEPOLIA_RPC_URL missing");
  }

  return new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
}

function getReadContract() {
  if (!process.env.ESCROW_TOKEN_ADDRESS) {
    throw new Error("ESCROW_TOKEN_ADDRESS missing");
  }

  return new ethers.Contract(
    process.env.ESCROW_TOKEN_ADDRESS,
    ESCROW_V3_ABI,
    getProvider()
  );
}

function getResolverContract() {
  if (!process.env.ARBITER_RESOLVER_PRIVATE_KEY) {
    throw new Error("ARBITER_RESOLVER_PRIVATE_KEY missing");
  }

  if (!process.env.ESCROW_TOKEN_ADDRESS) {
    throw new Error("ESCROW_TOKEN_ADDRESS missing");
  }

  const wallet = new ethers.Wallet(
    process.env.ARBITER_RESOLVER_PRIVATE_KEY,
    getProvider()
  );

  return new ethers.Contract(
    process.env.ESCROW_TOKEN_ADDRESS,
    ESCROW_V3_ABI,
    wallet
  );
}

async function assertResolverSigner(contract) {
  const resolverAddress = await contract.arbiterResolver();
  const signerAddress = await contract.runner.getAddress();

  if (resolverAddress.toLowerCase() !== signerAddress.toLowerCase()) {
    const error = new Error("Backend signer is not the contract arbiterResolver");
    error.statusCode = 403;
    error.details = { resolverAddress, signerAddress };
    throw error;
  }

  return { resolverAddress, signerAddress };
}

async function readChainResolutionState(onChainBetId, userWallet = "") {
  if (onChainBetId === null || onChainBetId === undefined || onChainBetId === "") {
    return null;
  }

  const contract = getReadContract();
  const id = BigInt(onChainBetId);

  const [
    rawBet,
    challengeBondAmount,
    callerRewardAmount,
    potAmount,
    windowStart,
    canSettle,
    canTimeoutResolve,
  ] = await Promise.all([
    contract.bets(id),
    contract.challengeBondAmount(id).catch(() => 0n),
    contract.callerRewardAmount(id).catch(() => 0n),
    contract.potAmount(id).catch(() => 0n),
    contract.getWindowStart(id).catch(() => 0n),
    contract.canSettle(id).catch(() => false),
    contract.canTimeoutResolve(id).catch(() => false),
  ]);

  const chainBet = parseChainBet(rawBet);

  let userActions = {
    canClaimWin: false,
    canConcede: false,
    canChallenge: false,
  };

  if (userWallet && ethers.isAddress(userWallet)) {
    const [canClaimWin, canConcede, canChallenge] = await Promise.all([
      contract.canClaimWin(id, userWallet).catch(() => false),
      contract.canConcede(id, userWallet).catch(() => false),
      contract.canChallenge(id, userWallet).catch(() => false),
    ]);

    userActions = {
      canClaimWin: Boolean(canClaimWin),
      canConcede: Boolean(canConcede),
      canChallenge: Boolean(canChallenge),
    };
  }

  return {
    ...chainBet,
    contractAddress: process.env.ESCROW_TOKEN_ADDRESS,
    challengeBondAmount: challengeBondAmount.toString(),
    callerRewardAmount: callerRewardAmount.toString(),
    potAmount: potAmount.toString(),
    windowStartUtc: Number(windowStart),
    windowStartIso: isoFromUnixSeconds(windowStart),
    canSettle: Boolean(canSettle),
    canTimeoutResolve: Boolean(canTimeoutResolve),
    userActions,
  };
}

async function syncDraftFromChain(draft, chainState) {
  if (!draft || !chainState) return draft;

  const chainStatus = chainState.statusName;
  const now = nowIso();

  if (chainStatus === "DISPUTED") {
    draft.status = "DISPUTED";
  } else if (chainStatus === "FINALISED") {
    draft.status = "FINALISED";
  } else if (chainStatus === "SETTLED") {
    draft.status = "RESOLVED";
  } else if (chainStatus === "RESOLUTION_WINDOW_OPEN") {
    draft.status = "RESOLUTION_WINDOW";
  } else if (chainStatus === "WAITING_RESULT") {
    draft.status = "WAITING_RESULT";
  } else if (chainStatus === "CLOSED") {
    draft.status = "CLOSED";
  }

  draft.chainStatus = chainStatus;
  draft.chainProposedWinnerSide = chainState.proposedWinnerSide;
  draft.chainFinalWinnerSide = chainState.finalWinnerSide;
  draft.chainChallengeBond = chainState.challengeBond;
  draft.chainChallengeCorrect = chainState.challengeCorrect;
  draft.chainSettled = chainState.settled;
  draft.resolutionUpdatedAt = now;
  draft.updatedAt = now;

  return draft;
}

async function buildResolutionStatusPayload(draft, telegramUserId = "") {
  const joinStore = await readJoinStore();
  const effectiveStatus = deriveEffectiveBetStatus(draft, joinStore);
  const role = getUserRoleForDraft(draft, telegramUserId);
  const userWallet = role === "CREATOR" ? draft.creatorWallet : role === "TAKER" ? draft.takerWallet : "";
  const chainState = await readChainResolutionState(draft.onChainBetId, userWallet).catch((err) => {
    console.warn("[resolution-status] chain read failed:", err.message);
    return null;
  });

  const windowInfo = getResolutionWindowInfo(draft);
  const userSide = sideForRole(role);
  const proposedWinnerSide =
    chainState?.proposedWinnerSide ||
    Number(draft.resolutionSuggestion?.winnerSide || 0);

  const proposedLoserSide = proposedWinnerSide ? oppositeSide(proposedWinnerSide) : 0;

  const actions = {
    claimWin: {
      visible:
        role !== "UNKNOWN" &&
        draft.classification !== "VERIFIABLE" &&
        !proposedWinnerSide &&
        (chainState?.userActions?.canClaimWin || windowInfo.windowOpen),
      url: actionUrl(draft.betId, "claim"),
    },
    concede: {
      visible:
        role !== "UNKNOWN" &&
        proposedWinnerSide > 0 &&
        userSide === proposedLoserSide &&
        (chainState?.userActions?.canConcede || windowInfo.windowOpen),
      url: actionUrl(draft.betId, "concede"),
    },
    challenge: {
      visible:
        role !== "UNKNOWN" &&
        proposedWinnerSide > 0 &&
        userSide === proposedLoserSide &&
        (chainState?.userActions?.canChallenge || windowInfo.windowOpen),
      url: actionUrl(draft.betId, "challenge"),
    },
    settle: {
      visible: Boolean(chainState?.canSettle),
      url: actionUrl(draft.betId, "settle"),
    },
    timeoutResolve: {
      visible: Boolean(chainState?.canTimeoutResolve || (windowInfo.windowExpired && !proposedWinnerSide)),
      url: actionUrl(draft.betId, "timeout"),
    },
    checkStatus: {
      visible: true,
    },
  };

  return {
    ok: true,
    betId: draft.betId,
    draftId: draft.draftId,
    onChainBetId: draft.onChainBetId ?? null,
    role,
    userWallet,
    status: effectiveStatus,
    statusLabel: getJoinableStatusLabel(draft, joinStore),
    classification: draft.classification,
    warning: resolutionWarningForClassification(draft.classification),
    manualOnlyWarning: manualOnlyWarning(draft.classification),
    cleanedBetText: draft.cleanedBetText,
    stake: draft.stake,
    tokenSymbol: "MIDSTR",
    resultExpectedBy: draft.resultExpectedBy,
    window: windowInfo,
    suggestion: draft.resolutionSuggestion || null,
    suggestionAt: draft.resolutionSuggestionAt || "",
    proposedWinnerSide,
    proposedWinnerLabel: SIDE_LABELS[proposedWinnerSide] || "None",
    challengeBondAmount:
      chainState?.challengeBondAmount ||
      ethers.parseUnits(challengeBondForStake(draft.stake), 18).toString(),
    bondToken: "MIDSTR",
    chain: chainState,
    actions,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   ROUTES                                   */
/* -------------------------------------------------------------------------- */

app.get("/health", async (_req, res) => {
  res.json({
    ok: true,
    service: "midstr-backend",
    port: PORT,
    webBaseUrl: WEB_BASE_URL,
    escrowTokenAddress: process.env.ESCROW_TOKEN_ADDRESS || "",
  });
});

app.post("/ai/classify-bet", async (req, res) => {
  try {
    const betText = String(
      req.body?.betText || req.body?.rawBetText || ""
    ).trim();

    if (!betText) {
      return res.status(400).json({
        ok: false,
        error: "betText is required",
      });
    }

    const result = await classifyBetWithAI(betText);

    return res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error("classify-bet failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Classification failed",
    });
  }
});

app.post("/drafts", async (req, res) => {
  try {
    const {
      telegramUserId,
      telegramUsername,
      originalBetText,
      cleanedBetText,
      classification,
      explanation,
      settlementBasis,
      decisionType,
      closeTime,
      resultExpectedBy,
      earliestCheckTimeHint,
      latestDecisionTimeHint,
      timezone,
      stake,
      requiresBond,
      bondAmount,
      bondToken,
      bondMode,
      totalCreatorUpfront,
      totalTakerUpfront,
    } = req.body || {};

    if (!telegramUserId) {
      return res.status(400).json({
        ok: false,
        error: "telegramUserId is required",
      });
    }

    if (!cleanedBetText || !classification || !closeTime) {
      return res.status(400).json({
        ok: false,
        error: "cleanedBetText, classification, and closeTime are required",
      });
    }

    if (!isValidIso(closeTime)) {
      return res.status(400).json({
        ok: false,
        error: "closeTime must be a valid ISO timestamp",
      });
    }

    if (!resultExpectedBy || !isValidIso(resultExpectedBy)) {
      return res.status(400).json({
        ok: false,
        error:
          "resultExpectedBy is required for all bet types because it starts the 7-day resolution clock",
      });
    }

    if (parseIso(resultExpectedBy) <= parseIso(closeTime)) {
      return res.status(400).json({
        ok: false,
        error: "resultExpectedBy must be after closeTime",
      });
    }

    const normalizedStake = normalizeStake(stake);
    if (!normalizedStake) {
      return res.status(400).json({
        ok: false,
        error: "stake is required and must be a positive number",
      });
    }

    const upperClassification = normaliseClassification(classification);

    if (!Object.prototype.hasOwnProperty.call(RESOLUTION_TYPES, upperClassification)) {
      return res.status(400).json({
        ok: false,
        error: "classification must be VERIFIABLE, AMBIGUOUS, or MANUAL_ONLY",
      });
    }

    const normalizedBondAmount =
      Number(normalizeTokenAmount(bondAmount, "0")) > 0
        ? normalizeTokenAmount(bondAmount, "0")
        : challengeBondForStake(normalizedStake);

    const normalizedBondMode = bondMode || "CHALLENGE_ONLY";
    const normalizedBondToken = bondToken || "MIDSTR";

    const store = await readDraftStore();

    const createdAt = nowIso();
    const draftId = buildDraftId();
    const betId = deriveBetIdFromDraftId(draftId);

    const draft = ensureDraftDefaults({
      draftId,
      betId,
      status: "CREATED",
      createdAt,
      updatedAt: createdAt,
      telegramUserId: String(telegramUserId),
      telegramUsername: normalizeUsername(telegramUsername),
      timezone: timezone || "UTC",
      originalBetText: originalBetText || cleanedBetText,
      cleanedBetText,
      classification: upperClassification,
      explanation: explanation || "",
      settlementBasis: settlementBasis || "",
      decisionType: decisionType || "EVENT_BASED",
      stake: normalizedStake,
      closeTime,
      resultExpectedBy,
      earliestCheckTimeHint: earliestCheckTimeHint || "",
      latestDecisionTimeHint: latestDecisionTimeHint || "",
      creatorFundingStatus: "PENDING",
      creatorFundingTxHash: "",
      creatorCreateTxHash: "",
      creatorWallet: "",
      takerTelegramUserId: "",
      takerTelegramUsername: "",
      takerWallet: "",
      takerFundingStatus: "",
      takerFundingTxHash: "",
      requiresBond: true,
      bondAmount: normalizedBondAmount,
      bondToken: normalizedBondToken,
      bondMode: normalizedBondMode,
      totalCreatorUpfront: normalizeTokenAmount(
        totalCreatorUpfront,
        normalizedStake
      ),
      totalTakerUpfront: normalizeTokenAmount(
        totalTakerUpfront,
        normalizedStake
      ),
      resolutionWarning: resolutionWarningForClassification(upperClassification),
    });

    store.drafts.unshift(draft);
    await writeDraftStore(store);

    return res.json({
      ok: true,
      draft,
      signingUrl: `${WEB_BASE_URL}/sign?draftId=${draftId}`,
      inviteBetId: betId,
      warning: resolutionWarningForClassification(upperClassification),
    });
  } catch (error) {
    console.error("draft creation failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Draft creation failed",
    });
  }
});

app.get("/drafts/:draftId", async (req, res) => {
  try {
    const { draftId } = req.params;
    const store = await readDraftStore();
    const draft = store.drafts.find((d) => d.draftId === draftId);

    if (!draft) {
      return res.status(404).json({
        ok: false,
        error: "Draft not found",
      });
    }

    return res.json({
      ok: true,
      draft,
      signingUrl: `${WEB_BASE_URL}/sign?draftId=${draft.draftId}`,
      warning: resolutionWarningForClassification(draft.classification),
    });
  } catch (error) {
    console.error("draft lookup failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Draft lookup failed",
    });
  }
});

/* -------------------------------------------------------------------------- */
/*                               JOIN ENDPOINTS                               */
/* -------------------------------------------------------------------------- */

app.get("/bets/:betId", async (req, res) => {
  try {
    const { betId } = req.params;
    const telegramUserId = String(req.query?.telegramUserId || "").trim();

    const draftStore = await readDraftStore();
    const joinStore = await readJoinStore();
    const draft = findDraftByBetId(draftStore, betId);

    if (!draft) {
      return res.status(404).json({
        ok: false,
        error: "Bet not found",
      });
    }

    const effectiveStatus = deriveEffectiveBetStatus(draft, joinStore);
    const joinableInfo = isDraftJoinable(draft, joinStore);

    return res.json({
      ok: true,
      bet: {
        betId: draft.betId || deriveBetIdFromDraftId(draft.draftId),
        draftId: draft.draftId,
        joinable: joinableInfo.joinable,
        invalidReason: joinableInfo.reason,
        creatorTelegramId: draft.telegramUserId,
        creatorTelegramUsername: draft.telegramUsername || "",
        creatorFirstName: "",
        creatorDisplayName: draft.telegramUsername
          ? `@${draft.telegramUsername}`
          : `User ${draft.telegramUserId}`,
        cleanedBetText: draft.cleanedBetText,
        stake: draft.stake,
        classification: draft.classification,
        closeTimeUtc: draft.closeTime,
        resultExpectedByUtc: draft.resultExpectedBy,
        status: effectiveStatus,
        statusLabel: getJoinableStatusLabel(draft, joinStore),
        openedByCreator:
          telegramUserId && String(draft.telegramUserId) === telegramUserId,
        onChainBetId: draft.onChainBetId ?? null,
        creatorWallet: draft.creatorWallet || "",
        takerWallet: draft.takerWallet || "",
        creatorFundingStatus: draft.creatorFundingStatus || "",
        takerFundingStatus: draft.takerFundingStatus || "",
        requiresBond: Boolean(draft.requiresBond),
        bondAmount: draft.bondAmount || challengeBondForStake(draft.stake),
        bondToken: draft.bondToken || "MIDSTR",
        bondMode: draft.bondMode || "CHALLENGE_ONLY",
        totalCreatorUpfront: draft.totalCreatorUpfront || draft.stake || "0",
        totalTakerUpfront: draft.totalTakerUpfront || draft.stake || "0",
        warning: resolutionWarningForClassification(draft.classification),
      },
    });
  } catch (error) {
    console.error("bet lookup failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Bet lookup failed",
    });
  }
});

app.post("/bets/:betId/create-join-session", async (req, res) => {
  try {
    const { betId } = req.params;
    const {
      telegramUserId,
      telegramUsername,
      telegramFirstName,
    } = req.body || {};

    console.log("[create-join-session] start", {
      betId,
      telegramUserId: String(telegramUserId || ""),
      telegramUsername: telegramUsername || "",
    });

    if (!telegramUserId) {
      return res.status(400).json({
        ok: false,
        error: "telegramUserId is required",
      });
    }

    const draftStore = await readDraftStore();
    const joinStore = await readJoinStore();

    const draft = findDraftByBetId(draftStore, betId);

    if (!draft) {
      console.log("[create-join-session] bet not found", { betId });
      return res.status(404).json({
        ok: false,
        error: "Bet not found",
      });
    }

    if (String(draft.telegramUserId) === String(telegramUserId)) {
      console.log("[create-join-session] creator tried to join own bet", {
        betId,
        telegramUserId: String(telegramUserId),
      });
      return res.status(400).json({
        ok: false,
        error: "You created this bet. Share it with your opponent instead.",
      });
    }

    const joinableInfo = isDraftJoinable(draft, joinStore);
    if (!joinableInfo.joinable) {
      console.log("[create-join-session] bet not joinable", {
        betId,
        reason: joinableInfo.reason || "",
      });
      return res.status(400).json({
        ok: false,
        error: joinableInfo.reason || "This bet cannot be joined.",
      });
    }

    const targetBetId =
      draft.betId || deriveBetIdFromDraftId(draft.draftId);

    const incomingTelegramUserId = String(telegramUserId || "");

    const relatedSessions = joinStore.joinSessions.filter(
      (s) => String(s.betId) === String(targetBetId)
    );

    for (const session of relatedSessions) {
      const sessionStatus = String(session.status || "").toUpperCase();

      if (
        sessionStatus === "PENDING" &&
        isValidIso(session.expiresAt) &&
        parseIso(session.expiresAt) <= Date.now()
      ) {
        session.status = "EXPIRED";
        session.updatedAt = nowIso();
      }
    }

    await writeJoinStore(joinStore);

    const freshRelatedSessions = joinStore.joinSessions.filter(
      (s) => String(s.betId) === String(targetBetId)
    );

    const sameUserPending = freshRelatedSessions.find((s) => {
      return (
        String(s.status || "").toUpperCase() === "PENDING" &&
        String(s.telegramUserId || "") === incomingTelegramUserId
      );
    });

    if (sameUserPending) {
      console.log("[create-join-session] reusing same-user pending session", {
        betId: targetBetId,
        joinSessionId: sameUserPending.joinSessionId,
        telegramUserId: incomingTelegramUserId,
      });

      return res.json({
        ok: true,
        joinSessionId: sameUserPending.joinSessionId,
        signingUrl: sameUserPending.signingUrl,
        reused: true,
        warning: resolutionWarningForClassification(draft.classification),
      });
    }

    const otherUserPending = freshRelatedSessions.find((s) => {
      return (
        String(s.status || "").toUpperCase() === "PENDING" &&
        String(s.telegramUserId || "") !== incomingTelegramUserId
      );
    });

    if (otherUserPending) {
      console.log("[create-join-session] other user already has pending session", {
        betId: targetBetId,
        joinSessionId: otherUserPending.joinSessionId,
        existingTelegramUserId: String(otherUserPending.telegramUserId || ""),
        incomingTelegramUserId,
      });

      return res.status(400).json({
        ok: false,
        error: "This bet is already being joined by another user.",
      });
    }

    const confirmedSession = freshRelatedSessions.find((s) => {
      return String(s.status || "").toUpperCase() === "CONFIRMED";
    });

    if (confirmedSession) {
      console.log("[create-join-session] bet already confirmed", {
        betId: targetBetId,
        joinSessionId: confirmedSession.joinSessionId,
      });

      return res.status(400).json({
        ok: false,
        error: "This bet already has an opponent.",
      });
    }

    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const joinSessionId = buildJoinSessionId();

    const joinSession = {
      joinSessionId,
      betId: targetBetId,
      draftId: draft.draftId,
      status: "PENDING",
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      telegramUserId: incomingTelegramUserId,
      telegramUsername: normalizeUsername(telegramUsername),
      telegramFirstName: telegramFirstName || "",
      expectedStake: draft.stake,
      expectedBondAmount: draft.bondAmount || challengeBondForStake(draft.stake),
      expectedTotalUpfront: draft.totalTakerUpfront || draft.stake,
      onChainBetId: draft.onChainBetId ?? null,
      creatorWallet: draft.creatorWallet || "",
      signingUrl: `${WEB_BASE_URL}/join/${joinSessionId}`,
    };

    joinStore.joinSessions.unshift(joinSession);
    await writeJoinStore(joinStore);

    console.log("[create-join-session] created", {
      betId: targetBetId,
      joinSessionId,
      signingUrl: joinSession.signingUrl,
      telegramUserId: incomingTelegramUserId,
    });

    return res.json({
      ok: true,
      joinSessionId,
      signingUrl: joinSession.signingUrl,
      reused: false,
      warning: resolutionWarningForClassification(draft.classification),
    });
  } catch (error) {
    console.error("create join session failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Create join session failed",
    });
  }
});

app.get("/join-sessions/:joinSessionId", async (req, res) => {
  try {
    const { joinSessionId } = req.params;
    const joinStore = await readJoinStore();
    const draftStore = await readDraftStore();

    const joinSession = joinStore.joinSessions.find(
      (s) => s.joinSessionId === joinSessionId
    );

    if (!joinSession) {
      return res.status(404).json({
        ok: false,
        error: "Join session not found",
      });
    }

    let status = String(joinSession.status || "PENDING").toUpperCase();

    if (status === "PENDING" && isValidIso(joinSession.expiresAt)) {
      if (parseIso(joinSession.expiresAt) <= Date.now()) {
        status = "EXPIRED";
        joinSession.status = "EXPIRED";
        joinSession.updatedAt = nowIso();
        await writeJoinStore(joinStore);
      }
    }

    const draft = draftStore.drafts.find(
      (d) => d.draftId === joinSession.draftId
    );

    return res.json({
      ok: true,
      joinSessionId: joinSession.joinSessionId,
      betId: joinSession.betId,
      draftId: joinSession.draftId,
      status,
      createdAt: joinSession.createdAt || null,
      updatedAt: joinSession.updatedAt || null,
      expiresAt: joinSession.expiresAt || null,
      signingUrl: joinSession.signingUrl || "",
      telegramUserId: joinSession.telegramUserId || "",
      telegramUsername: joinSession.telegramUsername || "",
      telegramFirstName: joinSession.telegramFirstName || "",
      expectedStake:
        joinSession.expectedStake ||
        draft?.stake ||
        null,
      expectedBondAmount:
        joinSession.expectedBondAmount ||
        draft?.bondAmount ||
        challengeBondForStake(draft?.stake),
      expectedTotalUpfront:
        joinSession.expectedTotalUpfront ||
        draft?.totalTakerUpfront ||
        draft?.stake ||
        null,
      onChainBetId:
        joinSession.onChainBetId ??
        draft?.onChainBetId ??
        null,
      creatorWallet:
        joinSession.creatorWallet ||
        draft?.creatorWallet ||
        "",
      takerWallet:
        joinSession.takerWallet ||
        draft?.takerWallet ||
        "",
      takerFundingTxHash:
        joinSession.takerFundingTxHash ||
        draft?.takerFundingTxHash ||
        "",
      requiresBond:
        typeof draft?.requiresBond === "boolean"
          ? draft.requiresBond
          : true,
      bondAmount: draft?.bondAmount || challengeBondForStake(draft?.stake),
      bondToken: draft?.bondToken || "MIDSTR",
      bondMode: draft?.bondMode || "CHALLENGE_ONLY",
      warning: resolutionWarningForClassification(draft?.classification),
    });
  } catch (error) {
    console.error("join session lookup failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Join session lookup failed",
    });
  }
});

app.post("/join-sessions/:joinSessionId/confirm", async (req, res) => {
  try {
    const { joinSessionId } = req.params;
    const { takerWallet, takerFundingTxHash } = req.body || {};

    const joinStore = await readJoinStore();
    const draftStore = await readDraftStore();

    const joinSession = joinStore.joinSessions.find(
      (s) => s.joinSessionId === joinSessionId
    );

    if (!joinSession) {
      return res.status(404).json({
        ok: false,
        error: "Join session not found",
      });
    }

    const currentStatus = String(joinSession.status || "").toUpperCase();

    if (currentStatus === "CONFIRMED") {
      const existingDraft = draftStore.drafts.find(
        (d) => d.draftId === joinSession.draftId
      );

      return res.json({
        ok: true,
        message: "Join already confirmed",
        betStatus: deriveEffectiveBetStatus(existingDraft, joinStore),
        joinSessionStatus: "CONFIRMED",
      });
    }

    if (currentStatus === "EXPIRED") {
      return res.status(400).json({
        ok: false,
        error: "This join session has expired.",
      });
    }

    if (currentStatus !== "PENDING") {
      return res.status(400).json({
        ok: false,
        error: `Join session cannot be confirmed from status ${currentStatus}`,
      });
    }

    if (
      isValidIso(joinSession.expiresAt) &&
      parseIso(joinSession.expiresAt) <= Date.now()
    ) {
      joinSession.status = "EXPIRED";
      joinSession.updatedAt = nowIso();
      await writeJoinStore(joinStore);

      return res.status(400).json({
        ok: false,
        error: "This join session has expired.",
      });
    }

    const draft = draftStore.drafts.find(
      (d) => d.draftId === joinSession.draftId
    );

    if (!draft) {
      return res.status(404).json({
        ok: false,
        error: "Draft not found",
      });
    }

    const joinableInfo = isDraftJoinable(draft, joinStore);
    if (!joinableInfo.joinable) {
      return res.status(400).json({
        ok: false,
        error: joinableInfo.reason || "This bet cannot be joined.",
      });
    }

    if (!takerWallet || !takerFundingTxHash) {
      return res.status(400).json({
        ok: false,
        error: "takerWallet and takerFundingTxHash are required",
      });
    }

    draft.takerWallet = takerWallet;
    draft.takerFundingTxHash = takerFundingTxHash;
    draft.takerFundingStatus = "FUNDED";
    draft.takerTelegramUserId = String(joinSession.telegramUserId || "");
    draft.takerTelegramUsername = String(joinSession.telegramUsername || "");
    draft.status = "ACTIVE";
    draft.updatedAt = nowIso();

    joinSession.status = "CONFIRMED";
    joinSession.updatedAt = nowIso();
    joinSession.takerWallet = takerWallet;
    joinSession.takerFundingTxHash = takerFundingTxHash;

    for (const session of joinStore.joinSessions) {
      if (
        session.joinSessionId !== joinSession.joinSessionId &&
        String(session.betId || "") === String(joinSession.betId || "")
      ) {
        const status = String(session.status || "").toUpperCase();
        if (status === "PENDING") {
          session.status = "EXPIRED";
          session.updatedAt = nowIso();
        }
      }
    }

    await writeDraftStore(draftStore);
    await writeJoinStore(joinStore);

    return res.json({
      ok: true,
      message: "Join confirmed",
      betStatus: deriveEffectiveBetStatus(draft, joinStore),
      joinSessionStatus: joinSession.status,
      betId: joinSession.betId,
      draftId: joinSession.draftId,
      onChainBetId: draft.onChainBetId ?? joinSession.onChainBetId ?? null,
      warning: resolutionWarningForClassification(draft.classification),
    });
  } catch (error) {
    console.error("confirm join failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Confirm join failed",
    });
  }
});

/* -------------------------------------------------------------------------- */
/*                               USER BET ROUTES                              */
/* -------------------------------------------------------------------------- */

app.get("/users/:telegramUserId/bets", async (req, res) => {
  try {
    const { telegramUserId } = req.params;

    const draftStore = await readDraftStore();
    const joinStore = await readJoinStore();

    const bets = draftStore.drafts
      .filter((d) => {
        return (
          String(d.telegramUserId) === String(telegramUserId) ||
          String(d.takerTelegramUserId) === String(telegramUserId)
        );
      })
      .map((d) => {
        const role =
          String(d.telegramUserId) === String(telegramUserId)
            ? "CREATOR"
            : "TAKER";

        const effectiveStatus = deriveEffectiveBetStatus(d, joinStore);

        return {
          betId: d.betId,
          cleanedBet: d.cleanedBetText,
          cleanedBetText: d.cleanedBetText,
          stake: d.stake,
          tokenSymbol: "MIDSTR",
          status: effectiveStatus,
          statusLabel: getJoinableStatusLabel(d, joinStore),
          role,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          closeTime: d.closeTime,
          resultExpectedBy: d.resultExpectedBy,
          classification: d.classification,
          onChainBetId: d.onChainBetId ?? null,
          creatorFundingStatus: d.creatorFundingStatus || "",
          takerFundingStatus: d.takerFundingStatus || "",
          requiresBond: Boolean(d.requiresBond),
          bondAmount: d.bondAmount || challengeBondForStake(d.stake),
          bondToken: d.bondToken || "MIDSTR",
          bondMode: d.bondMode || "CHALLENGE_ONLY",
          totalCreatorUpfront: d.totalCreatorUpfront || d.stake || "0",
          totalTakerUpfront: d.totalTakerUpfront || d.stake || "0",
          resolutionSuggestion: d.resolutionSuggestion || null,
          resolutionWarning: resolutionWarningForClassification(d.classification),
        };
      });

    return res.json({
      ok: true,
      bets,
    });
  } catch (err) {
    console.error("get bets failed:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to fetch bets",
    });
  }
});

app.get("/users/:telegramUserId/bets/", async (req, res) => {
  return app._router.handle(
    { ...req, url: `/users/${req.params.telegramUserId}/bets`, method: "GET" },
    res
  );
});

app.get("/users/:telegramUserId/bets/summary", async (req, res) => {
  try {
    const { telegramUserId } = req.params;

    const draftStore = await readDraftStore();
    const joinStore = await readJoinStore();

    const userDrafts = draftStore.drafts.filter((d) => {
      return (
        String(d.telegramUserId) === String(telegramUserId) ||
        String(d.takerTelegramUserId) === String(telegramUserId)
      );
    });

    const effectiveStatuses = userDrafts.map((d) =>
      deriveEffectiveBetStatus(d, joinStore)
    );

    const summary = {
      total: userDrafts.length,
      open: effectiveStatuses.filter((s) => s === "CREATED").length,
      active: effectiveStatuses.filter((s) =>
        ["ACTIVE", "CLOSED", "WAITING_RESULT", "RESOLUTION_WINDOW", "DISPUTED"].includes(s)
      ).length,
      inPlay: effectiveStatuses.filter((s) =>
        ["WAITING_RESULT", "RESOLUTION_WINDOW", "DISPUTED"].includes(s)
      ).length,
      done: effectiveStatuses.filter((s) => s === "RESOLVED").length,
    };

    return res.json({
      ok: true,
      summary,
    });
  } catch (err) {
    console.error("summary failed:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to fetch summary",
    });
  }
});

app.get("/users/:telegramUserId/bets/summary/", async (req, res) => {
  return app._router.handle(
    {
      ...req,
      url: `/users/${req.params.telegramUserId}/bets/summary`,
      method: "GET",
    },
    res
  );
});

/* -------------------------------------------------------------------------- */
/*                    SAVE ON-CHAIN CREATOR BET                               */
/* -------------------------------------------------------------------------- */

app.post("/drafts/:draftId/onchain-create-confirm", async (req, res) => {
  try {
    const { draftId } = req.params;

    const {
      onChainBetId,
      creatorWallet,
      creatorCreateTxHash,
      creatorFundingTxHash,
    } = req.body || {};

    const draftStore = await readDraftStore();
    const joinStore = await readJoinStore();

    const draft = draftStore.drafts.find(
      (d) => d.draftId === draftId
    );

    if (!draft) {
      return res.status(404).json({
        ok: false,
        error: "Draft not found",
      });
    }

    draft.onChainBetId = Number(onChainBetId);
    draft.creatorWallet = creatorWallet || "";
    draft.creatorCreateTxHash = creatorCreateTxHash || "";
    draft.creatorFundingTxHash = creatorFundingTxHash || "";
    draft.creatorFundingStatus = "FUNDED";
    draft.updatedAt = nowIso();

    for (const j of joinStore.joinSessions) {
      if (j.draftId === draftId) {
        j.onChainBetId = draft.onChainBetId;
        j.creatorWallet = draft.creatorWallet;
        j.updatedAt = nowIso();
      }
    }

    await writeDraftStore(draftStore);
    await writeJoinStore(joinStore);

    return res.json({
      ok: true,
      onChainBetId: draft.onChainBetId,
      creatorWallet: draft.creatorWallet,
    });
  } catch (err) {
    console.error("onchain-create-confirm failed:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to save on-chain bet",
    });
  }
});

/* -------------------------------------------------------------------------- */
/*                         PHASE 6B RESOLUTION ROUTES                         */
/* -------------------------------------------------------------------------- */

app.get("/resolution/status/:betId", async (req, res) => {
  try {
    const { betId } = req.params;
    const telegramUserId = String(req.query?.telegramUserId || "").trim();

    const draftStore = await readDraftStore();
    const draft = findDraftByBetId(draftStore, betId);

    if (!draft) {
      return res.status(404).json({
        ok: false,
        error: "Bet not found",
      });
    }

    const payload = await buildResolutionStatusPayload(draft, telegramUserId);

    return res.json(payload);
  } catch (err) {
    console.error("resolution status failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.shortMessage || err.message || "Failed to fetch resolution status",
    });
  }
});

app.get("/resolution/actions/:betId", async (req, res) => {
  try {
    const { betId } = req.params;
    const telegramUserId = String(req.query?.telegramUserId || "").trim();

    const draftStore = await readDraftStore();
    const draft = findDraftByBetId(draftStore, betId);

    if (!draft) {
      return res.status(404).json({
        ok: false,
        error: "Bet not found",
      });
    }

    const payload = await buildResolutionStatusPayload(draft, telegramUserId);

    return res.json({
      ok: true,
      betId: payload.betId,
      status: payload.status,
      statusLabel: payload.statusLabel,
      role: payload.role,
      warning: payload.warning,
      suggestion: payload.suggestion,
      proposedWinnerSide: payload.proposedWinnerSide,
      proposedWinnerLabel: payload.proposedWinnerLabel,
      challengeBondAmount: payload.challengeBondAmount,
      bondToken: payload.bondToken,
      actions: payload.actions,
    });
  } catch (err) {
    console.error("resolution actions failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.shortMessage || err.message || "Failed to fetch resolution actions",
    });
  }
});

app.post("/resolution/sync/:betId", async (req, res) => {
  try {
    const { betId } = req.params;

    const draftStore = await readDraftStore();
    const draft = findDraftByBetId(draftStore, betId);

    if (!draft) {
      return res.status(404).json({
        ok: false,
        error: "Bet not found",
      });
    }

    const chainState = await readChainResolutionState(draft.onChainBetId);
    await syncDraftFromChain(draft, chainState);
    await writeDraftStore(draftStore);

    return res.json({
      ok: true,
      betId: draft.betId,
      status: draft.status,
      chain: chainState,
    });
  } catch (err) {
    console.error("resolution sync failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.shortMessage || err.message || "Failed to sync resolution status",
    });
  }
});

app.post("/resolution/suggest/:betId", async (req, res) => {
  try {
    const { betId } = req.params;
    const { winnerSide, evidenceSummary, confidence, sourceUrls } = req.body || {};

    const parsedWinnerSide = Number(winnerSide);

    if (![1, 2].includes(parsedWinnerSide)) {
      return res.status(400).json({
        ok: false,
        error: "winnerSide must be 1 for creator or 2 for taker",
      });
    }

    const draftStore = await readDraftStore();
    const draft = findDraftByBetId(draftStore, betId);

    if (!draft) {
      return res.status(404).json({
        ok: false,
        error: "Bet not found",
      });
    }

    const windowInfo = getResolutionWindowInfo(draft);
    if (!windowInfo.windowOpen && !windowInfo.windowExpired) {
      return res.status(400).json({
        ok: false,
        error: "Result Expected By has not passed yet",
        window: windowInfo,
      });
    }

    draft.resolutionSuggestion = {
      winnerSide: parsedWinnerSide,
      winnerLabel: SIDE_LABELS[parsedWinnerSide],
      text: `Evidence points to ${SIDE_LABELS[parsedWinnerSide]} winning.`,
      evidenceSummary: String(evidenceSummary || "").trim(),
      confidence: confidence || "",
      sourceUrls: Array.isArray(sourceUrls) ? sourceUrls : [],
    };
    draft.resolutionSuggestionAt = nowIso();
    draft.status = "WAITING_RESULT";
    draft.updatedAt = nowIso();

    await writeDraftStore(draftStore);

    return res.json({
      ok: true,
      betId: draft.betId,
      suggestion: draft.resolutionSuggestion,
      suggestionAt: draft.resolutionSuggestionAt,
    });
  } catch (err) {
    console.error("resolution suggest failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to save resolution suggestion",
    });
  }
});

app.post("/resolution/propose-verifiable", async (req, res) => {
  try {
    const { betId, onChainBetId, winnerSide, evidenceSummary, confidence, sourceUrls } = req.body || {};

    if (onChainBetId === undefined || onChainBetId === null) {
      return res.status(400).json({
        ok: false,
        error: "onChainBetId is required",
      });
    }

    const parsedWinnerSide = Number(winnerSide);

    if (![1, 2].includes(parsedWinnerSide)) {
      return res.status(400).json({
        ok: false,
        error: "winnerSide must be 1 for creator or 2 for taker",
      });
    }

    const draftStore = await readDraftStore();
    const draft = betId ? findDraftByBetId(draftStore, betId) : draftStore.drafts.find(
      (d) => Number(d.onChainBetId) === Number(onChainBetId)
    );

    if (draft) {
      const windowInfo = getResolutionWindowInfo(draft);

      if (!windowInfo.windowOpen && !windowInfo.windowExpired) {
        return res.status(400).json({
          ok: false,
          error: "Result Expected By has not passed yet",
          window: windowInfo,
        });
      }
    }

    const contract = getResolverContract();
    const signerInfo = await assertResolverSigner(contract);

    const betBefore = await contract.bets(BigInt(onChainBetId));

    const tx = await contract.proposeResultVerifiable(
      BigInt(onChainBetId),
      parsedWinnerSide
    );

    const receipt = await tx.wait();

    const betAfter = await contract.bets(BigInt(onChainBetId));
    const chainAfter = parseChainBet(betAfter);

    if (draft) {
      draft.resolutionSuggestion = {
        winnerSide: parsedWinnerSide,
        winnerLabel: SIDE_LABELS[parsedWinnerSide],
        text: `Evidence points to ${SIDE_LABELS[parsedWinnerSide]} winning.`,
        evidenceSummary: String(evidenceSummary || "").trim(),
        confidence: confidence || "",
        sourceUrls: Array.isArray(sourceUrls) ? sourceUrls : [],
      };
      draft.resolutionSuggestionAt = nowIso();
      draft.resolutionProposedTxHash = tx.hash;
      draft.status = "RESOLUTION_WINDOW";
      draft.updatedAt = nowIso();
      await writeDraftStore(draftStore);
    }

    return res.json({
      ok: true,
      betId: draft?.betId || "",
      onChainBetId: Number(onChainBetId),
      winnerSide: parsedWinnerSide,
      winnerLabel: SIDE_LABELS[parsedWinnerSide],
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      resolverAddress: signerInfo.resolverAddress,
      signerAddress: signerInfo.signerAddress,
      before: {
        status: Number(betBefore.status),
        proposedWinnerSide: Number(betBefore.proposedWinnerSide),
      },
      after: {
        status: chainAfter.status,
        statusName: chainAfter.statusName,
        proposedWinnerSide: chainAfter.proposedWinnerSide,
        proposalTimeUtc: chainAfter.proposalTimeUtc,
        proposalTimeIso: chainAfter.proposalTimeIso,
      },
    });
  } catch (err) {
    console.error("propose-verifiable failed:", err);
    return res.status(err.statusCode || 500).json({
      ok: false,
      error: err.shortMessage || err.message || "Failed to propose result",
      details: err.details || undefined,
    });
  }
});

app.post("/resolution/finalise-dispute", async (req, res) => {
  try {
    const { betId, onChainBetId, finalWinnerSide, challengeCorrect } = req.body || {};

    if (onChainBetId === undefined || onChainBetId === null) {
      return res.status(400).json({
        ok: false,
        error: "onChainBetId is required",
      });
    }

    const parsedWinnerSide = Number(finalWinnerSide);

    if (![1, 2].includes(parsedWinnerSide)) {
      return res.status(400).json({
        ok: false,
        error: "finalWinnerSide must be 1 for creator or 2 for taker",
      });
    }

    if (typeof challengeCorrect !== "boolean") {
      return res.status(400).json({
        ok: false,
        error: "challengeCorrect must be true or false",
      });
    }

    const contract = getResolverContract();
    const signerInfo = await assertResolverSigner(contract);

    const betBefore = await contract.bets(BigInt(onChainBetId));

    const tx = await contract.finaliseDispute(
      BigInt(onChainBetId),
      parsedWinnerSide,
      challengeCorrect
    );

    const receipt = await tx.wait();

    const betAfter = await contract.bets(BigInt(onChainBetId));
    const chainAfter = parseChainBet(betAfter);

    const draftStore = await readDraftStore();
    const draft = betId ? findDraftByBetId(draftStore, betId) : draftStore.drafts.find(
      (d) => Number(d.onChainBetId) === Number(onChainBetId)
    );

    if (draft) {
      draft.status = "FINALISED";
      draft.disputeFinaliseTxHash = tx.hash;
      draft.finalWinnerSide = parsedWinnerSide;
      draft.challengeCorrect = challengeCorrect;
      draft.updatedAt = nowIso();
      await writeDraftStore(draftStore);
    }

    return res.json({
      ok: true,
      betId: draft?.betId || "",
      onChainBetId: Number(onChainBetId),
      finalWinnerSide: parsedWinnerSide,
      finalWinnerLabel: SIDE_LABELS[parsedWinnerSide],
      challengeCorrect,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      resolverAddress: signerInfo.resolverAddress,
      signerAddress: signerInfo.signerAddress,
      before: {
        status: Number(betBefore.status),
        proposedWinnerSide: Number(betBefore.proposedWinnerSide),
        finalWinnerSide: Number(betBefore.finalWinnerSide),
      },
      after: {
        status: chainAfter.status,
        statusName: chainAfter.statusName,
        proposedWinnerSide: chainAfter.proposedWinnerSide,
        finalWinnerSide: chainAfter.finalWinnerSide,
        finalisedAtUtc: chainAfter.finalisedAtUtc,
        finalisedAtIso: chainAfter.finalisedAtIso,
      },
    });
  } catch (err) {
    console.error("finalise-dispute failed:", err);
    return res.status(err.statusCode || 500).json({
      ok: false,
      error: err.shortMessage || err.message || "Failed to finalise dispute",
      details: err.details || undefined,
    });
  }
});

app.post("/resolution/action-confirm", async (req, res) => {
  try {
    const { betId, action, txHash } = req.body || {};

    if (!betId || !action || !txHash) {
      return res.status(400).json({
        ok: false,
        error: "betId, action, and txHash are required",
      });
    }

    const draftStore = await readDraftStore();
    const draft = findDraftByBetId(draftStore, betId);

    if (!draft) {
      return res.status(404).json({
        ok: false,
        error: "Bet not found",
      });
    }

    const normalizedAction = String(action || "").toUpperCase();

    draft.lastResolutionAction = normalizedAction;
    draft.lastResolutionTxHash = txHash;
    draft.resolutionUpdatedAt = nowIso();
    draft.updatedAt = nowIso();

    if (normalizedAction === "CHALLENGE") {
      draft.status = "DISPUTED";
    }

    if (["CONCEDE", "SETTLE", "TIMEOUT"].includes(normalizedAction)) {
      draft.status = "RESOLVED";
    }

    const chainState = await readChainResolutionState(draft.onChainBetId).catch(() => null);
    if (chainState) {
      await syncDraftFromChain(draft, chainState);
    }

    await writeDraftStore(draftStore);

    return res.json({
      ok: true,
      betId: draft.betId,
      action: normalizedAction,
      txHash,
      status: draft.status,
      chain: chainState,
    });
  } catch (err) {
    console.error("resolution action confirm failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to confirm resolution action",
    });
  }
});

app.listen(PORT, async () => {
  await ensureDataFiles();
  console.log(`MIDSTR backend listening on http://localhost:${PORT}`);
});