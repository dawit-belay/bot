import 'dotenv/config';
console.log('[1/5] Starting...');
import { Telegraf } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { startApi } from './api.js';
import { initStorage, getUser, registerUser, addDeposit, getBalance } from './storage.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
//const MINI_APP_URL = process.env.MINI_APP_URL || 'https://your-mini-app-url.com';
//const MINI_APP_URL = 'https://mini-app-next-tau.vercel.app/';
const MINI_APP_URL = 'https://wsacollege.com/mini-app/';
const PROXY = process.env.TELEGRAM_PROXY || process.env.HTTPS_PROXY;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required. Create .env file with BOT_TOKEN=your_bot_token');
  process.exit(1);
}

let bot;
let apiServer;

function buildTelegramOpts() {
  const opts = {};
  if (PROXY) {
    opts.telegram = { agent: new HttpsProxyAgent(PROXY), attachmentAgent: new HttpsProxyAgent(PROXY) };
  }
  return opts;
}

const TELEGRAM_TIMEOUT_MS = 15000;

async function launchBotWithRetry(maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Telegram connection timeout (15s). VPN/proxy may not be working.')), TELEGRAM_TIMEOUT_MS)
      );
      await Promise.race([
        bot.telegram.deleteWebhook({ drop_pending_updates: false }),
        timeoutPromise
      ]);
      await Promise.race([bot.launch(), timeoutPromise]);
      return;
    } catch (err) {
      const is409 = err?.response?.error_code === 409 || err?.message?.includes('409');
      const isNetworkErr = err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET' || err?.code === 'ENOTFOUND' || err?.errno === 'ETIMEDOUT';
      if ((is409 || isNetworkErr) && attempt < maxRetries) {
        const delay = Math.min(5000 * attempt, 30000);
        const msg = isNetworkErr ? 'Network timeout connecting to Telegram. Retrying' : 'Conflict (409): another instance may be running. Retrying';
        console.warn(`⚠️ ${msg} in ${delay / 1000}s (${attempt}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

async function main() {
  console.log('[2/5] Connecting to database...');
  await initStorage();
  console.log('[3/5] Database OK. Starting API & bot...');
  bot = new Telegraf(BOT_TOKEN, buildTelegramOpts());

function getMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🎮 Play-10', web_app: { url: MINI_APP_URL } }],
      [
        { text: '🏦 Check Balance', callback_data: 'balance' },
        { text: '💰 Deposit', callback_data: 'deposit' }
      ],
      [
        { text: '🏢 Contact Support', callback_data: 'support' },
        { text: '📖 Instruction', callback_data: 'instruction' }
      ],
      [
        { text: '😢 Withdraw', callback_data: 'withdraw' },
        { text: '🔗 Invite', callback_data: 'invite' }
      ]
    ]
  };
}

// Handle /start - check registration, show menu or ask to register
bot.start(async (ctx) => {
  const user = await getUser(ctx.from.id);

  if (user) {
    const welcomeText = `👋 Welcome to FUN Bingo! Choose an Option below.`;
    await ctx.reply(welcomeText, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
    return;
  }

  const registerText = `👋 Welcome! You're not registered yet.\n\nRegister to play Fun Bingo and get <b>100 birr</b> to start. Would you like to register?`;
  await ctx.reply(registerText, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Yes, Register', callback_data: 'register_confirm' }],
        [{ text: '❌ Cancel', callback_data: 'register_cancel' }]
      ]
    }
  });
});

// Handle callback queries
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from.id;

  switch (data) {
    case 'register_confirm': {
      await ctx.answerCbQuery();
      await registerUser(userId, ctx.from.username, ctx.from.first_name);
      const welcomeText = `✅ Registered! You have 100 birr to start.\n\n👋 Welcome to FUN Bingo! Choose an Option below.`;
      await ctx.reply(welcomeText, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
      break;
    }
    case 'register_cancel': {
      await ctx.answerCbQuery();
      await ctx.reply('You need to register to use the bot. Send /start when you\'re ready.');
      break;
    }
    case 'balance': {
      const balance = await getBalance(userId);
      await ctx.answerCbQuery();
      await ctx.reply(`💰 Your balance: <b>${balance}</b>`, { parse_mode: 'HTML' });
      break;
    }
    case 'deposit': {
      await ctx.answerCbQuery();
      await addDeposit(userId, 100);
      await ctx.reply('✅ <b>Dummy deposit successful!</b>\nAdded 100 to your wallet.', { parse_mode: 'HTML' });
      break;
    }
    case 'support':
      await ctx.answerCbQuery('Contact: @Fun_bingo_support');
      await ctx.reply('Contact: @Fun_bingo_support');
      break;
    case 'instruction':
      await ctx.answerCbQuery('Instructions: Click Play-10 to join a game. Match numbers to win!');
      await ctx.reply('Instructions: Click Play-10 to join a game. Match numbers to win!');
      break;
    case 'withdraw':
      await ctx.answerCbQuery('Withdraw feature coming soon.');
      await ctx.reply('Withdraw feature coming soon.');
      break;
    case 'invite':
      await ctx.answerCbQuery(`Invite friends: t.me/${ctx.botInfo.username}?start=ref_${userId}`);
      await ctx.reply(`Invite friends: t.me/${ctx.botInfo.username}?start=ref_${userId}`);
      break;
    default:
      await ctx.answerCbQuery();
  }
});

// Start API server (separate from bot - for mini-app API calls)
const API_PORT = process.env.API_PORT || process.env.PORT || 8080;
apiServer = startApi(API_PORT);
console.log('[4/5] API started. Connecting to Telegram...');

await launchBotWithRetry();
console.log('[5/5] 🤖 Bot running');
console.log(`📡 API running on port ${API_PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

function shutdown(signal) {
  return async () => {
    if (apiServer) {
      await new Promise((res) => apiServer.close(res));
    }
    if (bot) {
      await bot.stop(signal);
    }
    process.exit(0);
  };
}
process.once('SIGINT', () => shutdown('SIGINT')());
process.once('SIGTERM', () => shutdown('SIGTERM')());
