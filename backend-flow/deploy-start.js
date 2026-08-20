import { execSync } from "child_process";

console.log("[deploy] Running database migrations...");
try {
  execSync("npx prisma migrate deploy", { stdio: "inherit" });
  console.log("[deploy] Migrations applied successfully.");
} catch (err) {
  console.error("[deploy] FATAL: prisma migrate deploy failed. Aborting server start.");
  console.error(err?.message || err);
  process.exit(1);
}

console.log("[deploy] Starting server...");
try {
  execSync("node server.js", { stdio: "inherit" });
} catch (err) {
  console.error("[deploy] Server exited with error:", err?.message || err);
  process.exit(err?.status || 1);
}
