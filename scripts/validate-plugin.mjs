#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const manifestFile = path.join(root, ".codex-plugin", "plugin.json");
const packageFile = path.join(root, "package.json");
let manifest;
let packageManifest;
try { manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch (error) { errors.push(`manifest: ${error.message}`); }
try { packageManifest = JSON.parse(fs.readFileSync(packageFile, "utf8")); } catch (error) { errors.push(`package: ${error.message}`); }

if (manifest) {
  for (const field of ["name", "version", "description", "author", "skills", "interface"]) {
    if (!manifest[field]) errors.push(`manifest missing ${field}`);
  }
  if (manifest.name !== "qoder") errors.push("manifest name must be qoder");
  if (packageManifest && packageManifest.name !== "qoder-plugin-for-codex") errors.push("unexpected package name");
  if (packageManifest && manifest.version !== packageManifest.version) errors.push("manifest and package versions must match");
  if (manifest.mcpServers) errors.push("MCP is outside this plugin's architecture");
}
if (fs.existsSync(path.join(root, ".mcp.json"))) errors.push("unexpected .mcp.json");
if (!fs.existsSync(path.join(root, "scripts", "qoder-companion.mjs"))) errors.push("missing runtime script");

for (const skill of ["task", "review", "jobs", "transfer", "setup"]) {
  const file = path.join(root, "skills", skill, "SKILL.md");
  if (!fs.existsSync(file)) {
    errors.push(`missing skill ${skill}`);
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  if (!text.startsWith("---\n") || !text.includes(`\nname: ${skill}\n`) || !text.includes("\ndescription: Use when")) {
    errors.push(`invalid frontmatter for ${skill}`);
  }
}

if (errors.length) {
  console.error(["Plugin validation failed:", ...errors.map((error) => `- ${error}`)].join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Plugin validation passed: ${root}`);
}
