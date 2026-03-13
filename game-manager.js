/**
 * GameManager - Single source of truth for shared game state.
 * State machine: waiting → countdown → playing → ended → (auto) waiting
 * Broadcasts all state changes via Socket.io.
 */
import { prisma } from './game.js';
import {
  getGame,
  getOrCreateWaitingGame,
  startGameCaller,
  settleGame,
  HOUSE_CUT_PERCENT,
} from './game.js';

const MIN_PLAYERS = 1; // Start with 1+ players for testing; use 5 for production
const COUNTDOWN_SECONDS = 20;
const CALL_INTERVAL_MS = Number(process.env.CALL_INTERVAL_MS) || 5000;
const END_DELAY_MS = 10000; // Delay before starting new game after end

let broadcastFn = null;

export function setBroadcast(fn) {
  broadcastFn = fn;
}

function broadcast(event, payload) {
  if (broadcastFn) broadcastFn(event, payload);
}

function getSharedGameState(game) {
  const phase = game.status || 'waiting';
  const drawnNumbers = Array.isArray(game.calledNumbers) ? game.calledNumbers : [];
  const winners = Array.isArray(game.winners) ? game.winners : (game.winnerId ? [String(game.winnerId)] : []);
  return {
    phase,
    countdown: game.countdown ?? null,
    drawnNumbers,
    playerCount: game.playerCount ?? 0,
    winners: winners.map(String),
    message: game.message ?? null,
    gameId: game.id,
    totalPool: game.totalPool,
    winnerAmount: game.winnerAmount,
    winnerId: game.winnerId ? Number(game.winnerId) : null,
    derash: game.totalPool ? Math.floor(game.totalPool * (1 - HOUSE_CUT_PERCENT / 100)) : 0,
    takenCartelaIds: (game.gamePlayers || []).map((gp) => gp.cartelaId),
  };
}

let countdownInterval = null;
let currentGameId = null;

async function transitionToCountdown(game) {
  const g = await prisma.game.update({
    where: { id: game.id },
    data: { status: 'countdown', countdown: COUNTDOWN_SECONDS },
    include: { gamePlayers: { include: { cartela: true } } },
  });
  broadcast('game-state-update', getSharedGameState(g));
  broadcast('countdown-tick', { gameId: g.id, countdown: COUNTDOWN_SECONDS });
  return g;
}

async function tickCountdown(gameId) {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: { gamePlayers: true },
  });
  if (!game || game.status !== 'countdown') {
    stopCountdown();
    return;
  }
  const next = (game.countdown ?? COUNTDOWN_SECONDS) - 1;
  if (next <= 0) {
    stopCountdown();
    const updated = await prisma.game.findUnique({
      where: { id: gameId },
      include: { gamePlayers: true },
    });
    if (updated && updated.gamePlayers.length >= MIN_PLAYERS) {
      await transitionToPlaying(updated);
    } else {
      const g = await prisma.game.update({
        where: { id: gameId },
        data: { status: 'countdown', countdown: COUNTDOWN_SECONDS },
        include: { gamePlayers: { include: { cartela: true } } },
      });
      startCountdown(gameId);
      broadcast('countdown-tick', { gameId, countdown: COUNTDOWN_SECONDS });
      broadcast('game-state-update', getSharedGameState(g));
    }
    return;
  }
  const g = await prisma.game.update({
    where: { id: gameId },
    data: { countdown: next },
    include: { gamePlayers: { include: { cartela: true } } },
  });
  broadcast('countdown-tick', { gameId, countdown: next });
  broadcast('game-state-update', getSharedGameState(g));
}

function startCountdown(gameId) {
  stopCountdown();
  currentGameId = gameId;
  countdownInterval = setInterval(() => tickCountdown(gameId), 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  currentGameId = null;
}

async function transitionToPlaying(game) {
  await prisma.game.update({
    where: { id: game.id },
    data: { status: 'playing', countdown: null, startedAt: new Date() },
  });
  const g = await getGame(game.id);
  broadcast('game-state-update', getSharedGameState(g));
  startGameCaller(game.id);
}

export async function onNumberDrawn(gameId, number) {
  const g = await getGame(gameId);
  broadcast('number-drawn', {
    gameId,
    number,
    drawnNumbers: g.calledNumbers || [],
  });
  broadcast('game-state-update', getSharedGameState(g));
}

export async function onGameEnded(gameId, result) {
  const g = await getGame(gameId);
  let winnerName = result.winnerName ?? null;
  if (g.winnerId && !winnerName) {
    const winner = await prisma.user.findUnique({
      where: { telegramId: g.winnerId },
    });
    winnerName = winner?.name ?? 'Winner';
  }
  const winnerCountdownSeconds = Math.floor(END_DELAY_MS / 1000);
  broadcast('game-end', {
    gameId,
    ...result,
    winnerName,
    state: getSharedGameState(g),
    winnerCountdown: winnerCountdownSeconds,
  });
  broadcast('game-state-update', getSharedGameState(g));
  stopCountdown();
  runWinnerCountdown(gameId);
}

async function startNewGame() {
  const game = await getOrCreateWaitingGame();
  broadcast('game-state-update', getSharedGameState(game));
}

/**
 * Runs the winner modal countdown and broadcasts ticks for sync across clients.
 * Call after game ends (claim or no winner). After END_DELAY_MS, broadcasts new game.
 */
export function runWinnerCountdown(gameId) {
  const winnerCountdownSeconds = Math.floor(END_DELAY_MS / 1000);
  let remaining = winnerCountdownSeconds;
  broadcast('winner-countdown-tick', { gameId, countdown: remaining });
  const interval = setInterval(() => {
    remaining -= 1;
    broadcast('winner-countdown-tick', { gameId, countdown: remaining });
    if (remaining <= 0) {
      clearInterval(interval);
      startNewGame().catch(console.error);
    }
  }, 1000);
}

export async function checkMinPlayersAndStartCountdown(game) {
  if (game.status !== 'waiting') return game;
  const playerCount = game.gamePlayers?.length ?? 0;
  if (playerCount >= MIN_PLAYERS) {
    await transitionToCountdown(game);
    startCountdown(game.id);
    return getGame(game.id);
  }
  return game;
}

/**
 * Ensures the countdown is always running for a joinable game (waiting or countdown).
 * Call this when returning a waiting/countdown game so the countdown always runs.
 * - If status is 'waiting': transition to countdown and start timer
 * - If status is 'countdown': start timer if not already running for this game
 */
export async function ensureCountdownForGame(game) {
  if (!game || (game.status !== 'waiting' && game.status !== 'countdown')) {
    return game;
  }
  if (game.status === 'waiting') {
    const g = await transitionToCountdown(game);
    startCountdown(g.id);
    return getGame(g.id);
  }
  if (game.status === 'countdown' && currentGameId !== game.id) {
    startCountdown(game.id);
  }
  return game;
}

export async function handlePlayerJoined(gameId) {
  const game = await getGame(gameId);
  const updated = await checkMinPlayersAndStartCountdown(game);
  broadcast('game-state-update', getSharedGameState(updated));
  return updated;
}

export async function getCurrentSharedState() {
  let game = await prisma.game.findFirst({
    orderBy: { id: 'desc' },
    include: { gamePlayers: { include: { cartela: true } } },
  });
  if (!game) {
    game = await getOrCreateWaitingGame();
  }
  return getSharedGameState(game);
}

export { getSharedGameState };
