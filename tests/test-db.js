/**
 * Prisma client for the DB-backed suites. Re-checks the guard itself, so it stays safe
 * even if a suite is run with a different setup file.
 * Usage: vi.mock("@/lib/db.js", async () => ({ default: (await import("./test-db.js")).createTestPrisma() }));
 */
import { testDatabaseProblem } from "./test-db-guard.js";

/** @returns {Promise<import("../src/generated/prisma/client").PrismaClient>} */
export async function createTestPrisma() {
  const problem = testDatabaseProblem({
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    DATABASE_URL: process.env.ORIGINAL_DATABASE_URL,
  });
  if (problem) throw new Error(`Refusing to connect: ${problem}`);
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { PrismaClient } = await import("../src/generated/prisma/client");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
}
