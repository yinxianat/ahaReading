import { defineConfig } from "prisma/config";

// Node's built-in .env loader instead of dotenv (a devDependency): Railway's preDeployCommand
// runs `prisma migrate deploy` and must not depend on devDependencies surviving the build.
// No .env on Railway is expected; real variables are already in process.env and are not overridden.
try {
  process.loadEnvFile();
} catch {
  // no .env file
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL },
});
