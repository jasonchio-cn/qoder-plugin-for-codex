import { spawn } from "node:child_process";
import readline from "node:readline";

function protocolError(message, payload) {
  const error = new Error(message);
  error.rpcCode = payload?.code;
  error.data = payload?.data;
  return error;
}

export class CodexAppServerClient {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.stderr = "";
    this.notificationHandler = null;
  }

  static async connect(cwd, options = {}) {
    const client = new CodexAppServerClient(cwd, options);
    await client.initialize();
    return client;
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  request(method, params = {}) {
    if (this.closed) throw new Error("codex app-server client is closed");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (!this.closed) this.send({ method, params });
  }

  async initialize() {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-64 * 1024); });
    this.proc.on("error", (error) => this.failAll(error));
    this.proc.on("close", (code) => {
      if (!this.closed && code !== 0) this.failAll(new Error(this.stderr.trim() || `codex app-server exited with ${code}`));
    });
    const lines = readline.createInterface({ input: this.proc.stdout });
    lines.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: { name: "qoder-plugin-for-codex", title: "Qoder Plugin for Codex", version: "0.1.0" },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/summaryPartAdded",
          "item/reasoning/textDelta",
        ],
      },
    });
    this.notify("initialized", {});
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch (error) {
      this.failAll(new Error(`Invalid codex app-server JSONL: ${error.message}`));
      return;
    }
    if (message.id !== undefined && message.method) {
      this.send({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(protocolError(message.error.message ?? `${pending.method} failed`, message.error));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method) this.notificationHandler?.(message);
  }

  send(message) {
    if (!this.proc?.stdin) throw new Error("codex app-server stdin unavailable");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.proc?.stdin?.end();
    await new Promise((resolve) => {
      if (!this.proc || this.proc.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        this.proc.kill("SIGTERM");
        resolve();
      }, 1_000);
      timer.unref?.();
      this.proc.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
}
