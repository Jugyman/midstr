import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const BETS_FILE = path.join(DATA_DIR, "bets.json");
const JOIN_SESSIONS_FILE = path.join(DATA_DIR, "joinSessions.json");

async function ensureJsonFile(filePath, fallbackValue) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(fallbackValue, null, 2), "utf8");
  }
}

async function readJson(filePath, fallbackValue) {
  await ensureJsonFile(filePath, fallbackValue);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function getBetStatusGroup(status) {
  const s = String(status || "").toUpperCase();

  if (s === "CREATED") return "OPEN";
  if (s === "ACTIVE") return "ACTIVE";
  if (["CLOSED", "WAITING_RESULT", "RESOLUTION_WINDOW", "DISPUTED"].includes(s)) {
    return "IN_PLAY";
  }
  if (["RESOLVED", "FINALISED", "FINALIZED", "CANCELLED", "EXPIRED"].includes(s)) {
    return "DONE";
  }

  return "OTHER";
}

function buildUserViewBet(bet, joinSessions, telegramUserId) {
  const creatorTelegramId =
    String(
      bet.creatorTelegramUserId ??
        bet.creatorTelegramId ??
        bet.creatorUserId ??
        ""
    ) || null;

  const takerTelegramId =
    String(
      bet.takerTelegramUserId ??
        bet.takerTelegramId ??
        bet.opponentTelegramUserId ??
        bet.joinedByTelegramUserId ??
        ""
    ) || null;

  const userId = String(telegramUserId);

  let role = "UNKNOWN";
  if (creatorTelegramId === userId) role = "CREATOR";
  if (takerTelegramId === userId) role = "TAKER";

  const relatedJoinSessions = joinSessions
    .filter((session) => session.betId === bet.betId)
    .sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });

  const latestJoinSession = relatedJoinSessions[0] || null;

  return {
    betId: bet.betId,
    inviteId: bet.inviteId || null,
    status: bet.status || "UNKNOWN",
    statusGroup: getBetStatusGroup(bet.status),
    role,
    cleanedBet: bet.cleanedBet || bet.betText || bet.rawBetText || "Untitled bet",
    classification: bet.classification || null,
    stake: bet.stake ?? bet.stakeAmount ?? null,
    tokenSymbol: bet.tokenSymbol || "MIDSTR",
    creatorTelegramUserId: creatorTelegramId,
    takerTelegramUserId: takerTelegramId,
    closeAt: bet.closeAt || bet.closeTimeUtc || bet.closeTime || null,
    resultExpectedBy: bet.resultExpectedBy || null,
    createdAt: bet.createdAt || null,
    updatedAt: bet.updatedAt || null,
    joinSession: latestJoinSession
      ? {
          joinSessionId: latestJoinSession.joinSessionId,
          status: latestJoinSession.status,
          expiresAt: latestJoinSession.expiresAt || null,
          signingUrl: latestJoinSession.signingUrl || null,
        }
      : null,
  };
}

function sortNewestFirst(items) {
  return [...items].sort((a, b) => {
    const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bTime - aTime;
  });
}

router.get("/users/:telegramUserId/bets", async (req, res) => {
  try {
    const { telegramUserId } = req.params;
    const roleFilter = String(req.query.role || "all").toLowerCase();
    const statusFilter = String(req.query.status || "all").toUpperCase();
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));

    const bets = normalizeArray(await readJson(BETS_FILE, []));
    const joinSessions = normalizeArray(await readJson(JOIN_SESSIONS_FILE, []));

    const userBets = bets
      .filter((bet) => {
        const creatorId = String(
          bet.creatorTelegramUserId ??
            bet.creatorTelegramId ??
            bet.creatorUserId ??
            ""
        );
        const takerId = String(
          bet.takerTelegramUserId ??
            bet.takerTelegramId ??
            bet.opponentTelegramUserId ??
            bet.joinedByTelegramUserId ??
            ""
        );

        return creatorId === String(telegramUserId) || takerId === String(telegramUserId);
      })
      .map((bet) => buildUserViewBet(bet, joinSessions, telegramUserId))
      .filter((bet) => {
        if (roleFilter === "creator" && bet.role !== "CREATOR") return false;
        if (roleFilter === "taker" && bet.role !== "TAKER") return false;
        if (statusFilter !== "ALL" && String(bet.status).toUpperCase() !== statusFilter) return false;
        return true;
      });

    const sorted = sortNewestFirst(userBets).slice(0, limit);

    return res.json({
      ok: true,
      telegramUserId: String(telegramUserId),
      count: sorted.length,
      bets: sorted,
    });
  } catch (error) {
    console.error("GET /users/:telegramUserId/bets failed:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load bets for user",
    });
  }
});

router.get("/users/:telegramUserId/bets/summary", async (req, res) => {
  try {
    const { telegramUserId } = req.params;

    const bets = normalizeArray(await readJson(BETS_FILE, []));
    const joinSessions = normalizeArray(await readJson(JOIN_SESSIONS_FILE, []));

    const userBets = bets
      .filter((bet) => {
        const creatorId = String(
          bet.creatorTelegramUserId ??
            bet.creatorTelegramId ??
            bet.creatorUserId ??
            ""
        );
        const takerId = String(
          bet.takerTelegramUserId ??
            bet.takerTelegramId ??
            bet.opponentTelegramUserId ??
            bet.joinedByTelegramUserId ??
            ""
        );

        return creatorId === String(telegramUserId) || takerId === String(telegramUserId);
      })
      .map((bet) => buildUserViewBet(bet, joinSessions, telegramUserId));

    const summary = {
      total: userBets.length,
      open: userBets.filter((bet) => bet.statusGroup === "OPEN").length,
      active: userBets.filter((bet) => bet.statusGroup === "ACTIVE").length,
      inPlay: userBets.filter((bet) => bet.statusGroup === "IN_PLAY").length,
      done: userBets.filter((bet) => bet.statusGroup === "DONE").length,
      asCreator: userBets.filter((bet) => bet.role === "CREATOR").length,
      asTaker: userBets.filter((bet) => bet.role === "TAKER").length,
    };

    return res.json({
      ok: true,
      telegramUserId: String(telegramUserId),
      summary,
    });
  } catch (error) {
    console.error("GET /users/:telegramUserId/bets/summary failed:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load bet summary for user",
    });
  }
});

export default router;