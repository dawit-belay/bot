import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
export const STAKE = 10;
export const HOUSE_CUT_PERCENT = 10;

export async function getCartelas() {
  return prisma.cartela.findMany({ orderBy: { id: 'asc' } });
}

const SELECTION_SECONDS = 10;
export const CALL_INTERVAL_MS = Number(process.env.CALL_INTERVAL_MS) || 5000;

export async function getOrCreateWaitingGame() {
  let game = await prisma.game.findFirst({
    where: { status: 'waiting' },
    orderBy: { id: 'desc' },
    include: { gamePlayers: { include: { cartela: true } } }
  });
  if (!game) {
    game = await prisma.game.create({
      data: { status: 'waiting' },
      include: { gamePlayers: { include: { cartela: true } } }
    });
  }
  const { ensureCountdownForGame } = await import('./game-manager.js');
  return ensureCountdownForGame(game);
}

/** Returns the game users should see for cartela selection/joining.
 * If the most recent game is playing or ended, returns the waiting game (next round).
 * Otherwise returns the current joinable game (waiting or countdown). */
export async function getCurrentGame() {
  const latest = await prisma.game.findFirst({
    orderBy: { id: 'desc' },
    include: { gamePlayers: { include: { cartela: true } } }
  });
  if (!latest) {
    return getOrCreateWaitingGame();
  }
  if (latest.status === 'playing' || latest.status === 'ended') {
    return latest; // Return ended game during winner countdown; startNewGame creates next after countdown
  }
  const { ensureCountdownForGame } = await import('./game-manager.js');
  return ensureCountdownForGame(latest);
}

export function getSelectionEndsAt(game) {
  const created = new Date(game.createdAt).getTime();
  return created + SELECTION_SECONDS * 1000;
}

export async function getGame(gameId) {
  return prisma.game.findUnique({
    where: { id: Number(gameId) },
    include: {
      gamePlayers: {
        include: { cartela: true, user: true }
      }
    }
  });
}

export async function joinGame(telegramId, gameId, cartelaId) {
  const userId = BigInt(telegramId);
  const gId = Number(gameId);
  const cId = Number(cartelaId);

  const [user, game, cartela] = await Promise.all([
    prisma.user.findUnique({ where: { telegramId: userId } }),
    prisma.game.findUnique({ where: { id: gId } }),
    prisma.cartela.findUnique({ where: { id: cId } })
  ]);

  if (!user) throw new Error('User not registered');
  if (!game || (game.status !== 'waiting' && game.status !== 'countdown')) throw new Error('Game not available');
  if (!cartela) throw new Error('Invalid cartela');
  if (user.balance < STAKE) throw new Error('Insufficient balance. Need at least 10 birr.');

  const existing = await prisma.gamePlayer.findUnique({
    where: { gameId_userId: { gameId: gId, userId } }
  });
  if (existing) throw new Error('Already joined this game');

  const cartelaTaken = await prisma.gamePlayer.findFirst({
    where: { gameId: gId, cartelaId: cId }
  });
  if (cartelaTaken) throw new Error('Cartela already taken');

  await prisma.$transaction([
    prisma.user.update({
      where: { telegramId: userId },
      data: { balance: { decrement: STAKE } }
    }),
    prisma.game.update({
      where: { id: gId },
      data: {
        totalPool: { increment: STAKE },
        playerCount: { increment: 1 }
      }
    }),
    prisma.gamePlayer.create({
      data: { userId, gameId: gId, cartelaId: cId }
    })
  ]);

  return getGame(gameId);
}

export async function getUserGamePlayer(telegramId, gameId) {
  return prisma.gamePlayer.findUnique({
    where: {
      gameId_userId: { gameId: Number(gameId), userId: BigInt(telegramId) }
    },
    include: { cartela: true, game: true }
  });
}

const activeCallers = new Map();

export async function startGame(gameId) {
  const gid = Number(gameId);
  const game = await prisma.game.findUnique({
    where: { id: gid },
    include: { gamePlayers: true }
  });
  const status = game?.status;
  if (!game || (status !== 'waiting' && status !== 'countdown')) {
    throw new Error('Cannot start game');
  }

  await prisma.game.update({
    where: { id: gid },
    data: { status: 'playing', countdown: null, startedAt: new Date() }
  });

  startGameCaller(gid);
  return getGame(gameId);
}

export function startGameCaller(gameId) {
  if (activeCallers.has(gameId)) return;
  const testFirstFive = [2, 18, 54, 73, 13];
  const rest = [];
  for (let i = 1; i <= 75; i++) {
    if (!testFirstFive.includes(i)) rest.push(i);
  }
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const remaining = [...testFirstFive, ...rest];

  const drawNext = async () => {
    try {
      const g = await prisma.game.findUnique({
        where: { id: gameId },
        include: { gamePlayers: { include: { cartela: true, user: true } } }
      });
      const status = g?.status;
      if (!g || status !== 'playing') {
        clearInterval(interval);
        activeCallers.delete(gameId);
        return;
      }
      const called = Array.isArray(g.calledNumbers) ? g.calledNumbers : [];
      const next = remaining.find((n) => !called.includes(n));
      if (!next) {
        clearInterval(interval);
        activeCallers.delete(gameId);
        const { onGameEnded } = await import('./game-manager.js');
        await settleGame(gameId, null, 'No winner this round!');
        if (onGameEnded) onGameEnded(gameId, { winners: [], message: 'No winner this round!' });
        return;
      }
      const { onNumberDrawn } = await import('./game-manager.js');
      await callNumber(gameId, next);
      if (onNumberDrawn) onNumberDrawn(gameId, next);
    } catch (err) {
      console.error('Game caller error:', err);
      clearInterval(interval);
      activeCallers.delete(gameId);
    }
  };

  const interval = setInterval(drawNext, CALL_INTERVAL_MS);
  activeCallers.set(gameId, interval);
}

export async function callNumber(gameId, number) {
  const game = await prisma.game.findUnique({
    where: { id: Number(gameId) },
    include: { gamePlayers: { include: { cartela: true } } }
  });

  const status = game?.status;
  if (!game || status !== 'playing') throw new Error('Game not playing');

  const called = Array.isArray(game.calledNumbers) ? game.calledNumbers : [];
  if (called.includes(number)) throw new Error('Number already called');

  const newCalled = [...called, number];
  await prisma.game.update({
    where: { id: Number(gameId) },
    data: { calledNumbers: newCalled }
  });

  return { calledNumbers: newCalled };
}

/** Cartela is 5x5. Middle cell (N col, row 2) is null/free - always counts as marked.
 * Win if any of: diagonal1, diagonal2, any row, any column - all 5 positions marked or free.
 */
export function checkWinner(cartelaNumbers, calledNumbers) {
  const called = new Set(calledNumbers);
  const cols = ['B', 'I', 'N', 'G', 'O'];

  const isMarked = (val) => val == null || called.has(val);

  const getCell = (row, col) => cartelaNumbers[cols[col]][row];

  const checkLine = (positions) => positions.every(([r, c]) => isMarked(getCell(r, c)));

  const diagonals = [
    [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]],
    [[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]]
  ];
  if (diagonals.some((d) => checkLine(d))) return true;

  for (let row = 0; row < 5; row++) {
    if (checkLine([[row, 0], [row, 1], [row, 2], [row, 3], [row, 4]])) return true;
  }
  for (let col = 0; col < 5; col++) {
    if (checkLine([[0, col], [1, col], [2, col], [3, col], [4, col]])) return true;
  }
  return false;
}

export async function settleGame(gameId, winnerId, message = null) {
  const game = await prisma.game.findUnique({
    where: { id: Number(gameId) }
  });

  const status = game?.status;
  if (!game || status !== 'playing') {
    throw new Error('Cannot settle game');
  }

  const houseCut = Math.floor((game.totalPool * HOUSE_CUT_PERCENT) / 100);
  const winnerAmount = game.totalPool - houseCut;
  const winners = winnerId ? [String(winnerId)] : [];

  const updates = [
    prisma.game.update({
      where: { id: Number(gameId) },
      data: {
        status: 'ended',
        winnerId: winnerId ? BigInt(winnerId) : null,
        winnerAmount: winnerId ? winnerAmount : null,
        winners,
        houseCut,
        message,
        finishedAt: new Date()
      }
    })
  ];
  if (winnerId) {
    updates.push(
      prisma.user.update({
        where: { telegramId: BigInt(winnerId) },
        data: {
          balance: { increment: winnerAmount },
          wins: { increment: 1 }
        }
      })
    );
  }
  await prisma.$transaction(updates);
  // Do NOT create next game here - runWinnerCountdown will call startNewGame after the 10s countdown
  return getGame(gameId);
}
