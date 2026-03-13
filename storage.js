import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function initStorage() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.error('Failed to connect to database:', err);
    throw err;
  }
}

export async function getUserOrCreate(telegramId, username, firstName) {
  const id = BigInt(telegramId);
  let user = await prisma.user.findUnique({ where: { telegramId: id } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        telegramId: id,
        username: username ?? `user_${telegramId}`,
        name: firstName || 'Player'
      }
    });
  } else if (username != null || firstName != null) {
    user = await prisma.user.update({
      where: { telegramId: id },
      data: {
        ...(username != null && { username }),
        ...(firstName != null && { name: firstName })
      }
    });
  }
  return user;
}

export async function getUser(telegramId) {
  return prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) }
  });
}

export async function addDeposit(telegramId, amount) {
  const id = BigInt(telegramId);
  const user = await getUserOrCreate(telegramId, null, null);
  const updated = await prisma.user.update({
    where: { telegramId: id },
    data: {
      balance: { increment: amount }
    }
  });
  await prisma.deposit.create({
    data: { userId: id, amount }
  });
  return updated.balance;
}

export async function getBalance(telegramId) {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) }
  });
  return user ? user.balance : 0;
}

const STAKE = 10;

export async function canPlay(telegramId) {
  const balance = await getBalance(telegramId);
  return balance >= STAKE;
}

export const registerUser = getUserOrCreate;

export async function deductBalance(telegramId, amount) {
  const id = BigInt(telegramId);
  const user = await prisma.user.findUnique({ where: { telegramId: id } });
  if (!user || user.balance < amount) return false;
  await prisma.user.update({
    where: { telegramId: id },
    data: { balance: { decrement: amount } }
  });
  return true;
}
