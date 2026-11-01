import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();

test("plugin is skills-only and exposes all user capabilities", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
  const packageManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "qoder");
  assert.equal(manifest.version, packageManifest.version);
  assert.equal(manifest.skills, "./skills/");
  assert.equal("mcpServers" in manifest, false);
  assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false);
  assert.equal(fs.existsSync(path.join(root, ".claude-plugin")), false);
  assert.equal(fs.existsSync(path.join(root, ".qoder-plugin")), false);

  for (const skill of ["task", "review", "jobs", "transfer", "setup"]) {
    const skillFile = path.join(root, "skills", skill, "SKILL.md");
    assert.ok(fs.existsSync(skillFile), `${skill} must exist`);
    const text = fs.readFileSync(skillFile, "utf8");
    assert.match(text, new RegExp(`name: ${skill}`));
    assert.match(text, /qoder-companion\.mjs/);
  }
});

test("validator rejects a package and manifest version mismatch", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-plugin-version-"));
  try {
    fs.cpSync(root, temporary, {
      recursive: true,
      filter: (file) => !["dist", "node_modules"].includes(path.basename(file)) && !path.basename(file).startsWith(".test-"),
    });
    const manifestFile = path.join(temporary, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    manifest.version = "999.0.0";
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [path.join(temporary, "scripts", "validate-plugin.mjs")], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest and package versions must match/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("package includes the referenced icons and setup skill", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-plugin-pack-"));
  try {
    const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      shell: process.platform === "win32",
      cwd: root,
      env: { ...process.env, npm_config_cache: temporary },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || String(result.error || "npm pack failed"));
    const packed = JSON.parse(result.stdout);
    const packageInfo = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
    const files = new Set(packageInfo.files.map((file) => file.path));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
    for (const resource of [
      manifest.interface.logo,
      manifest.interface.composerIcon,
      manifest.extensions["com.openai"].onboardingSkill,
    ]) {
      assert.ok(resource.startsWith("./"));
      assert.ok(files.has(resource.slice(2)), `missing from package: ${resource}`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("local marketplace build includes referenced icons", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-plugin-build-"));
  try {
    fs.cpSync(root, temporary, {
      recursive: true,
      filter: (file) => !["dist", "node_modules"].includes(path.basename(file)) && !path.basename(file).startsWith(".test-"),
    });
    const result = spawnSync(process.execPath, [path.join(temporary, "scripts", "build-plugin.mjs")], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const plugin = path.join(temporary, "dist", "marketplace", "plugins", "qoder");
    const manifest = JSON.parse(fs.readFileSync(path.join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
    for (const resource of [manifest.interface.logo, manifest.interface.composerIcon]) {
      assert.ok(resource.startsWith("./"));
      assert.ok(fs.existsSync(path.join(plugin, resource)));
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
