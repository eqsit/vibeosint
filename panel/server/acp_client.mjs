// Minimal ACP (Agent Client Protocol) stdio client for Hermes — VibeOSINT panel engine.
// One AcpClient = one `hermes acp` child process + one ACP session.
// Protocol: line-delimited JSON-RPC 2.0 over stdio.
import { spawn } from "child_process";

const ACK_RES = [
  /Redirected the active turn with your correction\.?/i,
  /^⏩ Steer queued for the active turn:/i,
  /^Queued for the next turn\. \(\d+ queued\)$/i,
  /^No active turn — queued for the next turn\. \(\d+ queued\)$/i,
  /^⚠️ Steer failed:/i
];
const isAckText = (t) => ACK_RES.some((re) => re.test(String(t).trim()));
const DEBUG = process.env.PANEL_ACP_DEBUG === "1";

function extractText(content) {
  if (!content) return "";
  const arr = Array.isArray(content) ? content : [content];
  let out = "";
  for (const c of arr) {
    if (!c) continue;
    if (typeof c === "string") { out += c; continue; }
    if (typeof c.text === "string") out += c.text;
  }
  return out;
}

function extractToolTitle(upd) {
  let t = upd.title || upd.toolName || "";
  if (!t && upd.rawInput && typeof upd.rawInput === "object") {
    t = upd.rawInput.command || upd.rawInput.query || upd.rawInput.url || upd.rawInput.path || upd.rawInput.file_path || "";
  }
  return String(t || "").slice(0, 160);
}

export class AcpClient {
  constructor({ hermesBin, cwd, env, acceptHooks = true }) {
    this.hermesBin = hermesBin;
    this.cwd = cwd;
    this.env = env;
    this.acceptHooks = acceptHooks;
    this.proc = null;
    this.seq = 1;
    this.pending = new Map(); // id -> { resolve, reject }
    this.lineBuffer = "";
    this.sessionId = null;
    this.initialized = false;
    this.closed = false;
    this.current = null;      // active main-prompt entry { buffer }
    this.replaying = false;   // suppress callbacks during session/load replay
    this.onTool = null;       // (title, status) => void
    this.onExit = null;       // (code) => void
    this.lastErr = "";
    this.disposingProcs = new WeakSet();
  }

  isAlive() {
    return !!this.proc && !this.closed;
  }

  _log(...a) {
    try { console.log("[acp]", ...a); } catch (e) {}
  }

  _spawnProc() {
    const args = ["acp"];
    if (this.acceptHooks) args.push("--accept-hooks");
    this.proc = spawn(this.hermesBin, args, { cwd: this.cwd, env: this.env });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => {
      const lines = String(d).split("\n").map((l) => l.trim()).filter(Boolean);
      for (const l of lines) {
        if (DEBUG) { try { console.log("[acp-err]", l.slice(0, 220)); } catch (e) {} }
        if (/ERROR|Traceback|Startup failed/.test(l)) {
          this.lastErr = l.slice(0, 300);
          this._log("stderr:", l.slice(0, 200));
        }
      }
    });
    this.proc.on("close", (code) => {
      this.closed = true;
      const err = new Error(`hermes acp exited (code ${code})${this.lastErr ? `: ${this.lastErr}` : ""}`);
      for (const [, p] of this.pending) {
        try { p.reject(err); } catch (e) {}
      }
      this.pending.clear();
      if (this.onExit) { try { this.onExit(code); } catch (e) {} }
    });
    this.proc.on("error", (err) => {
      this.closed = true;
      this.lastErr = err.message;
      this._log("spawn error:", err.message);
    });
  }

  _onData(chunk) {
    this.lineBuffer += chunk;
    let idx;
    while ((idx = this.lineBuffer.indexOf("\n")) >= 0) {
      const line = this.lineBuffer.slice(0, idx).trim();
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return; }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) {
          const err = new Error(msg.error.message || "acp error");
          err.acpError = msg.error;
          p.reject(err);
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }

    // Server -> client requests: auto-approve tool permissions.
    if (msg.method === "session/request_permission") {
      const opts = (msg.params && msg.params.options) || [];
      let allow = null;
      for (const o of opts) {
        if (String((o && o.optionId) || "").startsWith("allow")) { allow = o.optionId; break; }
      }
      if (!allow && opts.length) allow = opts[0].optionId;
      this._send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow } } });
      return;
    }

    if (msg.method === "session/update") {
      const upd = (msg.params && msg.params.update) || {};
      const kind = upd.sessionUpdate;
      if (kind === "agent_message_chunk") {
        const text = extractText(upd.content);
        if (text) {
          if (isAckText(text)) {
            if (this.followupDelivery) this.followupDelivery.ack = text;
            if (DEBUG) { try { console.log("[acp] ack-strip:", String(text).slice(0, 120)); } catch (e) {} }
            return; // служебный ack (redirect/steer/queue) — в финальный текст не берём
          }
          if (this.current) this.current.buffer += text;
        }
        return;
      }
      if (kind === "tool_call" || kind === "tool_call_update") {
        const title = extractToolTitle(upd);
        if (title && this.onTool && !this.replaying) {
          try { this.onTool(title, upd.status || ""); } catch (e) {}
        }
        return;
      }
      return;
    }
    // остальные уведомления игнорируем
  }

  _send(obj) {
    if (!this.proc || this.closed) return false;
    try { this.proc.stdin.write(JSON.stringify(obj) + "\n"); return true; } catch (e) { return false; }
  }

  _request(method, params, { timeoutMs = 0 } = {}) {
    if (!this.isAlive()) return Promise.reject(new Error("acp process not running"));
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      let timer = null;
      const entry = {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      };
      this.pending.set(id, entry);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            entry.reject(new Error(`acp timeout: ${method} (${timeoutMs}ms)`));
          }
        }, timeoutMs);
      }
      const ok = this._send({ jsonrpc: "2.0", id, method, params });
      if (!ok) {
        this.pending.delete(id);
        entry.reject(new Error("acp process not running"));
      }
    });
  }

  async start({ timeoutMs = 90000 } = {}) {
    if (this.isAlive() && this.initialized) return;
    this.closed = false;
    this.initialized = false;
    this._spawnProc();
    await this._request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "vibeosint-panel", version: "5.0" }
    }, { timeoutMs });
    this.initialized = true;
  }

  async newSession() {
    const res = await this._request("session/new", { cwd: this.cwd, mcpServers: [] }, { timeoutMs: 90000 });
    this.sessionId = (res && res.sessionId) || null;
    return this.sessionId;
  }

  async loadSession(sessionId) {
    try {
      this.replaying = true;
      const res = await this._request("session/load", { cwd: this.cwd, sessionId, mcpServers: [] }, { timeoutMs: 90000 });
      this.replaying = false;
      if (res !== null && res !== undefined) { this.sessionId = sessionId; return true; }
      return false;
    } catch (e) {
      this.replaying = false;
      return false;
    }
  }

  async setModel(modelId) {
    if (!modelId || !this.sessionId) return false;
    try {
      await this._request("session/set_model", { sessionId: this.sessionId, modelId }, { timeoutMs: 60000 });
      return true;
    } catch (e) {
      this._log("setModel failed:", String(e.message || e).slice(0, 160));
      return false;
    }
  }

  // Main run: full prompt. Resolves when the turn completes (all redirects/queued included).
  async promptText(text, { onTool } = {}) {
    if (onTool) this.onTool = onTool;
    const entry = { buffer: "" };
    this.current = entry;
    try {
      const res = await this._request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }]
      });
      return { stopReason: (res && res.stopReason) || "", usage: (res && res.usage) || null, text: entry.buffer };
    } finally {
      if (this.current === entry) this.current = null;
    }
  }

  // Follow-up while a run is active: require the native active-turn steer ACK.
  // RPC completion or a queue-only/idle reply does not prove delivery.
  async followupText(text, { isActive } = {}) {
    // Ack notifications have no request id. Only one follow-up may own them.
    const send = async () => {
      // The turn may end while a preceding follow-up owns the ack channel.
      if (isActive && (!this.current || !isActive())) return { inactive: true };
      const entry = { ack: "" };
      this.followupDelivery = entry;
      try {
        const res = await this._request("session/prompt", {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text }]
        });
        // Native gateway_commands._steer emits this ACK only after active-turn
        // acceptance. An idle /steer can instead run a prompt and return end_turn.
        if (res?.stopReason === "cancelled") throw new Error("Доставка уточнения отменена (ACP)");
        if (!/^⏩ Steer queued for the active turn:/i.test(entry.ack.trim())) {
          throw new Error(entry.ack || "ACP не подтвердил доставку уточнения в активный ход");
        }
        return { stopReason: (res && res.stopReason) || "" };
      } finally {
        if (this.followupDelivery === entry) this.followupDelivery = null;
      }
    };
    // Preserve immediate first-request registration (including dispose safety).
    const delivery = this.followupTail ? this.followupTail.catch(() => {}).then(send) : send();
    this.followupTail = delivery;
    return delivery;
  }

  // Native cancel (hard interrupt of the running turn).
  cancel() {
    if (!this.sessionId) return false;
    return this._send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
  }

  dispose() {
    this.closed = true;
    const error = new Error("acp client disposed");
    for (const [, pending] of this.pending) pending.reject(error);
    this.pending.clear();
    // Capture this exact child. Never signal a process group or a replacement
    // child via this.proc from a delayed callback.
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null || this.disposingProcs.has(proc)) return;
    this.disposingProcs.add(proc);
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill("SIGKILL"); } catch (e) {}
      }
    }, 1000);
    timer.unref();
    proc.once("exit", () => clearTimeout(timer));
    try { proc.kill("SIGTERM"); } catch (e) {}
  }
}
