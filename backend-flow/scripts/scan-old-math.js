import { spawnSync } from "node:child_process";

const patterns = [
  "student\\.fee",
  "student\\.paid",
  "\\bs\\.fee\\b",
  "\\bs\\.paid\\b",
  "\\bst\\.fee\\b",
  "\\bst\\.paid\\b",
  "paid\\s*[<>]=?\\s*fee",
  "fee\\s*-\\s*paid",
  "\\.paid\\s*\\+=",
  "\\.paid\\s*=",
];

const args = [
  "-n",
  "-S",
  "-e",
  patterns.join("|"),
  "--glob",
  "!node_modules/**",
  "--glob",
  "!dist/**",
  "--glob",
  "!build/**",
  "--glob",
  "!coverage/**",
  ".",
];

const result = spawnSync("rg", args, { cwd: new URL("..", import.meta.url), encoding: "utf8" });

if (result.error?.code === "ENOENT") {
  console.error("ledger:scan-old-math requires ripgrep (rg) to be installed.");
  process.exit(1);
}

if (result.stdout.trim()) {
  console.log(result.stdout.trim());
} else {
  console.log("No old fee/paid math patterns found.");
}

if (result.stderr.trim()) console.error(result.stderr.trim());
process.exit(result.status === 2 ? 2 : 0);
