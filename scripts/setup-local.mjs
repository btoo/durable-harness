import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const filename = process.argv.includes("--deployed") ? ".dev.vars.deployed" : ".dev.vars";
const project = process.argv.includes("--mcp-fixture") ? "mcp-fixture" : "demo";
const target = new URL(`../apps/${project}/${filename}`, import.meta.url);
try {
  await writeFile(
    target,
    project === "mcp-fixture"
      ? `TEST_CONTROL_TOKEN=${randomBytes(32).toString("hex")}\n`
      : `SESSION_SECRET=${randomBytes(32).toString("hex")}\nCREDENTIAL_KEY=${randomBytes(32).toString("base64")}\nADMIN_TOKEN=${randomBytes(32).toString("hex")}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(`Created secrets in apps/${project}/${filename} (excluded from Git).`);
} catch (error) {
  if (error.code === "EEXIST") console.log("Existing local secrets retained.");
  else throw error;
}
