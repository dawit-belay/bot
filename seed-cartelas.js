import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const STAKE = 10;

function generateCartela() {
  const cols = [
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
    [31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45],
    [46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60],
    [61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75]
  ];
  const pick = (arr, n) => {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n).sort((a, b) => a - b);
  };
  const grid = cols.map((col) => pick(col, 5));
  const nCol = [...grid[2]];
  nCol[2] = null;
  return {
    B: grid[0],
    I: grid[1],
    N: nCol,
    G: grid[3],
    O: grid[4]
  };
}

async function main() {
  const count = await prisma.cartela.count();
  if (count >= 10) {
    console.log('Cartelas already seeded.');
    return;
  }
  await prisma.cartela.deleteMany({});
  for (let i = 0; i < 10; i++) {
    await prisma.cartela.create({
      data: { numbers: generateCartela() }
    });
  }
  console.log('Seeded 10 cartelas.');
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
