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

function ensureDraftDefaults(draft) {
  if (!draft || typeof draft !== "object") return draft;

  const classification = String(draft.classification || "").toUpperCase();
  const requiresBondDefault =
    classification === "AMBIGUOUS" || classification === "MANUAL_ONLY";

  const stake = normalizeStake(draft.stake) || "0";
  const bondAmount = normalizeTokenAmount(draft.bondAmount, "0");
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
    requiresBond:
      typeof draft.requiresBond === "boolean"
        ? draft.requiresBond
        : requiresBondDefault,
    bondAmount,
    bondToken: draft.bondToken || "MIDSTR",
    bondMode: draft.bondMode || "NONE",
    totalCreatorUpfront,
    totalTakerUpfront,
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

function deriveEffectiveBetStatus(draft, joinStore) {
  const safeDraft = ensureDraftDefaults(draft);
  const rawStatus = String(safeDraft.status || "").toUpperCase();

  if (
    safeDraft.takerWallet ||
    safeDraft.takerFundingTxHash ||
    String(safeDraft.takerFundingStatus || "").toUpperCase() === "FUNDED" ||
    hasConfirmedJoinSession(joinStore, safeDraft)
  ) {
    return "ACTIVE";
  }

  if (["RESOLVED", "FINALISED", "FINALIZED"].includes(rawStatus)) {
    return "RESOLVED";
  }

  if (["CANCELLED", "EXPIRED"].includes(rawStatus)) {
    return rawStatus;
  }

  if (rawStatus === "ACTIVE") {
    return "ACTIVE";
  }

  if (rawStatus === "CREATED" || rawStatus === "AWAITING_TAKER") {
    return "CREATED";
  }

  return rawStatus || "CREATED";
}

function getJoinableStatusLabel(draft, joinStore) {
  const effectiveStatus = deriveEffectiveBetStatus(draft, joinStore);

  if (effectiveStatus === "ACTIVE") {
    return "Active";
  }

  if (effectiveStatus === "RESOLVED") {
    return "Resolved";
  }

  if (effectiveStatus === "CANCELLED") {
    return "Cancelled";
  }

  if (effectiveStatus === "EXPIRED") {
    return "Expired";
  }

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
          "- AMBIGUOUS and MANUAL_ONLY require Result Expected By downstream.",
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

  parsed.requiresResultExpectedBy = parsed.classification !== "VERIFIABLE";
  parsed.missingFields = Array.isArray(parsed.missingFields)
    ? parsed.missingFields
    : [];

  if (
    looksClearlyVerifiable(betText) &&
    parsed.classification !== "VERIFIABLE"
  ) {
    parsed.classification = "VERIFIABLE";
    parsed.requiresResultExpectedBy = false;
    parsed.explanation =
      "This wager appears objective and externally checkable from public data or official results.";
    parsed.settlementBasis =
      "Resolve using public market data or official competition/result data.";
    parsed.decisionType = "EVENT_BASED";
    parsed.missingFields = parsed.missingFields.filter(
      (f) => f !== "resultExpectedBy"
    );
  }

  if (
    parsed.requiresResultExpectedBy &&
    !parsed.missingFields.includes("resultExpectedBy")
  ) {
    parsed.missingFields.unshift("resultExpectedBy");
  }

  return parsed;
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

    if (
      classification !== "VERIFIABLE" &&
      (!resultExpectedBy || !isValidIso(resultExpectedBy))
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "resultExpectedBy is required for AMBIGUOUS and MANUAL_ONLY drafts",
      });
    }

    const normalizedStake = normalizeStake(stake);
    if (!normalizedStake) {
      return res.status(400).json({
        ok: false,
        error: "stake is required and must be a positive number",
      });
    }

    const upperClassification = String(classification || "").toUpperCase();
    const computedRequiresBond =
      typeof requiresBond === "boolean"
        ? requiresBond
        : upperClassification === "AMBIGUOUS" ||
          upperClassification === "MANUAL_ONLY";

    const normalizedBondAmount = normalizeTokenAmount(bondAmount, "0");
    const normalizedBondMode = bondMode || "NONE";
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
      resultExpectedBy:
        upperClassification === "VERIFIABLE" ? null : resultExpectedBy,
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
      requiresBond: computedRequiresBond,
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
    });

    store.drafts.unshift(draft);
    await writeDraftStore(store);

    return res.json({
      ok: true,
      draft,
      signingUrl: `${WEB_BASE_URL}/sign?draftId=${draftId}`,
      inviteBetId: betId,
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
        bondAmount: draft.bondAmount || "0",
        bondToken: draft.bondToken || "MIDSTR",
        bondMode: draft.bondMode || "NONE",
        totalCreatorUpfront: draft.totalCreatorUpfront || draft.stake || "0",
        totalTakerUpfront: draft.totalTakerUpfront || draft.stake || "0",
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
      expectedBondAmount: draft.bondAmount || "0",
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
        "0",
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
          : false,
      bondAmount: draft?.bondAmount || "0",
      bondToken: draft?.bondToken || "MIDSTR",
      bondMode: draft?.bondMode || "NONE",
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
          bondAmount: d.bondAmount || "0",
          bondToken: d.bondToken || "MIDSTR",
          bondMode: d.bondMode || "NONE",
          totalCreatorUpfront: d.totalCreatorUpfront || d.stake || "0",
          totalTakerUpfront: d.totalTakerUpfront || d.stake || "0",
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

// Get summary
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
      active: effectiveStatuses.filter((s) => s === "ACTIVE").length,
      inPlay: 0,
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
/*                    SAVE ON-CHAIN CREATOR BET (NEW)                         */
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
/*                    PHASE 6: PROPOSE VERIFIABLE RESULT                      */
/* -------------------------------------------------------------------------- */

const ESCROW_V3_ABI = [
  "function proposeResultVerifiable(uint256 betId, uint8 winnerSide) external",
  "function arbiterResolver() view returns (address)",
  "function bets(uint256) view returns (address creatorWallet,address takerWallet,uint256 stake,uint8 resolutionType,uint8 status,uint64 closeTimeUtc,uint64 resultExpectedByUtc,uint64 proposalTimeUtc,uint64 finalisedAtUtc,uint8 proposedWinnerSide,uint8 finalWinnerSide,address challengerWallet,uint256 challengeBond,bool challengeCorrect,bool creatorFunded,bool takerFunded,bool settled)",
];

function getResolverContract() {
  if (!process.env.SEPOLIA_RPC_URL) {
    throw new Error("SEPOLIA_RPC_URL missing");
  }

  if (!process.env.ARBITER_RESOLVER_PRIVATE_KEY) {
    throw new Error("ARBITER_RESOLVER_PRIVATE_KEY missing");
  }

  if (!process.env.ESCROW_TOKEN_ADDRESS) {
    throw new Error("ESCROW_TOKEN_ADDRESS missing");
  }

  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const wallet = new ethers.Wallet(
    process.env.ARBITER_RESOLVER_PRIVATE_KEY,
    provider
  );

  return new ethers.Contract(
    process.env.ESCROW_TOKEN_ADDRESS,
    ESCROW_V3_ABI,
    wallet
  );
}

app.post("/resolution/propose-verifiable", async (req, res) => {
  try {
    const { onChainBetId, winnerSide } = req.body || {};

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

    const contract = getResolverContract();

    const resolverAddress = await contract.arbiterResolver();
    const signerAddress = await contract.runner.getAddress();

    if (resolverAddress.toLowerCase() !== signerAddress.toLowerCase()) {
      return res.status(403).json({
        ok: false,
        error: "Backend signer is not the contract arbiterResolver",
        resolverAddress,
        signerAddress,
      });
    }

    const betBefore = await contract.bets(BigInt(onChainBetId));

    const tx = await contract.proposeResultVerifiable(
      BigInt(onChainBetId),
      parsedWinnerSide
    );

    const receipt = await tx.wait();

    const betAfter = await contract.bets(BigInt(onChainBetId));

    return res.json({
      ok: true,
      onChainBetId: Number(onChainBetId),
      winnerSide: parsedWinnerSide,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      before: {
        status: Number(betBefore.status),
        proposedWinnerSide: Number(betBefore.proposedWinnerSide),
      },
      after: {
        status: Number(betAfter.status),
        proposedWinnerSide: Number(betAfter.proposedWinnerSide),
        proposalTimeUtc: Number(betAfter.proposalTimeUtc),
      },
    });
  } catch (err) {
    console.error("propose-verifiable failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.shortMessage || err.message || "Failed to propose result",
    });
  }
});

app.listen(PORT, async () => {
  await ensureDataFiles();
  console.log(`MIDSTR backend listening on http://localhost:${PORT}`);
});