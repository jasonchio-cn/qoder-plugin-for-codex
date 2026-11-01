#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceRoot = path.join(root, "dist", "marketplace");
const pluginRoot = path.join(marketplaceRoot, "plugins", "qoder");
const components = [".codex-plugin", "assets", "skills", "scripts", "LICENSE", "LICENSE-APACHE", "NOTICE", "CHANGELOG.md", "README.md"];

fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
fs.mkdirSync(pluginRoot, { recursive: true });
for (const component of components) {
  const source = path.join(root, component);
  if (!fs.existsSync(source)) throw new Error(`Missing build component: ${component}`);
  fs.cpSync(source, path.join(pluginRoot, component), { recursive: true });
}

const manifestFile = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
manifest.version = `${manifest.version.split("+")[0]}+codex.local-${stamp}`;
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

const marketplaceFile = path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
fs.mkdirSync(path.dirname(marketplaceFile), { recursive: true });
fs.writeFileSync(marketplaceFile, `${JSON.stringify({
  name: "qoder-local",
  interface: { displayName: "Qoder Plugin Local" },
  plugins: [{
    name: "qoder",
    source: { source: "local", path: "./plugins/qoder" },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" },
    category: "Developer Tools",
  }],
}, null, 2)}\n`);

console.log(`Built local marketplace: ${marketplaceRoot}`);
