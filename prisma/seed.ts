import bcrypt from "bcryptjs";
import { prisma } from "../src/server/db";

async function main() {
  const email = (process.env.URIEL_OPERATOR_EMAIL ?? "operator@uriel.local").toLowerCase();
  const password = process.env.URIEL_OPERATOR_PASSWORD;
  if (!password) throw new Error("Set URIEL_OPERATOR_PASSWORD before seeding.");

  await prisma.user.deleteMany();
  const user = await prisma.user.create({
    data: {
      email,
      name: "Operator",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });

  const cashCents = 100_000;
  await prisma.account.create({
    data: {
      userId: user.id,
      mode: "PAPER",
      demo: true,
      cashCents,
      equityCents: cashCents,
      peakEquityCents: cashCents,
      dayStartEquityCents: cashCents,
      weekStartEquityCents: cashCents,
      baselineSpyShares: 0,
      bookResetAt: new Date(),
    },
  });

  console.log(`Seeded ${email}. Equity $${(cashCents / 100).toFixed(2)}.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
