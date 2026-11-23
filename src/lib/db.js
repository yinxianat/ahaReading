import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const globalForPrisma = globalThis;

// pg's defaults wait forever for a connection or a query. With a blackholed database
// every route would hang instead of returning the 500/503 the error paths are built for.
export const POOL_OPTIONS = Object.freeze({
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  max: 10,
  statement_timeout: 10_000, // server side: Postgres cancels the statement
  query_timeout: 12_000, // client side: covers a server that stops answering entirely
});

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, ...POOL_OPTIONS });
  return new PrismaClient({ adapter });
}

/** Prisma client singleton (reused across hot reloads in development). */
const prisma = globalForPrisma.prisma ?? createPrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
