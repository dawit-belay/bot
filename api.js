import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { parse, validate } from '@tma.js/init-data-node';
import { getUser, addDeposit, getBalance, canPlay } from './storage.js';
import {
  getCartelas,
  getOrCreateWaitingGame,
  getCurrentGame,
  getGame,
  joinGame,
  getUserGamePlayer,
  settleGame,
  checkWinner,
  prisma,
} from './game.js';
import {
  setBroadcast,
  getCurrentSharedState,
  getSharedGameState,
  handlePlayerJoined,
  runWinnerCountdown,
} from './game-manager.js';

const STAKE = 10;
const HOUSE_CUT_PERCENT = 10;

function computeDerash(totalPool) {
  const houseCut = Math.floor((totalPool * HOUSE_CUT_PERCENT) / 100);
  return totalPool - houseCut;
}

async function buildGameResponse(game, player) {
  let winnerName = null;
  if (game.winnerId) {
    const winner = await prisma.user.findUnique({ where: { telegramId: game.winnerId } });
    winnerName = winner?.name ?? 'Winner';
  }
  const takenCartelaIds = (game.gamePlayers || []).map((gp) => gp.cartelaId);
  const status = game.status;
  return {
    game: {
      id: game.id,
      status,
      phase: status,
      totalPool: game.totalPool,
      playerCount: game.playerCount,
      calledNumbers: game.calledNumbers || [],
      drawnNumbers: game.calledNumbers || [],
      countdown: game.countdown ?? null,
      winnerId: game.winnerId ? Number(game.winnerId) : null,
      winnerAmount: game.winnerAmount,
      winnerName,
      winners: Array.isArray(game.winners) ? game.winners : (game.winnerId ? [String(game.winnerId)] : []),
      message: game.message ?? null,
      derash: computeDerash(game.totalPool || 0),
      createdAt: game.createdAt,
      takenCartelaIds,
    },
    myPlayer: player ? { cartelaId: player.cartelaId, cartela: player.cartela } : null,
  };
}

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;

function validateAndParse(rawInitData) {
  if (!rawInitData || !BOT_TOKEN) return null;
  try {
    validate(rawInitData, BOT_TOKEN, { expiresIn: 86400 });
    return parse(rawInitData);
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const raw = req.headers['x-telegram-init-data'] || req.query.initData;
  const initData = validateAndParse(raw);
  if (!initData || !initData.user) {
    return res.status(401).json({ error: 'Invalid or missing init data' });
  }
  req.telegramUser = initData.user;
  req.userId = initData.user.id;
  next();
}

function registeredMiddleware(req, res, next) {
  getUser(req.userId).then((user) => {
    if (!user) {
      return res.status(403).json({ error: 'Register via bot first. Send /start to @Fun_bingo_bot' });
    }
    req.user = user;
    next();
  }).catch(next);
}

// ─── Minimal REST API ───────────────────────────────────────────────────────

app.get('/api/me', authMiddleware, registeredMiddleware, async (req, res) => {
  try {
    const u = req.user;
    res.json({
      id: Number(u.telegramId),
      username: u.username ?? `user_${u.telegramId}`,
      name: u.name,
      balance: u.balance ?? 0,
      wins: u.wins ?? 0,
    });
  } catch (err) {
    console.error('GET /api/me', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

app.get('/api/balance', authMiddleware, registeredMiddleware, async (req, res) => {
  try {
    const balance = await getBalance(req.userId);
    res.json({ balance });
  } catch (err) {
    console.error('GET /api/balance', err);
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

app.post('/api/deposit', authMiddleware, registeredMiddleware, async (req, res) => {
  const amount = Number(req.body?.amount) || 100;
  if (amount <= 0 || amount > 10000) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  try {
    const balance = await addDeposit(req.userId, amount);
    res.json({ balance, deposited: amount });
  } catch (err) {
    console.error('POST /api/deposit', err);
    res.status(500).json({ error: 'Failed to deposit' });
  }
});

app.get('/api/cartelas', authMiddleware, registeredMiddleware, async (req, res) => {
  try {
    const cartelas = await getCartelas();
    res.json(cartelas.map((c) => ({ id: c.id, numbers: c.numbers })));
  } catch (err) {
    console.error('GET /api/cartelas', err);
    res.status(500).json({ error: 'Failed to get cartelas' });
  }
});

app.get('/api/game/current', authMiddleware, registeredMiddleware, async (req, res) => {
  try {
    const game = await getCurrentGame();
    const player = await getUserGamePlayer(req.userId, game.id);
    res.json(await buildGameResponse(game, player));
  } catch (err) {
    console.error('GET /api/game/current', err);
    res.status(500).json({ error: 'Failed to get game' });
  }
});

// POST /api/game/join – the only user-triggered API for game (cartela selection)
app.post('/api/game/join', authMiddleware, registeredMiddleware, async (req, res) => {
  const { gameId, cartelaId } = req.body;
  if (!gameId || !cartelaId) {
    return res.status(400).json({ error: 'gameId and cartelaId required' });
  }
  try {
    await joinGame(req.userId, gameId, cartelaId);
    let game = await getGame(gameId);
    await handlePlayerJoined(game.id);
    game = await getGame(gameId);
    const player = await getUserGamePlayer(req.userId, game.id);
    res.json(await buildGameResponse(game, player));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/can-play', authMiddleware, registeredMiddleware, async (req, res) => {
  try {
    const ok = await canPlay(req.userId);
    res.json({ canPlay: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Socket.io Server ───────────────────────────────────────────────────────

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  path: '/ws',
});

const GLOBAL_ROOM = 'global-game-room';

function broadcast(event, payload) {
  io.to(GLOBAL_ROOM).emit(event, payload);
}

setBroadcast(broadcast);

io.use((socket, next) => {
  const initData = socket.handshake.auth?.initData || socket.handshake.query?.initData;
  const parsed = validateAndParse(initData);
  if (!parsed?.user) {
    return next(new Error('Invalid or missing init data'));
  }
  socket.userId = parsed.user.id;
  next();
});

io.on('connection', async (socket) => {
  const userId = socket.userId;
  socket.join(GLOBAL_ROOM);

  // Send current full state on connect (for reconnection)
  try {
    const state = await getCurrentSharedState();
    socket.emit('game-state-update', state);
  } catch (err) {
    console.error('WS connect: failed to send initial state', err);
  }

  socket.on('claim', async (payload, ack) => {
    const { gameId } = payload || {};
    if (!gameId) {
      ack?.({ ok: false, error: 'gameId required' });
      return;
    }
    try {
      const game = await getGame(gameId);
      if (!game || game.status !== 'playing') {
        ack?.({ ok: false, error: 'Game is not playing' });
        return;
      }
      if (game.winnerId) {
        ack?.({ ok: false, error: 'Game already finished' });
        return;
      }

      const player = await getUserGamePlayer(userId, game.id);
      if (!player) {
        ack?.({ ok: false, error: 'You are not in this game' });
        return;
      }

      const calledNumbers = game.calledNumbers || [];
      if (!checkWinner(player.cartela.numbers, calledNumbers)) {
        ack?.({ ok: false, error: 'Not a valid bingo' });
        return;
      }

      await settleGame(gameId, Number(userId));
      const updated = await getGame(gameId);
      const winner = await prisma.user.findUnique({ where: { telegramId: updated.winnerId } });
      const winnerCountdownSeconds = 10;
      const winnerPlayer = updated.gamePlayers?.find(
        (gp) => Number(gp.userId) === Number(userId)
      );
      const winnerCartela = winnerPlayer?.cartela?.numbers ?? null;
      const winnerCartelaId = winnerPlayer?.cartelaId ?? null;

      const winnerName = winner?.name ?? 'Winner';
      const sharedState = getSharedGameState(updated);
      broadcast('game-end', {
        gameId,
        winners: [String(userId)],
        winnerId: Number(userId),
        winnerName,
        winnerAmount: updated.winnerAmount,
        winnerCartela,
        winnerCartelaId,
        state: { ...sharedState, winnerName },
        winnerCountdown: winnerCountdownSeconds,
      });
      broadcast('game-state-update', getSharedGameState(updated));
      runWinnerCountdown(gameId);

      ack?.({ ok: true, won: true });
    } catch (err) {
      ack?.({ ok: false, error: err.message });
    }
  });

  socket.on('disconnect', () => {
    // User left; no need to remove from game - they stay in until round ends
  });
});

export function startApi(port) {
  server.listen(port, '0.0.0.0');
  return server;
}
