const obsidian = require("obsidian");
const { spawn } = require("child_process");
const readline = require("readline");
const crypto = require("crypto");
const zlib = require("zlib");
const {
  Plugin,
  PluginSettingTab,
  Setting,
  ItemView,
  Notice,
  TFile,
  setIcon,
  MarkdownRenderer
} = obsidian;

const VIEW_TYPE_OSINT = "osint-canvas-chat-view";

function findHermesBinary() {
  try {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const homeDir = os.homedir();
    const isWin = process.platform === "win32";

    const candidates = isWin ? [
      path.join(homeDir, ".hermes", "bin", "hermes.exe"),
      path.join(homeDir, ".hermes", "hermes-agent", "venv", "Scripts", "hermes.exe"),
      path.join(homeDir, ".local", "bin", "hermes.exe"),
      path.join(homeDir, "AppData", "Local", "Programs", "Python", "Python312", "Scripts", "hermes.exe"),
      path.join(homeDir, "AppData", "Local", "Programs", "Python", "Python311", "Scripts", "hermes.exe"),
    ] : [
      path.join(homeDir, ".local", "bin", "hermes"),
      path.join(homeDir, ".hermes", "hermes-agent", "venv", "bin", "hermes"),
      path.join(homeDir, ".hermes", "bin", "hermes"),
      "/usr/local/bin/hermes",
      "/usr/bin/hermes"
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  } catch (e) {}
  return process.platform === "win32" ? "hermes.exe" : "hermes";
}

function parseAcpArguments(value) {
  let args;
  try { args = JSON.parse(value || '["acp"]'); }
  catch (_) { throw new Error('Аргументы ACP должны быть JSON-массивом, например ["acp"].'); }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("Аргументы ACP должны быть массивом строк без нулевых байтов.");
  }
  return args;
}

function parseAcpEnvironment(value) {
  let env;
  try { env = JSON.parse(value || "{}"); }
  catch (_) { throw new Error('Окружение ACP должно быть JSON-объектом, например {"HERMES_HOME":"/home/user/.hermes"}.'); }
  if (!env || Array.isArray(env) || typeof env !== "object" || Object.entries(env).some(
    ([key, val]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof val !== "string" || val.includes("\0")
  )) throw new Error("Переменные окружения: допустимые имена и строковые значения.");
  return env;
}

function quoteAcpShell(value) {
  if (value.includes("\0")) throw new Error("Недопустимый нулевой байт в команде.");
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function expandAcpHome(value) {
  if (value === "~") return require("os").homedir();
  return value.replace(/^~[/\\]/, require("os").homedir() + require("path").sep);
}

function buildAcpLaunch(settings, vaultPath) {
  const path = require("path");
  const home = require("os").homedir();
  const transport = settings.acpTransport || "local";
  const args = parseAcpArguments(settings.acpArgs);
  const overrides = parseAcpEnvironment(settings.acpEnv);
  const env = { ...process.env, PATH: [path.join(home, ".local", "bin"),
    path.join(home, ".hermes", "bin"), process.env.PATH || ""].join(path.delimiter) };
  let command = (settings.acpCommand || "").trim();
  let cwd = (settings.acpCwd || "").trim();
  if (transport === "ssh") {
    const host = (settings.acpSshHost || "").trim();
    if (!host || host.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(host)) {
      throw new Error("Укажите SSH-хост: user@server или алиас из ~/.ssh/config.");
    }
    const port = String(settings.acpSshPort || "").trim();
    if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      throw new Error("SSH-порт должен быть от 1 до 65535.");
    }
    if (!cwd.startsWith("/") || cwd.includes("\0")) {
      throw new Error("Для SSH задайте существующую абсолютную рабочую папку на сервере, например /home/user.");
    }
    command = command || "hermes";
    const remote = ["env", ...Object.entries(overrides).map(([key, val]) => `${key}=${val}`), command, ...args];
    const remoteCommand = `cd -- ${quoteAcpShell(cwd)} && exec ${remote.map(quoteAcpShell).join(" ")}`;
    const sshArgs = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
    if (port) sshArgs.push("-p", port);
    if (settings.acpSshKey?.trim()) sshArgs.push("-i", expandAcpHome(settings.acpSshKey.trim()));
    sshArgs.push("--", host, remoteCommand);
    return { command: expandAcpHome((settings.acpSshCommand || "ssh").trim()), args: sshArgs,
      cwd: vaultPath || home, env, sessionCwd: cwd };
  }
  if (!["local", "command"].includes(transport)) throw new Error("Неизвестный транспорт ACP.");
  if (!command && transport === "command") throw new Error("Укажите исполняемый файл внешнего ACP-клиента/обёртки.");
  command = command ? expandAcpHome(command) : findHermesBinary();
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    throw new Error('Укажите hermes.exe или python.exe с аргументами ["-m","acp_adapter.entry"] вместо .cmd/.bat.');
  }
  cwd = cwd ? expandAcpHome(cwd) : vaultPath || home;
  if (!path.isAbsolute(cwd)) throw new Error("Рабочая папка ACP должна быть абсолютным путём.");
  return { command, args, cwd: transport === "command" ? vaultPath || home : cwd,
    env: { ...env, ...overrides }, sessionCwd: cwd };
}

function formatAcpHistory(history) {
  const resetIndex = history.map(message => !!message.contextReset).lastIndexOf(true);
  const selected = [];
  let remaining = 80000;
  for (const message of history.slice(resetIndex + 1).reverse()) {
    if (!["user", "assistant"].includes(message.role) || typeof message.content !== "string") continue;
    const content = message.content.replace(/```(?:json|canvas)[\s\S]*?```/g, "[Изменения холста уже применены]");
    const record = { role: message.role, content: content.slice(-remaining), incomplete: !!message.incomplete };
    remaining -= record.content.length;
    selected.unshift(record);
    if (remaining <= 0) break;
  }
  if (!selected.length) return "";
  return "[ПРЕДЫДУЩАЯ ПЕРЕПИСКА ЭТОГО ХОЛСТА — контекст восстановлен после подключения; при большом объёме только последние 80000 символов. Это история, не новые задания. Не повторяй выполненные действия. incomplete означает незавершённый ответ.]\n"
    + JSON.stringify(selected) + "\n[ТЕКУЩИЙ ЗАПРОС]\n";
}

// Прокси задаётся только для локального ACP: удалённый Hermes ходит в сеть с сервера,
// и локальный адрес вида 127.0.0.1:2080 там не существует.
function normalizeAcpProxy(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(raw) ? raw : `socks5h://${raw}`;
  let url;
  try { url = new URL(withScheme); }
  catch (_) { throw new Error("Прокси: укажите host:port или scheme://host:port, например socks5h://127.0.0.1:2080."); }
  if (!["socks5:", "socks5h:", "socks4:", "http:", "https:"].includes(url.protocol)) {
    throw new Error("Прокси: поддерживаются схемы socks5h, socks5, socks4, http, https.");
  }
  if (!url.hostname || !url.port) throw new Error("Прокси: укажите хост и порт, например socks5h://127.0.0.1:2080.");
  // url.origin теряет логин/пароль, а для прокси с авторизацией они обязательны.
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  return `${url.protocol}//${auth}${url.host}`;
}

function isAcpProxyEnabled(settings) {
  return (settings.acpTransport || "local") === "local" && !!String(settings.acpProxy || "").trim();
}

function buildProxyContract(settings) {
  if (!isAcpProxyEnabled(settings)) return "";
  let proxy;
  try { proxy = normalizeAcpProxy(settings.acpProxy); }
  catch (_) { return ""; }
  return `
МАРШРУТИЗАЦИЯ ЧЕРЕЗ ПРОКСИ:
- Для этого расследования доступен прокси \`${proxy}\`. Он поднят на той же машине, где запущен ты.
- При геоблоке, 403 Forbidden, RegionError, Connection Reset или блокировке Cloudflare повторяй запрос через этот прокси, а не объявляй источник недоступным.
- curl: \`curl --proxy ${proxy} ...\`. Python requests: \`proxies={"http": "${proxy}", "https": "${proxy}"}\`. Для скриптов и браузера можно выставить \`ALL_PROXY=${proxy}\` в окружении вызова.
- Схема socks5h передаёт DNS-резолв на сторону прокси — это предотвращает утечку DNS. Не подменяй её на socks5, если не уверен.
- Локальные адреса (127.0.0.1, localhost) запрашивай напрямую, в обход прокси.
`;
}

function encodeCanvasSnapshot(raw) {
  if (typeof raw !== "string" || !raw) return "";
  try { return zlib.deflateSync(Buffer.from(raw, "utf8")).toString("base64"); }
  catch (_) { return ""; }
}

function decodeCanvasSnapshot(snapshot) {
  if (typeof snapshot !== "string" || !snapshot) return "";
  try { return zlib.inflateSync(Buffer.from(snapshot, "base64")).toString("utf8"); }
  catch (_) { return ""; }
}

function isDeepResearchRequest(userText, deepMode = false) {
  return !!deepMode || /(?:^|\s)\/deep(?:\s|$)|(?:глубок|углуб|подроб|тщатель|комплекс|deep|thorough|in[- ]?depth)/i.test(String(userText || ""));
}

function buildResearchExecutionContract(userText, deepMode = false) {
  const deep = isDeepResearchRequest(userText, deepMode);
  return `
ПРАВИЛА ВЫПОЛНЕНИЯ ИНСТРУМЕНТОВ:
- Используй способы поиска, которые реально доступны в текущей установке Hermes. Предпочитай прямой вызов объявленного ACP-инструмента web_search. Python-обёртка вроде \`from hermes_tools import web_search\` тоже допустима, если импорт действительно работает в этом окружении.
- Если импорт, инструмент или способ вызова завершился ошибкой, не объявляй весь поиск невозможным: прочитай ошибку и перейди к рабочей альтернативе (ACP web_search, web_extract, browser_exec, curl или другой доступный способ).
- Не предполагай наличие авторских скиллов вроде \`vibeosint-shared-patterns\`. Вызывай skill_view только для скилла, который действительно присутствует в каталоге текущего Hermes. Отсутствие скилла не является причиной прекращать расследование.
- После ошибки прочитай её и измени способ запроса. Не повторяй один и тот же вызов с теми же аргументами более одного раза.
- Не завершай ответ после подготовки, skill_view или настройки окружения: сначала выполни фактический поиск и открой релевантные результаты.
- Поисковая выдача — это только начало: открывай релевантные страницы и извлекай из них проверяемые факты. Для содержимого используй web_extract, браузер или curl — в зависимости от реально доступных инструментов.
${deep ? `
РЕЖИМ АКТИВНОГО ГЛУБОКОГО ПОИСКА:
- Составь карту направлений и начинай с широкой разведки. Каждую полезную новую сущность, связь, идентификатор, домен, ник, организацию, документ или противоречие превращай в отдельную проверяемую ветку.
- Не работай ради фиксированного числа запросов и не останавливайся после первых совпадений. Продолжай поиск до насыщения: следующий содержательно новый запрос по каждой релевантной ветке уже не даёт новых сущностей, связей, подтверждений, противоречий или направлений для проверки.
- Варьируй формулировки, языки и идентификаторы только тогда, когда это проверяет новую гипотезу или источник; косметические повторы запросов не считаются исследованием.
- Используй web_search для обнаружения источников, затем обязательно открывай существенные результаты. Если web_extract/curl возвращает обрезанную страницу, сайт требует JavaScript, переходов, раскрытия элементов, пагинации или взаимодействия — переходи на доступные Playwright-функции или browser_exec.
- Не считай источник проверенным, если видел только сниппет поисковой выдачи. В финале различай реально открытые страницы и результаты, которые удалось увидеть только в поиске.
- Проверяй ключевые утверждения минимум по двум независимым источникам, когда это возможно. Разбирай противоречия, а не выбирай удобную версию.
- Для каждого существенного факта сохрани прямой URL и отделяй подтверждённое от предположений.
- Перед финалом проведи самопроверку: все релевантные ветки пройдены до насыщения, страницы открыты, ключевые факты верифицированы, противоречия и слепые зоны явно перечислены.
- Если направление недоступно или ничего не найдено, зафиксируй это и переходи к следующему. Завершай расследование по насыщению доказательств, а не по усталости, таймеру или числу вызовов.` : "Проведи достаточное число разных проверок для ответа; не ограничивайся одним поисковым запросом."}
`;
}

function summarizeAcpToolResult(value, limit = 700) {
  if (value === undefined || value === null) return "";
  let text;
  if (typeof value === "string") text = value;
  else if (Array.isArray(value)) text = value.map(item => {
    const candidate = item?.text ?? item?.content ?? item;
    return typeof candidate === "string" ? candidate : JSON.stringify(candidate);
  }).join(" ");
  else text = value.text || value.content || value.result || value.output || JSON.stringify(value);
  if (typeof text !== "string") text = JSON.stringify(text);
  text = text.replace(/\s+/g, " ").trim();
  if (!text || /^\[object Object\]$/i.test(text) || text === "{}" || text === "[]") return "";
  return text.slice(0, limit);
}

function extractSources(text, explicitSources = []) {
  const found = new Map();
  const add = (url, title = "") => {
    const cleanUrl = String(url || "").trim().replace(/[),.;!?\]}>]+$/, "");
    if (!/^https?:\/\/[^\s]+$/i.test(cleanUrl) || found.has(cleanUrl)) return;
    const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
    found.set(cleanUrl, { url: cleanUrl, title: cleanTitle && cleanTitle !== cleanUrl ? cleanTitle : "" });
  };
  for (const source of Array.isArray(explicitSources) ? explicitSources : []) {
    if (typeof source === "string") add(source);
    else if (source && typeof source === "object") add(source.url || source.href, source.title || source.name || source.label);
  }
  const raw = String(text || "");
  for (const match of raw.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi)) add(match[2], match[1]);
  for (const match of raw.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) add(match[0]);
  return [...found.values()];
}

class HermesAcpClient {
  constructor(vaultPath, settings = {}, onPermission = null, onDisconnect = null) {
    this.vaultPath = vaultPath;
    this.settings = { ...settings };
    this.defaultModel = settings.acpModel || "";
    this.currentModel = "";
    this.availableModels = [];
    this.proc = null;
    this.sessionId = null;
    this.sessions = new Map();
    this.sessionPromises = new Map();
    this.sessionModels = new Map();
    this.updateHandlers = new Map();
    this.busyCanvases = new Set();
    this.cancelledCanvases = new Set();
    this.cancelRecoveryTimers = new Map();
    this.reqId = 1;
    this.pending = new Map();
    this.initializePromise = null;
    this.onPermission = onPermission;
    this.onDisconnect = onDisconnect;
    this.closed = false;
    this.historySentSessions = new Set();
    this.lastStderr = "";
  }

  ensureProcess() {
    if (this.closed) throw new Error("Подключение ACP закрыто. Примените настройки подключения повторно.");
    if (this.proc && !this.proc.killed) return;
    const launch = buildAcpLaunch(this.settings, this.vaultPath);
    this.sessionCwd = launch.sessionCwd;
    this.lastStderr = "";
    const proc = spawn(launch.command, launch.args, {
      cwd: launch.cwd, env: launch.env, shell: false, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc = proc;
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", chunk => { if (this.proc === proc) this.lastStderr = (this.lastStderr + chunk).slice(-4096); });
    const lines = readline.createInterface({ input: proc.stdout });
    this.lines = lines;
    lines.on("line", line => {
      if (this.proc !== proc || !line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.method) {
        if (msg.id !== undefined && msg.id !== null) {
          this.handleRequest(msg, proc).catch(error => console.warn("ACP request:", error));
        } else if (msg.method === "session/update") {
          const sid = msg.params?.sessionId;
          for (const entry of this.pending.values()) {
            if (entry.method === "session/prompt" && entry.params.sessionId === sid) entry.arm(900000);
          }
          try { this.updateHandlers.get(sid)?.(msg.params?.update); }
          catch (error) { console.warn("ACP update:", error); }
        }
      } else if (this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
      }
    });
    const fail = error => {
      if (this.proc !== proc) return;
      this.disconnect(error);
    };
    proc.on("error", error => fail(new Error(`Не удалось запустить ACP (${launch.command}): ${error.message}`)));
    proc.stdin.on("error", error => fail(new Error(`Соединение ACP закрыто: ${error.message}`)));
    proc.stdout.on("error", error => fail(error));
    proc.on("close", (code, signal) => fail(new Error(
      `ACP завершился (код ${code}, сигнал ${signal || "нет"}). ${this.lastStderr.trim()}`
    )));
  }

  disconnect(error) {
    const proc = this.proc;
    this.proc = null;
    this.lines?.close();
    this.lines = null;
    this.initializePromise = null;
    this.sessionId = null;
    this.sessions.clear();
    this.historySentSessions.clear();
    this.sessionPromises.clear();
    this.sessionModels.clear();
    this.availableModels = [];
    this.currentModel = "";
    this.updateHandlers.clear();
    for (const timer of this.cancelRecoveryTimers.values()) clearTimeout(timer);
    this.cancelRecoveryTimers.clear();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    try { this.onDisconnect?.(); } catch (_) {}
    if (proc) {
      proc.stdin.destroy();
      try { proc.kill(); } catch (_) {}
      if (proc.exitCode === null && proc.signalCode === null) {
        const timer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill("SIGKILL"); } catch (_) {} }
        }, 2000);
        timer.unref?.();
      }
    }
  }

  async handleRequest(msg, proc) {
    let response;
    if (msg.method === "session/request_permission") {
      let outcome = { outcome: "cancelled" };
      try {
        if (this.settings.acpAutoApprove) {
          const option = (msg.params?.options || []).find(o => o.kind === "allow_once")
            || (msg.params?.options || []).find(o => o.kind === "allow_always");
          if (option) outcome = { outcome: "selected", optionId: option.optionId };
        } else if (this.onPermission) {
          const selected = await this.onPermission(msg.params || {});
          if (selected?.outcome === "selected" && (msg.params?.options || []).some(o => o.optionId === selected.optionId)) outcome = selected;
        }
      } catch (_) {}
      response = { jsonrpc: "2.0", id: msg.id, result: { outcome } };
    } else {
      response = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unsupported client method: ${msg.method}` } };
    }
    if (this.proc === proc && proc.stdin.writable) proc.stdin.write(JSON.stringify(response) + "\n");
  }

  send(method, params, timeoutMs = 60000) {
    this.ensureProcess();
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      const entry = { resolve, reject, timer: null, method, params };
      entry.arm = ms => {
        clearTimeout(entry.timer);
        if (ms > 0) entry.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          if (method === "session/prompt") this.notify("session/cancel", { sessionId: params.sessionId });
          reject(new Error(`Таймаут ответа ACP (${method}). ${this.lastStderr.trim()}`));
        }, ms);
      };
      this.pending.set(id, entry);
      entry.arm(timeoutMs);
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", error => {
        if (!error || !this.pending.delete(id)) return;
        clearTimeout(entry.timer);
        reject(error);
      });
    });
  }

  async initialize() {
    this.ensureProcess();
    if (!this.initializePromise) {
      const promise = this.send("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "vibeosint-external-acp", version: "1.2.1" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
      }).then(info => {
        if (info?.protocolVersion !== 1) throw new Error("Агент не поддерживает ACP protocolVersion=1.");
        this.agentInfo = info.agentInfo;
        return info;
      });
      this.initializePromise = promise;
      promise.catch(() => { if (this.initializePromise === promise) this.disconnect(new Error("Ошибка инициализации ACP.")); });
    }
    return this.initializePromise;
  }

  async getSession(canvasKey = "default") {
    if (this.closed) throw new Error("Подключение ACP закрыто.");
    if (this.sessions.has(canvasKey)) return this.sessions.get(canvasKey);
    if (this.sessionPromises.has(canvasKey)) return this.sessionPromises.get(canvasKey);
    const creation = (async () => {
      await this.initialize();
      const proc = this.proc;
      const result = await this.send("session/new", { cwd: this.sessionCwd, mcpServers: [] });
      if (!result?.sessionId) throw new Error("ACP не вернул sessionId.");
      let model = result.models?.currentModelId || "";
      if (this.defaultModel && this.defaultModel !== model) {
        await this.send("session/set_model", { sessionId: result.sessionId, modelId: this.defaultModel });
        model = this.defaultModel;
      }
      if (this.proc !== proc || this.sessionPromises.get(canvasKey) !== creation) throw new Error("Сессия ACP была сброшена.");
      this.sessions.set(canvasKey, result.sessionId);
      this.sessionModels.set(canvasKey, model);
      this.availableModels = result.models?.availableModels || [];
      this.sessionId = result.sessionId;
      this.currentModel = model;
      return result.sessionId;
    })();
    this.sessionPromises.set(canvasKey, creation);
    try { return await creation; }
    finally { if (this.sessionPromises.get(canvasKey) === creation) this.sessionPromises.delete(canvasKey); }
  }

  notify(method, params) {
    if (!this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  cancel(canvasKey = "default") {
    if (this.busyCanvases.has(canvasKey)) this.cancelledCanvases.add(canvasKey);
    const sessionId = this.sessions.get(canvasKey);
    if (sessionId) {
      this.notify("session/cancel", { sessionId });
      this.sessions.delete(canvasKey);
      this.sessionModels.delete(canvasKey);
      this.historySentSessions.delete(sessionId);
      if (this.sessionId === sessionId) this.sessionId = null;
    }
    clearTimeout(this.cancelRecoveryTimers.get(canvasKey));
    if (this.busyCanvases.has(canvasKey)) {
      const proc = this.proc;
      const timer = setTimeout(() => {
        this.cancelRecoveryTimers.delete(canvasKey);
        if (this.busyCanvases.has(canvasKey) && this.proc === proc) {
          this.disconnect(new Error("ACP-процесс перезапущен после зависшей отмены."));
        }
      }, 1500);
      timer.unref?.();
      this.cancelRecoveryTimers.set(canvasKey, timer);
    }
  }

  async resetSession(canvasKey = "default") {
    this.cancel(canvasKey);
    this.sessions.delete(canvasKey);
    this.sessionModels.delete(canvasKey);
    this.sessionPromises.delete(canvasKey);
    return this.getSession(canvasKey);
  }

  async setModel(modelId, canvasKey = "default") {
    if (!modelId?.trim()) throw new Error("Укажите ID модели.");
    if (this.busyCanvases.has(canvasKey)) throw new Error("Дождитесь завершения текущего ответа перед сменой модели.");
    const sessionId = await this.getSession(canvasKey);
    await this.send("session/set_model", { sessionId, modelId });
    this.currentModel = modelId;
    this.defaultModel = modelId;
    this.sessionModels.set(canvasKey, modelId);
    return modelId;
  }

  async prompt(text, callbacks = {}, canvasKey = "default") {
    if (this.busyCanvases.has(canvasKey)) throw new Error("Предыдущий запрос этого холста ещё выполняется или отменяется.");
    this.busyCanvases.add(canvasKey);
    let sessionId;
    try {
      sessionId = await this.getSession(canvasKey);
      if (this.cancelledCanvases.has(canvasKey)) return { stopReason: "cancelled" };
      this.updateHandlers.set(sessionId, update => {
        if (update?.sessionUpdate === "agent_message_chunk" && update.content?.text) callbacks.onChunk?.(update.content.text);
        else if (update?.sessionUpdate === "tool_call") callbacks.onToolStart?.(update.title || update.name || "Инструмент", update);
        else if (update?.sessionUpdate === "tool_call_update") callbacks.onToolEnd?.(update.title || update.name || "Инструмент", update.content || update.result, update);
      });
      const history = !this.historySentSessions.has(sessionId) ? formatAcpHistory(callbacks.history || []) : "";
      this.historySentSessions.add(sessionId);
      return await this.send("session/prompt", { sessionId, prompt: [{ type: "text", text: history + text }] }, 1800000);
    } finally {
      if (sessionId) this.updateHandlers.delete(sessionId);
      clearTimeout(this.cancelRecoveryTimers.get(canvasKey));
      this.cancelRecoveryTimers.delete(canvasKey);
      this.busyCanvases.delete(canvasKey);
      this.cancelledCanvases.delete(canvasKey);
    }
  }

  stop() {
    this.closed = true;
    this.disconnect(new Error("Подключение ACP остановлено."));
  }
}

class AcpPermissionModal extends obsidian.Modal {
  constructor(app, params, done) { super(app); this.params = params; this.done = done; }
  onOpen() {
    this.contentEl.createEl("h3", { text: "Hermes запрашивает разрешение" });
    this.contentEl.createEl("p", { text: this.params.toolCall?.title || "Действие инструмента" });
    if (this.params.toolCall?.rawInput) this.contentEl.createEl("pre", {
      text: JSON.stringify(this.params.toolCall.rawInput, null, 2),
      attr: { style: "white-space:pre-wrap;max-height:240px;overflow:auto" }
    });
    for (const option of this.params.options || []) {
      this.contentEl.createEl("button", { text: option.name || option.optionId }).addEventListener("click", () => {
        this.result = { outcome: "selected", optionId: option.optionId };
        this.close();
      });
    }
  }
  onClose() { this.contentEl.empty(); this.done(this.result || { outcome: "cancelled" }); }
}

// Формы ID от Hermes ACP:
//   anthropic:claude-opus-4-8                      → anthropic
//   custom:agy/gemini-3.8-flash-high               → agy
//   custom:185.143.238.30:20128:aihorde/model      → aihorde
//   custom:deepseek-v4-pro                         → custom
// У префикса custom: осмысленная группа — это часть до слэша в самом имени
// модели, иначе всё содержимое шлюза-агрегатора схлопывается в одну кучу.
function modelProviderOf(modelId) {
  const id = String(modelId || "");
  if (id.startsWith("custom:")) {
    const rest = id.slice("custom:".length);
    const model = rest.slice(rest.lastIndexOf(":") + 1);
    const slash = model.indexOf("/");
    return slash > 0 ? model.slice(0, slash) : "custom";
  }
  const colon = id.indexOf(":");
  if (colon > 0) return id.slice(0, colon);
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "";
}

// Список моделей ACP в стабильном порядке: текущая первой, дальше по провайдеру и имени.
// Hermes отдаёт availableModels в порядке провайдера, который выглядит случайным.
function sortAcpModels(models, currentModel = "") {
  return (Array.isArray(models) ? models : [])
    .filter(model => model && model.modelId)
    .map(model => ({
      modelId: model.modelId,
      name: model.name || model.modelId,
      description: model.description || "",
      provider: modelProviderOf(model.modelId)
    }))
    .sort((a, b) => {
      if (a.modelId === currentModel) return -1;
      if (b.modelId === currentModel) return 1;
      return a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId);
    });
}

/**
 * Поиск по списку моделей: ввод фильтрует, Enter выбирает.
 * Без него 600+ моделей от шлюза-агрегатора невозможно просматривать.
 */
class ModelPickerModal extends obsidian.FuzzySuggestModal {
  constructor(app, models, currentModel, onChoose, initialQuery = "") {
    super(app);
    this.models = models;
    this.currentModel = currentModel;
    this.onChoose = onChoose;
    this.initialQuery = initialQuery;
    this.setPlaceholder("Часть названия модели: gemini, opus, flash-high…");
    this.setInstructions?.([
      { command: "↑↓", purpose: "выбрать" },
      { command: "↵", purpose: "переключить" },
      { command: "esc", purpose: "отмена" }
    ]);
  }

  onOpen() {
    super.onOpen();
    if (this.initialQuery && this.inputEl) {
      this.inputEl.value = this.initialQuery;
      this.inputEl.dispatchEvent(new Event("input"));
    }
  }

  getItems() { return this.models; }

  // Ищем сразу по ID, имени и описанию — пользователь может помнить любое из них.
  getItemText(model) {
    return `${model.modelId} ${model.name} ${model.description}`.trim();
  }

  renderSuggestion(match, el) {
    const model = match.item ?? match;
    el.addClass("osint-model-suggestion");
    const title = el.createDiv({ cls: "osint-model-suggestion-title" });
    title.createSpan({ text: model.modelId });
    if (model.modelId === this.currentModel) {
      title.createSpan({ cls: "osint-model-suggestion-current", text: "активна" });
    }
    const subtitle = [model.name !== model.modelId ? model.name : "", model.description]
      .filter(Boolean).join(" · ");
    if (subtitle) el.createDiv({ cls: "osint-model-suggestion-desc", text: subtitle });
  }

  onChooseItem(model) { this.onChoose(model.modelId); }
}

/**
 * Базовый системный шаблон для Hermes ACP
 */
const OSINT_BASE_CONTRACT = `Ты — автономный OSINT-агент, управляющий расследованием на Obsidian Canvas.

СТРОГАЯ ИЗОЛЯЦИЯ И ИСПОЛЬЗОВАНИЕ СКИЛЛОВ:
1. Занимайся ИСКЛЮЧИТЕЛЬНО текущей целью.
   - РАЗРЕШЕНО И РЕКОМЕНДУЕТСЯ: загружать и использовать скиллы Hermes Agent (skill_view, референсы, документация по инструментам, сети, парсингу и обходам).
   - КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО:
     * Читать другие файлы .canvas и другие заметки в хранилище. Твой контекст заметок — ТОЛЬКО текущий холст!
     * Искать по прошлым сессиям других людей/номеров через session_search. Каждое расследование строго изолировано.
     * Примешивать имена, телефоны или факты из других расследований.
2. Использовать реальные инструменты (web_search, terminal, web_extract, python, browser_exec) для разведки во ВНЕШНИХ открытых источниках (интернет, реестры, DoH DNS, API).

АКТУАЛЬНОСТЬ КАРТОЧЕК (ОБНОВЛЕНИЕ И ОЧИСТКА):
3. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО создавать карточки с отрицательными результатами («В базах спама не найден», «Реестры бизнеса: компаний не найдено», «ФИО не найдено», «Судов нет»). Если данных в открытых источниках нет — просто НЕ создавай карточку!
4. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО создавать карточки-инструкции и советы пользователю («Сделай перевод по СБП чтобы узнать имя», «Сохрани номер в контакты», «Проверь в GetContact»). Ты — исполнитель, а не консультант. На холсте отображаются только найденные ТОБОЙ факты!
5. Если по номеру или цели в открытых источниках нет ФИО или компаний — напиши об этом прямо В ТЕКСТЕ ОТВЕТА В ЧАТЕ («В открытых реестрах ФИО не обнаружено»). А на холст добавь ТОЛЬКО базовую подтвержденную карточку (оператор и регион).
6. ЕСЛИ ИНФОРМАЦИЯ ИЗМЕНИЛАСЬ ИЛИ ДОПОЛНИЛАСЬ:
   ОБЯЗАТЕЛЬНО используй "update_nodes": [{"id": "id_карточки", "text": "### Заголовок\\n\\n• Актуальные факты..."}] для изменения существующей карточки по её ID. Запрещено плодить дубликаты!
7. ЕСЛИ ИНФОРМАЦИЯ НЕВАЛИДНА ИЛИ ОПРОВЕРГНУТА:
   ОБЯЗАТЕЛЬНО удаляй устаревшие/ошибочные карточки через "delete_node_ids": ["id_карточки"]. Граф должен оставаться чистым и актуальным.
8. Новые карточки ("new_nodes") создавай ТОЛЬКО для принципиально новых подтвержденных сущностей/веток.

В конце ответа ОБЯЗАТЕЛЬНО выдать блок \`\`\`json ... \`\`\` для построения графа на холсте слева направо:

\`\`\`json
{
  "summary": "Краткая суть находок",
  "pivots": ["зацепка_1", "зацепка_2"],
  "delete_node_ids": ["id_карточки_для_удаления"],
  "update_nodes": [
    { "id": "id_карточки", "text": "### Заголовок\\n\\n• Факты..." }
  ],
  "new_nodes": [
    {
      "id": "уникальный_id",
      "parent_id": "id_родительской_ноды",
      "title": "Заголовок с эмодзи",
      "content": "• Маркированный список фактов\\n• [Ссылка](https://...)",
      "color": "1" - "6"
    }
  ]
}
\`\`\`

ЦВЕТА КАРТОЧЕК:
- Никакого разноцветия (без радуги).
- ТОЛЬКО критическая информация (подтвержденные ключевые совпадения, важные чувствительные находки) выделяется КРАСНЫМ цветом: "color": "1".
- ВСЕ остальные карточки (цель, профили, реестры, дорки, сеть) должны быть ОБЫЧНЫМИ нейтральными: "color": "" (без специального цвета, стандартный фон темы).

СТРУКТУРА И ИЕРАРХИЯ СВЯЗЕЙ (СЛЕВА НАПРАВО):
- Холст автоматически выравнивается по уровням и колонкам слева направо без наложений и пересечений.
- ДЛЯ КАЖДОЙ новой ноды ("new_nodes") ОБЯЗАТЕЛЬНО указывай точный "parent_id":
  * Основные направления (Адрес, Семья, Учеба/Работа, Утечки) привязывай к целевой ноде ("parent_id": "target").
  * Вложенные детали привязывай к соответствующему родителю (сестру/родственника к матери, дипломы к учебе, авто к владельцу).
  * Это строит безупречное дерево: Цель -> Категории -> Связи -> Доказательства.
- ТЕКСТ КАРТОЧКИ: форматируй строго через заголовок (## или ###) и емкий маркированный список (• **Ключ:** значение). Размеры карточки пересчитываются строго по тексту.

МАРШРУТИЗАЦИЯ И ПРОКСИ (ПРИ БЛОКИРОВКАХ):
Если целевой сайт, API или сервис не открывается из-за региональных ограничений / геоблока (ошибки 403 Forbidden, RegionError, Connection Reset, Cloudflare block), при необходимости используй локальный или настроенный SOCKS5/HTTP прокси.

МЕТОДЫ И ИНСТРУМЕНТЫ АГЕНТА (ЭНЦИКЛОПЕДИЯ И ВЕКТОРЫ OSINT FRAMEWORK):
- Ты не ограничен фиксированным списком утилит: через terminal и python ты можешь на лету писать любые скрипты для парсинга, поиска и анализа (requests, bs4, phonenumbers, pypdf, curl, jq, dig, whois, aiohttp, playwright).
- Всесторонне используй все разделы и методы OSINT Framework (https://osintframework.com):
  1. USERNAME / ЦИФРОВОЙ СЛЕД:
     - Прогон никнейма по базам платформ (WhatsMyName, Namechk, Sherlock/Maigret, KnowEm).
     - Вытягивание скрытых постоянных ID профилей: Telegram ID, VK ID (кэши и архивы), SteamID64, GitHub API, Roblox ID, Discord ID.
  2. EMAIL / УЧЕТНЫЕ ЗАПИСИ:
     - Проверка привязки почты к сервисам без отправки сообщений (Epieos, Holehe, GHunt).
     - Анализ корпоративных доменов: паттерны именования (Hunter.io), MX/SPF-записи, утечки и упоминания в базах (DeHashed, IntelX).
  3. ТЕЛЕФОННЫЕ НОМЕРА:
     - Определение региона и оператора: таблицы диапазонов DEF, реестры перенесенных номеров БДПН (ЦНИИС/НИИР).
     - Поиск объявлений и следов на торговых площадках: Авито, Юла, Авто.ру, Drom, резюме (HH, SuperJob), форумы.
     - Проверка аватарок и имен через синхронизацию мессенджеров (Telegram, WhatsApp, Viber).
  4. БИЗНЕС И ГОСУДАРСТВЕННЫЕ РЕЕСТРЫ:
     - Юрлица и ИП: ФНС ЕГРЮЛ/ЕГРИП (Rusprofile, Checko, Audit-it, List-Org, ЗаЧестныйБизнес). Связи учредителей, доли, выручка, финансовые отчеты.
     - Судебная система: Картотека арбитражных дел (kad.arbitr.ru), ГАС «Правосудие», СудАкт, Мосгорсуд. В судебных актах и решениях содержатся прямые паспортные данные, прописки, адреса и договоры сторон.
     - Исполнительные производства и взыскания: ФССП (алименты, кредиты, долги, наложенные аресты).
     - Лицензии и реестры: Роснедра (лицензии на разработку недр и карьеров), реестры МЧС, лицензии Рособрнадзора.
  5. ГЕОЛОКАЦИЯ И НЕДВИЖИМОСТЬ:
     - Публичная кадастровая карта (ПКК Росреестра): назначение участков, границы, кадастровая стоимость, кадастровые номера.
     - Панорамы улиц и спутниковые снимки: Яндекс Карты (панорамы разных лет), Google Street View, картография OpenStreetMap.
  6. ТРАНСПОРТ И СПЕЦТЕХНИКА:
     - Автомобильные номера и VIN: реестры залогов и лизингов на Федресурсе (лизинг грузового транспорта и спецтехники), базы проверок авто.
     - Авиационный и морской трекинг: FlightRadar24, ADS-B Exchange, MarineTraffic, VesselFinder.
  7. СЕТЕВАЯ ИНФРАСТРУКТУРА И ДОМЕНЫ:
     - WHOIS, история смены владельцев доменов, DNS-записи, DoH.
     - Поиск скрытых поддоменов через сертификаты прозрачности (crt.sh, Censys, Shodan, VirusTotal), обратный резолв IP и ASN.
  8. АРХИВЫ И МЕТАДАННЫЕ:
     - Восстановление удаленных страниц и следов: Wayback Machine (web.archive.org), Archive.today, сохраненные копии поисковиков.
     - Извлечение метаданных из файлов и документов: EXIF, метаданные PDF/DOCX (имена авторов, версии софта, даты создания).
- Установка недостающих тулов: настроен беспарольный sudo. При необходимости устанавливай любые системные пакеты (sudo pacman -S --noconfirm <пакет>) или python-библиотеки (pip install <пакет>).
- Для сложных веб-страниц, капч и Cloudflare используй реальный браузер (browser_exec).
- НАЧАЛЬНЫЙ ПОИСК В САМОМ НАЧАЛЕ (ПЕРВЫЙ ШАГ РАССЛЕДОВАНИЯ):
  В самом начале расследования по любой цели (номер телефона, ИНН, авто, паспорт, никнейм/юзернейм) проведи первичную разведку по открытым базам, реестрам и поисковикам. Полученные зацепки (пивоты) сразу используй для дальнейшей глубокой верификации в открытых реестрах.
- Защита контекста: сохраняй промежуточные подтверждённые находки на Canvas, но продолжай исследование до насыщения выбранного режима.

Никаких туториалов, воды и поучений. Только факты.`;

const DEFAULT_SETTINGS = {
  deepModeByCanvas: {},
  chatActivityByCanvas: {},
  chatActivityVersion: 2,
  acpModel: "",
  acpTransport: "local",
  acpCommand: "",
  acpArgs: '["acp"]',
  acpCwd: "",
  acpEnv: "{}",
  acpSshHost: "",
  acpSshPort: "",
  acpSshKey: "",
  acpSshCommand: "ssh",
  acpProxy: "",
  acpAutoApprove: true
};

/**
 * Нормализация текста для сравнения и дедупликации карточек
 */
function normalizeTextForDedup(s) {
  return String(s || "")
    .replace(/[#*_`~•\-–—\[\]\(\)]/g, " ")
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Поиск существующей ноды на холсте по ID, заголовку или тексту для исключения дубликатов
 */
function findExistingNode(nodes, candidate, cardTitle = "", cardBody = "") {
  if (!candidate || !nodes || nodes.length === 0) return null;

  // 1. Прямое совпадение по ID
  if (candidate.id) {
    const candIdLower = String(candidate.id).toLowerCase();
    const direct = nodes.find(n => String(n.id).toLowerCase() === candIdLower);
    if (direct) return direct;
  }

  const title = (cardTitle || candidate.title || candidate.label || "").trim();
  const normTitle = normalizeTextForDedup(title);

  // 2. Совпадение по нормализованному заголовку (первой строке)
  if (normTitle && normTitle.length >= 4) {
    for (const n of nodes) {
      const nFirstLine = String(n.text || "").split("\n")[0];
      const nNorm = normalizeTextForDedup(nFirstLine);
      if (nNorm && (nNorm === normTitle ||
          (normTitle.length > 8 && (nNorm.includes(normTitle) || normTitle.includes(nNorm))))) {
        return n;
      }
    }
  }

  // 3. Совпадение по содержанию текста
  const body = (cardBody || candidate.content || candidate.text || "").trim();
  if (body && body.length > 30) {
    const snippet = normalizeTextForDedup(body).slice(0, 140);
    for (const n of nodes) {
      const nBody = normalizeTextForDedup(n.text || "");
      if (nBody.includes(snippet)) {
        return n;
      }
    }
  }

  return null;
}

/**
 * Точный и просторный расчет размеров карточки под реальный текст (без обрезки и без скроллбаров)
 */
function calculateCardDimensions(textOrTitle, secondArg = false, thirdArg = false, existingNode = null) {
  let text = "";
  let isTarget = false;
  let isFile = false;

  if (typeof secondArg === "string") {
    // Вызов вида calculateCardDimensions(title, content, isTarget)
    const title = String(textOrTitle || "").trim();
    const content = String(secondArg || "").trim();
    if (title && !content.startsWith("#")) {
      text = `### ${title}\n\n${content}`;
    } else {
      text = content || title;
    }
    isTarget = Boolean(thirdArg);
  } else {
    // Стандартный вызов calculateCardDimensions(text, isTarget, isFile, existingNode)
    text = String(textOrTitle || "").trim();
    isTarget = Boolean(secondArg);
    isFile = Boolean(thirdArg);
  }

  if (isFile) {
    if (existingNode && existingNode.width && existingNode.height) {
      return { width: existingNode.width, height: existingNode.height };
    }
    return { width: 460, height: 360 };
  }

  if (!text) {
    return { width: 540, height: 140 };
  }

  const hasEmbeddedImage = /!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]+\]\]/i.test(text);
  const hasPlainImageLink = /(?<!!)\[[^\]]*\]\(https?:\/\/[^)\s]+\.(?:jpe?g|png|webp|gif|avif)(?:\?[^)]*)?\)/i.test(text);

  const cardWidth = 540;
  const usableWidth = cardWidth - 56;
  const lines = text.split("\n");

  let totalHeight = 36; // внутренние отступы и безопасный запас сверху
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      totalHeight += 22;
      continue;
    }

    if (!trimmed) {
      totalHeight += 6;
      continue;
    }

    // Встроенные изображения ![[картинка.jpg]] или ![](...) в markdown-карточке
    if (trimmed.includes("![[") || (trimmed.includes("![") && trimmed.includes("]("))) {
      const sizeMatch = trimmed.match(/\|(\d+)(?:x(\d+))?\]\]/);
      if (sizeMatch) {
        const customH = sizeMatch[2] ? parseInt(sizeMatch[2], 10) : parseInt(sizeMatch[1], 10);
        totalHeight += Math.max(120, customH + 16);
      } else {
        const dimensionsInUrl = trimmed.match(/(?:^|[\/_-])(\d{2,4})[_x-](\d{2,4})(?:[_./-]|$)/);
        const imageHeight = dimensionsInUrl
          ? Math.round(Math.min(460, usableWidth * Number(dimensionsInUrl[2]) / Number(dimensionsInUrl[1])))
          : 300;
        totalHeight += Math.max(140, imageHeight + 16);
      }
      continue;
    }

    if (trimmed.startsWith("# ")) {
      totalHeight += 44;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      totalHeight += 38;
      continue;
    }
    if (trimmed.startsWith("### ")) {
      totalHeight += 34;
      continue;
    }

    const indentCount = line.length - line.trimStart().length;
    const indentPx = indentCount * 10;
    const lineUsableW = Math.max(200, usableWidth - indentPx);

    const clean = trimmed.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");
    const hasBold = clean.includes("**") || clean.includes("<b>") || clean.includes("<strong>");
    const charWidth = hasBold ? 9.5 : 9.0;
    const cleanText = clean.replace(/[*_`~]/g, "");

    const charsPerLine = Math.max(20, Math.floor(lineUsableW / charWidth));
    const visualLines = Math.max(1, Math.ceil(cleanText.length / charsPerLine));
    totalHeight += visualLines * (inCodeBlock ? 21 : 24);

    if (trimmed.startsWith("•") || trimmed.startsWith("-") || trimmed.startsWith("*") || /^\d+\./.test(trimmed)) {
      totalHeight += 4;
    }
  }

  totalHeight += 24;
  if (hasPlainImageLink && !hasEmbeddedImage) {
    // Один и тот же лишний внешний запас появляется у всей фотокарточки,
    // поэтому компенсируем его один раз, независимо от числа ссылок.
    totalHeight -= 48;
  }

  return {
    width: Math.round(cardWidth),
    height: Math.max(105, Math.round(totalHeight))
  };
}

/**
 * Иерархическое LTR выравнивание графа на Canvas с устранением наложений и дедупликацией
 */
function beautifyCanvasLayout(canvasData) {
  if (!canvasData || !Array.isArray(canvasData.nodes) || canvasData.nodes.length === 0) {
    return;
  }

  if (!Array.isArray(canvasData.edges)) canvasData.edges = [];
  let nodes = canvasData.nodes;
  let edges = canvasData.edges;

  // 1. Детекция и удаление дубликатов на холсте
  const uniqueNodes = [];
  const mergedIdsMap = new Map();
  const seenTitles = new Map();

  for (const n of nodes) {
    const rawText = String(n.text || "").trim();
    const firstLine = rawText.split("\n")[0];
    const normTitle = normalizeTextForDedup(firstLine);

    if (normTitle && normTitle.length >= 5 && seenTitles.has(normTitle)) {
      const primary = seenTitles.get(normTitle);
      mergedIdsMap.set(String(n.id), String(primary.id));
      if (rawText.length > String(primary.text || "").length) {
        primary.text = rawText;
      }
    } else {
      if (normTitle && normTitle.length >= 5) {
        seenTitles.set(normTitle, n);
      }
      uniqueNodes.push(n);
    }
  }

  nodes = uniqueNodes;
  canvasData.nodes = nodes;

  // Перенаправляем ребра с удаленных дубликатов на первичную карточку
  for (const e of edges) {
    if (mergedIdsMap.has(String(e.fromNode))) {
      e.fromNode = mergedIdsMap.get(String(e.fromNode));
    }
    if (mergedIdsMap.has(String(e.toNode))) {
      e.toNode = mergedIdsMap.get(String(e.toNode));
    }
  }

  // Удаляем дублирующиеся ребра, ребра-петли и ребра на удаленные ноды
  const validNodeIds = new Set(nodes.map(n => String(n.id)));
  const edgeKeySet = new Set();
  edges = edges.filter(e => {
    const u = String(e.fromNode);
    const v = String(e.toNode);
    if (u === v || !validNodeIds.has(u) || !validNodeIds.has(v)) {
      return false;
    }
    const key = `${u}->${v}`;
    if (edgeKeySet.has(key)) return false;
    edgeKeySet.add(key);
    return true;
  });
  canvasData.edges = edges;

  // 2. Пересчет размеров текстовых нод под актуальный контент
  for (const n of nodes) {
    if (n.type === "text" || n.text) {
      const isTarget = n.id.includes("tgt") || n.id === "target" ||
                       String(n.text).includes("🎯") ||
                       String(n.text).startsWith("## ");
      const dims = calculateCardDimensions(n.text, isTarget, false);
      n.width = dims.width;
      n.height = dims.height;
    } else if (n.type === "file") {
      if (!n.width) n.width = 460;
      if (!n.height) n.height = 360;
    }
  }

  const nodeMap = new Map(nodes.map(n => [String(n.id), n]));

  // 3. Построение графа смежности
  const outgoing = new Map();
  const incoming = new Map();
  for (const n of nodes) {
    outgoing.set(String(n.id), []);
    incoming.set(String(n.id), []);
  }

  for (const e of edges) {
    const u = String(e.fromNode);
    const v = String(e.toNode);
    if (nodeMap.has(u) && nodeMap.has(v)) {
      outgoing.get(u).push(v);
      incoming.get(v).push(u);
    }
  }

  // 4. Определение целевой ноды (корня)
  let targetNode = nodes.find(n =>
    n.id.includes("tgt") || n.id === "target" ||
    String(n.text).includes("🎯") ||
    String(n.text).startsWith("## ")
  );
  if (!targetNode) {
    targetNode = nodes.find(n => incoming.get(String(n.id)).length === 0) || nodes[0];
  }
  const tgtId = String(targetNode.id);

  // Привязываем висячие карточки без входящих связей к цели
  for (const n of nodes) {
    const nid = String(n.id);
    if (nid !== tgtId && incoming.get(nid).length === 0) {
      incoming.get(nid).push(tgtId);
      outgoing.get(tgtId).push(nid);
      edges.push({
        id: `edge_auto_${Date.now()}_${nid.slice(-4)}`,
        fromNode: tgtId,
        fromSide: "right",
        toNode: nid,
        toSide: "left"
      });
    }
  }

  // 5. Определение уровней глубины (слоев) от корня
  const levels = new Map();
  levels.set(tgtId, 0);
  const queue = [tgtId];

  while (queue.length > 0) {
    const curr = queue.shift();
    const currLvl = levels.get(curr);
    for (const child of outgoing.get(curr) || []) {
      const nextLvl = currLvl + 1;
      if (!levels.has(child) || nextLvl > levels.get(child)) {
        levels.set(child, nextLvl);
        queue.push(child);
      }
    }
  }

  for (const n of nodes) {
    const nid = String(n.id);
    if (!levels.has(nid)) {
      levels.set(nid, 1);
    }
  }

  const maxLvl = Math.max(...Array.from(levels.values()), 0);
  const columns = Array.from({ length: maxLvl + 1 }, () => []);
  for (const n of nodes) {
    const lvl = levels.get(String(n.id)) || 0;
    columns[lvl].push(n);
  }

  const gapX = 140;
  const gapY = 36;

  // 6. Расчет X-координат по колонкам
  let currentX = 0;
  for (let lvl = 0; lvl <= maxLvl; lvl++) {
    const col = columns[lvl];
    if (col.length === 0) continue;
    const maxColWidth = Math.max(...col.map(n => n.width || 540));
    for (const n of col) {
      n.x = currentX;
    }
    currentX += maxColWidth + gapX;
  }

  targetNode.y = 0;

  const getParentCenterY = (n) => {
    const parents = incoming.get(String(n.id)) || [];
    if (parents.length > 0) {
      const p = nodeMap.get(parents[0]);
      if (p) return (p.y || 0) + (p.height || 0) / 2;
    }
    return (targetNode.y || 0) + (targetNode.height || 0) / 2;
  };

  // 7. Расчет Y-координат
  // Колонка 1: центрируется вертикально относительно цели
  if (columns[1] && columns[1].length > 0) {
    const col1 = columns[1];
    const totalH1 = col1.reduce((acc, n) => acc + (n.height || 0), 0) + (col1.length - 1) * gapY;
    const targetCenterY = (targetNode.y || 0) + (targetNode.height || 0) / 2;
    let startY = Math.round(targetCenterY - totalH1 / 2);

    for (const n of col1) {
      n.y = startY;
      startY += (n.height || 0) + gapY;
    }
  }

  // Колонки 2+: группируются по родителю, центрируются относительно него и раздвигаются без наложений
  for (let lvl = 2; lvl <= maxLvl; lvl++) {
    const col = columns[lvl];
    if (col.length === 0) continue;

    const parentGroups = new Map();
    for (const n of col) {
      const parents = incoming.get(String(n.id)) || [];
      const pid = parents.length > 0 ? parents[0] : tgtId;
      if (!parentGroups.has(pid)) parentGroups.set(pid, []);
      parentGroups.get(pid).push(n);
    }

    const sortedPids = Array.from(parentGroups.keys()).sort((a, b) => {
      const pA = nodeMap.get(a);
      const pB = nodeMap.get(b);
      return ((pA?.y || 0) + (pA?.height || 0) / 2) - ((pB?.y || 0) + (pB?.height || 0) / 2);
    });

    for (const pid of sortedPids) {
      const group = parentGroups.get(pid);
      const pNode = nodeMap.get(pid) || targetNode;
      const pCenter = (pNode.y || 0) + (pNode.height || 0) / 2;
      const groupH = group.reduce((acc, n) => acc + (n.height || 0), 0) + (group.length - 1) * gapY;
      let grpY = Math.round(pCenter - groupH / 2);

      for (const n of group) {
        n.y = grpY;
        grpY += (n.height || 0) + gapY;
      }
    }

    // Проход сверху вниз для устранения коллизий
    col.sort((a, b) => a.y - b.y);
    for (let i = 1; i < col.length; i++) {
      const prev = col[i - 1];
      const curr = col[i];
      const minY = prev.y + prev.height + gapY;
      if (curr.y < minY) {
        curr.y = minY;
      }
    }

    // Релаксация снизу вверх (подтягивание к родителю если есть свободное место)
    for (let i = col.length - 2; i >= 0; i--) {
      const curr = col[i];
      const succ = col[i + 1];
      const maxY = succ.y - gapY - curr.height;
      const idealY = Math.round(getParentCenterY(curr) - curr.height / 2);
      if (curr.y < idealY && maxY > curr.y) {
        curr.y = Math.min(idealY, maxY);
      }
    }
  }

  // 8. Нормализация координат: сдвигаем весь граф так, чтобы все X и Y были >= 40px
  let minY = Infinity;
  let minX = Infinity;
  for (const n of nodes) {
    if (n.y < minY) minY = n.y;
    if (n.x < minX) minX = n.x;
  }
  const shiftY = minY < 40 ? 40 - minY : 0;
  const shiftX = minX < 40 ? 40 - minX : 0;
  if (shiftY > 0 || shiftX > 0) {
    for (const n of nodes) {
      n.y += shiftY;
      n.x += shiftX;
    }
  }

  // 9. Обновление сторон ребер (fromSide, toSide) строго слева направо
  for (const e of edges) {
    const u = nodeMap.get(String(e.fromNode));
    const v = nodeMap.get(String(e.toNode));
    if (u && v) {
      if (u.x > v.x) {
        e.fromNode = String(v.id);
        e.toNode = String(u.id);
      }
      e.fromSide = "right";
      e.toSide = "left";
    }
  }
}

class VibeOsintPlugin extends Plugin {
  async onload() {
    console.log("Loading Hermes Canvas OSINT Plugin");
    this.activeTasks = new Map(); // canvasKey -> task state
    await this.loadSettings();
    await this.loadChatHistories();

    // Получаем путь к текущему волту для Hermes ACP
    const vaultAdapter = this.app.vault.adapter;
    const vaultPath = (vaultAdapter && vaultAdapter.getBasePath) ? vaultAdapter.getBasePath() : "";

    this.vaultPath = vaultPath;
    this.permissionModals = new Set();
    this.configureAcpClient();

    this.registerView(
      VIEW_TYPE_OSINT,
      (leaf) => new OsintChatView(leaf, this)
    );

    this.addRibbonIcon("crosshair", "OSINT Canvas Agent (Hermes)", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-osint-panel",
      name: "Открыть панель OSINT-расследования",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "beautify-current-canvas",
      name: "Красиво выровнять граф на холсте (Auto-layout OSINT)",
      callback: () => this.beautifyActiveCanvas(),
    });

    this.addSettingTab(new OsintSettingTab(this.app, this));
  }

  configureAcpClient() {
    this.acpClient?.stop();
    this.acpClient = new HermesAcpClient(this.vaultPath, this.settings, params => new Promise(resolve => {
      const modal = new AcpPermissionModal(this.app, params, result => {
        this.permissionModals.delete(modal);
        resolve(result);
      });
      this.permissionModals.add(modal);
      modal.open();
    }), () => {
      for (const modal of [...this.permissionModals]) modal.close();
    });
  }

  async loadChatHistories() {
    this.chatHistories = {};
    this.chatWriteQueue = Promise.resolve();
    this.chatHistoryLoadFailed = false;
    const adapter = this.app.vault.adapter;
    const file = `${this.manifest.dir}/chats.json`;
    let primaryFailed = false;
    for (const candidate of [file, file + ".bak"]) {
      try {
        if (!await adapter.exists(candidate)) continue;
        const raw = await adapter.read(candidate);
        const parsed = JSON.parse(raw);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.values(parsed).some(value => !Array.isArray(value))) throw new Error("Неверный формат истории");
        this.chatHistories = parsed;
        this.lastGoodChatJson = raw;
        if (primaryFailed) {
          this.preserveCorruptChat = true;
          new Notice("История восстановлена из резервной копии chats.json.bak.", 8000);
        }
        return;
      } catch (error) {
        primaryFailed = true;
        console.warn("Cannot load chat history:", error);
      }
    }
    if (primaryFailed) {
      this.chatHistoryLoadFailed = true;
      new Notice("Не удалось прочитать историю. Автосохранение отключено, чтобы не затереть файлы chats.json и .bak.", 12000);
    }
  }

  saveChatHistories() {
    const snapshot = JSON.stringify(this.chatHistories || {}, null, 2);
    const write = async () => {
      if (this.chatHistoryLoadFailed) throw new Error("Сохранение истории заблокировано: сначала восстановите chats.json из копии.");
      const adapter = this.app.vault.adapter;
      const file = `${this.manifest.dir}/chats.json`;
      if (this.preserveCorruptChat && await adapter.exists(file)) {
        await adapter.write(`${file}.corrupt-${Date.now()}`, await adapter.read(file));
        this.preserveCorruptChat = false;
      }
      if (this.lastGoodChatJson) await adapter.write(file + ".bak", this.lastGoodChatJson);
      await adapter.write(file, snapshot);
      this.lastGoodChatJson = snapshot;
    };
    const result = (this.chatWriteQueue || Promise.resolve()).catch(() => {}).then(write);
    this.chatWriteQueue = result;
    result.catch(error => {
      console.warn("Failed to save chat histories:", error);
      if (!this.chatSaveWarningShown) {
        this.chatSaveWarningShown = true;
        new Notice(`История не сохранена: ${error.message}`, 10000);
      }
    });
    return result;
  }

  checkpointChatTask(task, immediate = false) {
    if (!task.streamedChunks) return;
    if (!task.historyMessage) {
      task.historyMessage = { role: "assistant", content: "", incomplete: true };
      const history = (this.chatHistories[task.canvasKey] ||= []);
      const insertAt = Math.max(0, Math.min(Number(task.assistantInsertIndex) || history.length, history.length));
      history.splice(insertAt, 0, task.historyMessage);
    }
    Object.assign(task.historyMessage, { content: task.streamedChunks, toolLogs: [...task.toolLogs] });
    if (immediate) {
      clearTimeout(task.historyTimer);
      task.historyTimer = null;
      return this.saveChatHistories();
    }
    if (!task.historyTimer) task.historyTimer = setTimeout(() => {
      task.historyTimer = null;
      this.saveChatHistories().catch(() => {});
    }, 2000);
  }

  async resetCanvasSession(key) {
    await this.acpClient.resetSession(key);
    (this.chatHistories[key] ||= []).push({ role: "assistant", content: "Контекст агента сброшен. Предыдущая переписка сохранена только для просмотра.", contextReset: true });
    await this.saveChatHistories();
  }

  isDeepMode(canvasKey) {
    return !!this.settings.deepModeByCanvas?.[canvasKey || "default"];
  }

  async setDeepMode(canvasKey, enabled) {
    const key = canvasKey || "default";
    this.settings.deepModeByCanvas ||= {};
    if (enabled) this.settings.deepModeByCanvas[key] = true;
    else delete this.settings.deepModeByCanvas[key];
    await this.saveSettings();
  }

  touchCanvas(canvasKey) {
    const key = canvasKey || "default";
    this.settings.chatActivityByCanvas ||= {};
    this.settings.chatActivityByCanvas[key] = Date.now();
    this.saveSettings().catch(error => console.warn("Cannot save chat activity:", error));
  }

  async moveCanvasKey(oldKey, newKey) {
    if (!oldKey || !newKey || oldKey === newKey) return;

    let settingsChanged = false;
    if (Object.prototype.hasOwnProperty.call(this.settings.deepModeByCanvas || {}, oldKey)) {
      if (!Object.prototype.hasOwnProperty.call(this.settings.deepModeByCanvas, newKey)) {
        this.settings.deepModeByCanvas[newKey] = this.settings.deepModeByCanvas[oldKey];
      }
      delete this.settings.deepModeByCanvas[oldKey];
      settingsChanged = true;
    }
    if (Object.prototype.hasOwnProperty.call(this.settings.chatActivityByCanvas || {}, oldKey)) {
      this.settings.chatActivityByCanvas[newKey] = Math.max(
        Number(this.settings.chatActivityByCanvas[newKey]) || 0,
        Number(this.settings.chatActivityByCanvas[oldKey]) || 0
      );
      delete this.settings.chatActivityByCanvas[oldKey];
      settingsChanged = true;
    }
    if (settingsChanged) await this.saveSettings();

    if (Object.prototype.hasOwnProperty.call(this.chatHistories, oldKey)) {
      if (Object.prototype.hasOwnProperty.call(this.chatHistories, newKey)) {
        const recoveredKey = `__recovered__/${Date.now()}-${newKey}`;
        this.chatHistories[recoveredKey] = this.chatHistories[newKey];
        new Notice("У нового пути уже была старая история. Она сохранена отдельно, текущая история перенесена вместе с холстом.", 10000);
      }
      this.chatHistories[newKey] = this.chatHistories[oldKey];
      delete this.chatHistories[oldKey];
      await this.saveChatHistories();
    }

    const task = this.activeTasks.get(oldKey);
    if (task) {
      this.activeTasks.delete(oldKey);
      task.canvasKey = newKey;
      this.activeTasks.set(newKey, task);
      return;
    }

    this.moveAcpKey(oldKey, newKey);
  }

  moveAcpKey(oldKey, newKey) {
    const client = this.acpClient;
    if (!client) return;
    for (const map of [client.sessions, client.sessionPromises, client.sessionModels]) {
      if (map.has(oldKey)) {
        const value = map.get(oldKey);
        map.delete(oldKey);
        map.set(newKey, value);
      }
    }
  }

  finishCanvasKeyMigration(task) {
    if (!task || task.acpKey === task.canvasKey) return;
    this.moveAcpKey(task.acpKey, task.canvasKey);
    task.acpKey = task.canvasKey;
  }

  onunload() {
    console.log("Unloading Hermes Canvas OSINT Plugin");
    for (const task of this.activeTasks.values()) {
      clearTimeout(task.historyTimer);
      clearTimeout(task.renderTimer);
      this.checkpointChatTask(task, true)?.catch(() => {});
    }
    if (this.acpClient) {
      this.acpClient.stop();
    }
  }

  async loadSettings() {
    const saved = Object.assign({}, await this.loadData());
    for (const obsolete of ["engineMode", "apiKey", "apiBaseUrl", "model", "temperature", "systemPrompt", "deepMode"]) delete saved[obsolete];
    if (!saved.deepModeByCanvas || Array.isArray(saved.deepModeByCanvas) || typeof saved.deepModeByCanvas !== "object") saved.deepModeByCanvas = {};
    if (!saved.chatActivityByCanvas || Array.isArray(saved.chatActivityByCanvas) || typeof saved.chatActivityByCanvas !== "object") saved.chatActivityByCanvas = {};
    // До v2 время активности обновлялось при простом открытии холста, поэтому
    // старые значения нельзя использовать как время последнего сообщения.
    if (Number(saved.chatActivityVersion) < 2) saved.chatActivityByCanvas = {};
    saved.chatActivityVersion = 2;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.settings.deepModeByCanvas = Object.assign({}, saved.deepModeByCanvas);
    this.settings.chatActivityByCanvas = Object.assign({}, saved.chatActivityByCanvas);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  openSettings() {
    if (this.app.setting) {
      this.app.setting.open();
      if (typeof this.app.setting.openTabById === "function") {
        this.app.setting.openTabById(this.manifest.id);
      }
    }
  }

  async beautifyActiveCanvas() {
    const file = this.getActiveCanvasFile();
    if (!file) {
      new Notice("Откройте Canvas для выравнивания");
      return;
    }
    const content = await this.app.vault.read(file);
    let canvasData;
    try {
      canvasData = JSON.parse(content || '{"nodes":[],"edges":[]}');
    } catch (e) {
      new Notice("Ошибка чтения файла Canvas");
      return;
    }
    if (!Array.isArray(canvasData.nodes) || canvasData.nodes.length === 0) {
      new Notice("На холсте нет карточек для выравнивания");
      return;
    }
    beautifyCanvasLayout(canvasData);
    await this.app.vault.modify(file, JSON.stringify(canvasData, null, 2));

    const leaves = this.app.workspace.getLeavesOfType("canvas");
    for (const leaf of leaves) {
      if (leaf.view && leaf.view.file && leaf.view.file.path === file.path) {
        if (leaf.view.canvas && typeof leaf.view.canvas.setData === "function") {
          leaf.view.canvas.setData(canvasData);
          if (typeof leaf.view.canvas.requestSave === "function") {
            leaf.view.canvas.requestSave();
          }
          if (typeof leaf.view.canvas.zoomToFit === "function") {
            try { leaf.view.canvas.zoomToFit(); } catch (e) {}
          }
        }
      }
    }
    new Notice(`✨ Граф "${file.basename}" красиво выровнен!`);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_OSINT)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({
          type: VIEW_TYPE_OSINT,
          active: true,
        });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  getActiveCanvasFile() {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "canvas") {
      return activeFile;
    }

    const leaves = this.app.workspace.getLeavesOfType("canvas");
    for (const leaf of leaves) {
      if (leaf.view && leaf.view.file && leaf.view.file.extension === "canvas") {
        return leaf.view.file;
      }
    }

    const canvasFiles = this.app.vault.getFiles().filter(f => f.extension === "canvas");
    if (canvasFiles.length > 0) {
      return canvasFiles[0];
    }

    return null;
  }

  async getCanvasContext(targetCanvasFile = null) {
    const file = targetCanvasFile || this.getActiveCanvasFile();
    if (!file) return null;

    try {
      const content = await this.app.vault.read(file);
      const data = JSON.parse(content || "{}");
      const nodes = data.nodes || [];
      if (nodes.length === 0) return null;

      const summary = nodes.map(n => {
        const textSnippet = (n.text || "").replace(/\n+/g, " ").substring(0, 100);
        return `- [ID: "${n.id}", X: ${n.x}, Y: ${n.y}] ${textSnippet}`;
      }).join("\n");

      return {
        file: file.basename,
        nodesCount: nodes.length,
        summary: summary,
        nodes: nodes
      };
    } catch (e) {
      return null;
    }
  }

  async captureCanvasSnapshot(targetCanvasFile) {
    if (!targetCanvasFile) return "";
    try {
      return encodeCanvasSnapshot(await this.app.vault.read(targetCanvasFile));
    } catch (error) {
      console.warn("Cannot capture Canvas snapshot:", error);
      return "";
    }
  }

  async restoreCanvasSnapshot(targetCanvasFile, snapshot) {
    if (!targetCanvasFile || !snapshot) return false;
    const raw = decodeCanvasSnapshot(snapshot);
    if (!raw) return false;
    let data;
    try { data = JSON.parse(raw); }
    catch (_) { return false; }
    if (!Array.isArray(data.nodes)) data.nodes = [];
    if (!Array.isArray(data.edges)) data.edges = [];
    await this.app.vault.modify(targetCanvasFile, JSON.stringify(data, null, 2));
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      if (leaf.view?.file?.path !== targetCanvasFile.path) continue;
      if (leaf.view.canvas && typeof leaf.view.canvas.setData === "function") {
        leaf.view.canvas.setData(data);
        if (typeof leaf.view.canvas.requestSave === "function") leaf.view.canvas.requestSave();
      }
    }
    return true;
  }

  /**
   * Применение операций к холсту (Добавление СЛЕВА НАПРАВО, редактирование, удаление)
   */
  async applyCanvasActions(actions, targetCanvasFile = null) {
    let targetFile = null;
    if (typeof targetCanvasFile === "string") {
      targetFile = this.app.vault.getAbstractFileByPath(targetCanvasFile);
    } else if (targetCanvasFile && targetCanvasFile.path) {
      targetFile = this.app.vault.getAbstractFileByPath(targetCanvasFile.path) || targetCanvasFile;
    }
    if (!targetFile) {
      targetFile = this.getActiveCanvasFile();
    }

    if (!targetFile) {
      const defaultName = "Без названия.canvas";
      targetFile = await this.app.vault.create(defaultName, JSON.stringify({ nodes: [], edges: [] }));
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(targetFile);
    }

    const content = await this.app.vault.read(targetFile);
    let canvasData;
    try {
      canvasData = JSON.parse(content || '{"nodes":[],"edges":[]}');
    } catch (e) {
      canvasData = { nodes: [], edges: [] };
    }

    if (!Array.isArray(canvasData.nodes)) canvasData.nodes = [];
    if (!Array.isArray(canvasData.edges)) canvasData.edges = [];

    let modified = false;
    let deletedCount = 0;
    let updatedCount = 0;
    let addedCount = 0;

    // 1. УДАЛЕНИЕ
    const deleteIds = actions.delete_node_ids || [];
    if (Array.isArray(deleteIds) && deleteIds.length > 0) {
      const toDel = new Set(deleteIds.map(String));
      const beforeCount = canvasData.nodes.length;
      canvasData.nodes = canvasData.nodes.filter(n => !toDel.has(String(n.id)));
      canvasData.edges = canvasData.edges.filter(e => !toDel.has(String(e.fromNode)) && !toDel.has(String(e.toNode)));
      deletedCount = beforeCount - canvasData.nodes.length;
      if (deletedCount > 0) modified = true;
    }

    // 2. РЕДАКТИРОВАНИЕ
    const updateNodes = actions.update_nodes || [];
    if (Array.isArray(updateNodes) && updateNodes.length > 0) {
      const nodeMap = new Map(canvasData.nodes.map(n => [String(n.id), n]));
      for (const upd of updateNodes) {
        let targetNode = nodeMap.get(String(upd.id));

        // Умный поиск ноды если ID передан неточно (target, tgt, частичный ID или по заголовку)
        if (!targetNode && upd.id) {
          const reqId = String(upd.id).toLowerCase();
          if (reqId === "target" || reqId === "tgt") {
            targetNode = canvasData.nodes.find(n =>
              n.id.includes("tgt") || n.id === "target" ||
              String(n.text).includes("🎯") ||
              String(n.text).startsWith("## ")
            );
          } else {
            targetNode = canvasData.nodes.find(n =>
              String(n.id).toLowerCase().includes(reqId) ||
              reqId.includes(String(n.id).toLowerCase())
            );
          }
        }

        if (!targetNode && upd.text) {
          const firstLine = upd.text.split("\n")[0].replace(/^[#\s]+/, "").trim().toLowerCase();
          if (firstLine && firstLine.length > 4) {
            targetNode = canvasData.nodes.find(n => {
              const nFirst = String(n.text || "").split("\n")[0].replace(/^[#\s]+/, "").trim().toLowerCase();
              return nFirst.includes(firstLine) || firstLine.includes(nFirst);
            });
          }
        }

        if (targetNode) {
          if (upd.text) {
            targetNode.text = upd.text;
            const isTarget = targetNode.id.includes("tgt") || targetNode.id === "target" ||
                             String(targetNode.text).includes("🎯") ||
                             String(targetNode.text).startsWith("## ");
            const size = calculateCardDimensions(upd.text, isTarget, targetNode.type === "file", targetNode);
            targetNode.width = size.width;
            targetNode.height = size.height;
          }
          if (upd.color !== undefined) targetNode.color = upd.color;
          updatedCount++;
          modified = true;
        }
      }
    }

    // 3. ДОБАВЛЕНИЕ СЛЕВА НАПРАВО (С ЗАЩИТОЙ ОТ ДУБЛИКАТОВ)
    const newNodesList = actions.new_nodes || actions.nodes || [];
    if (Array.isArray(newNodesList) && newNodesList.length > 0) {
      const isFirstCreation = canvasData.nodes.length === 0;
      let rootNode = null;
      let childNodes = [];

      if (isFirstCreation) {
        rootNode = newNodesList.find(n => n.id === "target" || n.color === "6") || newNodesList[0];
        childNodes = newNodesList.filter(n => n !== rootNode);
      } else {
        childNodes = newNodesList;
      }

      const nodeMap = new Map(canvasData.nodes.map(n => [String(n.id), n]));
      const idMap = new Map();

      let rootNewId = null;
      if (rootNode) {
        rootNewId = rootNode.id || `node_${Date.now()}_tgt`;
        idMap.set(rootNode.id || "target", rootNewId);

        const rootText = `## ${rootNode.title || "🎯 ЦЕЛЬ"}\n\n${rootNode.content || rootNode.text || ""}`;
        const targetSize = calculateCardDimensions(rootText, true, false);
        const targetNodeObj = {
          id: rootNewId,
          type: "text",
          text: rootText,
          x: 0,
          y: 0,
          width: targetSize.width,
          height: targetSize.height
        };
        if (rootNode.color === "1") {
          targetNodeObj.color = "1";
        }
        canvasData.nodes.push(targetNodeObj);
        nodeMap.set(rootNewId, targetNodeObj);
        addedCount++;
      }

      const batchSeenTitles = new Set();

      for (let idx = 0; idx < childNodes.length; idx++) {
        const child = childNodes[idx];
        const cardTitle = child.title || child.label || "";
        let cardBody = child.content || child.text || "";
        if (!cardBody && child.attributes && typeof child.attributes === "object") {
          cardBody = Object.entries(child.attributes).map(([k, v]) => `• **${k}:** ${v}`).join("\n");
        }
        const cardText = cardTitle ? `### ${cardTitle}\n\n${cardBody}` : cardBody;
        const normTitle = normalizeTextForDedup(cardTitle || cardText.split("\n")[0]);

        // Внутрипакетная дедупликация (если модель повторила карточку в одном JSON-блоке)
        if (normTitle && normTitle.length >= 5 && batchSeenTitles.has(normTitle)) {
          continue;
        }
        if (normTitle && normTitle.length >= 5) {
          batchSeenTitles.add(normTitle);
        }

        // Проверяем: нет ли уже такой карточки на холсте (по ID, заголовку или тексту)
        const existing = findExistingNode(canvasData.nodes, child, cardTitle, cardBody);
        if (existing) {
          // ОБНОВЛЯЕМ существующую ноду вместо создания дубликата!
          if (cardBody && cardBody.length > 20) {
            existing.text = cardText;
          }
          const isTarget = existing.id.includes("tgt") || existing.id === "target" ||
                           String(existing.text).includes("🎯") ||
                           String(existing.text).startsWith("## ");
          const size = calculateCardDimensions(existing.text, isTarget, existing.type === "file", existing);
          existing.width = size.width;
          existing.height = size.height;
          if (child.color !== undefined) existing.color = child.color;

          idMap.set(child.id || cardTitle, existing.id);
          updatedCount++;
          modified = true;
          continue;
        }

        // Новая подтвержденная карточка
        const rawId = child.id ? String(child.id) : `node_${Date.now()}_${idx}`;
        const newId = canvasData.nodes.some(n => String(n.id) === rawId) ? `node_${Date.now()}_${idx}` : rawId;
        idMap.set(child.id || rawId, newId);

        const isHardInfo = child.color === "1" ||
          String(cardTitle).toLowerCase().includes("утечк") ||
          String(cardTitle).toLowerCase().includes("слив") ||
          String(cardTitle).toLowerCase().includes("компрометац") ||
          String(cardTitle).toLowerCase().includes("критич") ||
          String(child.category || "").toLowerCase().includes("leak");

        const size = calculateCardDimensions(cardText, false, false);

        const nodeObj = {
          id: newId,
          type: "text",
          text: cardText,
          x: 0,
          y: 0,
          width: size.width,
          height: size.height
        };
        if (isHardInfo) {
          nodeObj.color = "1";
        }

        canvasData.nodes.push(nodeObj);
        nodeMap.set(newId, nodeObj);
        addedCount++;

        let parentNodeId = null;
        if (child.parent_id) {
          parentNodeId = idMap.get(child.parent_id) || child.parent_id;
        } else if (rootNewId) {
          parentNodeId = rootNewId;
        } else if (canvasData.nodes.length > 0) {
          parentNodeId = canvasData.nodes[0].id;
        }

        if (parentNodeId && nodeMap.has(String(parentNodeId))) {
          canvasData.edges.push({
            id: `edge_${Date.now()}_${idx}`,
            fromNode: String(parentNodeId),
            fromSide: "right",
            toNode: newId,
            toSide: "left",
            label: ""
          });
        }
      }

      modified = true;
    }

    if (modified || addedCount > 0 || updatedCount > 0 || deletedCount > 0) {
      beautifyCanvasLayout(canvasData);
      await this.app.vault.modify(targetFile, JSON.stringify(canvasData, null, 2));

      const leaves = this.app.workspace.getLeavesOfType("canvas");
      for (const leaf of leaves) {
        if (leaf.view && leaf.view.file && leaf.view.file.path === targetFile.path) {
          if (leaf.view.canvas && typeof leaf.view.canvas.setData === "function") {
            leaf.view.canvas.setData(canvasData);
            if (typeof leaf.view.canvas.requestSave === "function") {
              leaf.view.canvas.requestSave();
            }
          }
        }
      }
    }

    const reportMsg = [];
    if (addedCount > 0) reportMsg.push(`+${addedCount} добавлено`);
    if (updatedCount > 0) reportMsg.push(`${updatedCount} обновлено`);
    if (deletedCount > 0) reportMsg.push(`-${deletedCount} удалено`);

    const summaryText = reportMsg.length > 0 ? reportMsg.join(", ") : "Холст синхронизирован";
    new Notice(`🎯 Холст "${targetFile.basename}": ${summaryText}`);

    return {
      file: targetFile.basename,
      added: addedCount,
      updated: updatedCount,
      deleted: deletedCount
    };
  }

  extractJson(text) {
    if (!text) return null;
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) {
      try { return JSON.parse(match[1]); } catch (e) {}
    }
    const b1 = text.indexOf("{");
    const b2 = text.lastIndexOf("}");
    if (b1 !== -1 && b2 > b1) {
      try { return JSON.parse(text.substring(b1, b2 + 1)); } catch (e) {}
    }
    return null;
  }
}

/**
 * Чат-интерфейс плагина с живым отображением вызовов тулок Hermes ACP
 */
class OsintChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.isLoading = false;
  }

  getViewType() { return VIEW_TYPE_OSINT; }
  getDisplayText() { return "OSINT Canvas"; }
  getIcon() { return "crosshair"; }

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.addClass("osint-chat-container");

    this.renderHeader(container);
    this.renderTabsBar(container);
    this.renderMessageArea(container);
    this.renderInputArea(container);

    this.loadCanvasChat();

    // 1. При переключении активной вкладки в основном окне Obsidian
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf) return;
        if (leaf.view === this) return; // Не сбрасывать выбранный холст при клике на чат
        const file = leaf.view?.file;
        if (file && file.extension === "canvas" && file.path !== this.currentFilePath) {
          this.handleCanvasSwitch(file, false);
        }
      })
    );

    // 2. При открытии файла холста
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && file.extension === "canvas" && file.path !== this.currentFilePath) {
          this.handleCanvasSwitch(file, false);
        }
      })
    );

    // 3. Отслеживание создания, удаления, переименования холстов в реальном времени
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file && file.extension === "canvas") {
          this.renderCanvasTabs();
          this.updateFileStatus();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file && file.extension === "canvas") {
          let settingsChanged = false;
          for (const mapName of ["deepModeByCanvas", "chatActivityByCanvas"]) {
            if (Object.prototype.hasOwnProperty.call(this.plugin.settings[mapName] || {}, file.path)) {
              delete this.plugin.settings[mapName][file.path];
              settingsChanged = true;
            }
          }
          if (settingsChanged) this.plugin.saveSettings().catch(() => {});
          if (this.currentFilePath === file.path) {
            this.currentFilePath = null;
          }
          this.renderCanvasTabs();
          this.updateFileStatus();
          this.loadCanvasChat();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file && file.extension === "canvas") {
          if (this.currentFilePath === oldPath) {
            this.currentFilePath = file.path;
          }
          this.plugin.moveCanvasKey(oldPath, file.path).finally(() => {
            this.renderCanvasTabs();
            this.updateFileStatus();
            this.loadCanvasChat();
          });
        }
      })
    );
  }

  handleCanvasSwitch(file, openInWorkspace = false) {
    if (!file || file.extension !== "canvas") return;
    if (this.currentFilePath === file.path && !openInWorkspace) return;

    this.currentFilePath = file.path;
    if (openInWorkspace) {
      this.openCanvasInWorkspace(file);
    }
    this.renderCanvasTabs();
    this.updateFileStatus();
    this.loadCanvasChat();
  }

  openCanvasInWorkspace(file) {
    if (!file) return;
    const leaves = this.app.workspace.getLeavesOfType("canvas");
    const existing = leaves.find(l => l.view?.file?.path === file.path);
    if (existing) {
      this.app.workspace.setActiveLeaf(existing, { focus: true });
    } else {
      this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  async createNewCanvas() {
    let baseName = "Новый холст";
    let count = 1;
    let path = `${baseName}.canvas`;
    while (await this.app.vault.adapter.exists(path)) {
      count++;
      path = `${baseName} ${count}.canvas`;
    }
    const initialContent = JSON.stringify({ nodes: [], edges: [] }, null, 2);
    const newFile = await this.app.vault.create(path, initialContent);
    this.handleCanvasSwitch(newFile, true);
    new Notice(`Создан холст: ${newFile.basename}`);
  }

  renderTabsBar(container) {
    this.tabsEl = container.createDiv({ cls: "osint-canvas-tabs" });
    this.renderCanvasTabs();
  }

  renderCanvasTabs() {
    if (!this.tabsEl) return;
    this.tabsEl.empty();

    const currentFile = this.getCurrentFile();
    const activity = this.plugin.settings.chatActivityByCanvas || {};
    const allCanvasFiles = this.app.vault.getFiles()
      .filter(f => f.extension === "canvas")
      .sort((a, b) => {
        const aTime = Number(activity[a.path]) || Number(a.stat?.mtime) || 0;
        const bTime = Number(activity[b.path]) || Number(b.stat?.mtime) || 0;
        return bTime - aTime || a.path.localeCompare(b.path);
      });

    const addTab = this.tabsEl.createDiv({
      cls: "osint-canvas-tab osint-tab-add",
      title: "Создать новый холст"
    });
    setIcon(addTab.createSpan(), "plus");
    addTab.addEventListener("click", async () => {
      await this.createNewCanvas();
    });

    allCanvasFiles.forEach(cf => {
      const isActive = currentFile && cf.path === currentFile.path;
      const isRunning = this.isCanvasLoading(cf.path);

      const tab = this.tabsEl.createDiv({
        cls: `osint-canvas-tab ${isActive ? 'active' : ''} ${isRunning ? 'running' : ''}`,
        title: cf.path
      });

      tab.createSpan({ cls: `osint-tab-dot ${isActive ? 'active' : ''} ${isRunning ? 'running' : ''}` });
      tab.createSpan({ cls: "osint-tab-title", text: cf.basename });

      tab.addEventListener("click", () => {
        if (!isActive) {
          this.handleCanvasSwitch(cf, true);
        }
      });
    });

  }

  getCurrentFile() {
    // 1. Если пользователь явно выбрал холст в плагине и файл существует — используем строго его!
    if (this.currentFilePath) {
      const f = this.app.vault.getAbstractFileByPath(this.currentFilePath);
      if (f && f instanceof TFile && f.extension === "canvas") {
        return f;
      }
    }
    // 2. Иначе смотрим активный файл в редакторе
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "canvas") {
      this.currentFilePath = activeFile.path;
      return activeFile;
    }
    // 3. Иначе первый попавшийся canvas-файл
    const all = this.app.vault.getFiles().filter(f => f.extension === "canvas");
    if (all.length > 0) {
      this.currentFilePath = all[0].path;
      return all[0];
    }
    return null;
  }

  getHistory(targetKey = null) {
    const file = this.getCurrentFile();
    const key = targetKey || (file ? file.path : (this.currentFilePath || "default"));
    if (!this.plugin.chatHistories[key]) {
      this.plugin.chatHistories[key] = [];
    }
    return this.plugin.chatHistories[key];
  }

  renderHeader(container) {
    const header = container.createDiv({ cls: "osint-chat-header" });

    const titleBox = header.createDiv({ cls: "osint-chat-title" });
    const iconSpan = titleBox.createSpan();
    setIcon(iconSpan, "crosshair");
    titleBox.createSpan({ text: "OSINT Canvas" });

    const actions = header.createDiv({ cls: "osint-header-actions" });

    this.modelSelectEl = actions.createEl("select", { cls: "osint-model-select", title: "Выбор модели" });
    this.modelSelectEl.addEventListener("change", async () => {
      await this.switchModel(this.modelSelectEl.value);
    });

    this.deepToggleEl = actions.createEl("button", {
      cls: "osint-deep-toggle",
      text: "DEEP",
      title: "Активный глубокий поиск до насыщения"
    });
    this.deepToggleEl.addEventListener("click", async () => {
      const canvasKey = this.getCurrentFile()?.path || this.currentFilePath || "default";
      const enabled = !this.plugin.isDeepMode(canvasKey);
      await this.plugin.setDeepMode(canvasKey, enabled);
      this.updateDeepModeUI();
    });

    const resetBtn = actions.createEl("button", { cls: "osint-icon-btn", title: "Сбросить контекст сессии" });
    setIcon(resetBtn, "rotate-ccw");
    resetBtn.addEventListener("click", async () => {
      const file = this.getCurrentFile();
      const canvasKey = file ? file.path : "default";
      this.showTyping("Сброс контекста...");
      try {
        await this.plugin.resetCanvasSession(canvasKey);
        this.hideTyping();
        this.appendAssistantMessageUI(`Сессия для "${file ? file.basename : 'холста'}" сброшена.`);
        new Notice("Контекст сессии сброшен");
      } catch(e) {
        this.hideTyping();
        new Notice(`Ошибка сброса: ${e.message}`);
      }
    });

    const clearBtn = actions.createEl("button", { cls: "osint-icon-btn", title: "Очистить историю чата" });
    setIcon(clearBtn, "trash");
    clearBtn.addEventListener("click", async () => {
      const file = this.getCurrentFile();
      const key = file ? file.path : "default";
      if (this.plugin.activeTasks.has(key)) { new Notice("Сначала завершите текущий запрос."); return; }
      this.plugin.chatHistories[key] = [];
      await this.plugin.resetCanvasSession(key);
      this.loadCanvasChat();
      new Notice("История чата очищена");
    });

    const layoutBtn = actions.createEl("button", { cls: "osint-icon-btn", title: "Красиво выровнять граф (Auto-layout)" });
    setIcon(layoutBtn, "layout-grid");
    layoutBtn.addEventListener("click", async () => {
      await this.plugin.beautifyActiveCanvas();
    });

    const cfgBtn = actions.createEl("button", { cls: "osint-icon-btn", title: "Настройки" });
    setIcon(cfgBtn, "settings");
    cfgBtn.addEventListener("click", () => this.plugin.openSettings());

    this.updateFileStatus();
  }

  updateFileStatus() {
    const curModel = this.plugin.acpClient?.sessionModels.get(this.getCurrentFile()?.path || "default")
      || this.plugin.acpClient?.currentModel || this.plugin.settings.acpModel || "Модель Hermes";

    if (this.modelSelectEl) {
      this.modelSelectEl.empty();
      // Сгруппировано по провайдеру: иначе 600+ пунктов идут вперемешку.
      let group = null;
      let groupName = null;
      for (const model of sortAcpModels(this.plugin.acpClient?.availableModels, curModel)) {
        const provider = model.provider || "без префикса";
        if (provider !== groupName) {
          groupName = provider;
          group = this.modelSelectEl.createEl("optgroup", { attr: { label: provider } });
        }
        group.createEl("option", { value: model.modelId, text: model.name || model.modelId });
      }
      let found = false;
      for (let i = 0; i < this.modelSelectEl.options.length; i++) {
        if (this.modelSelectEl.options[i].value === curModel) {
          found = true;
          break;
        }
      }
      if (!found && curModel) {
        const customOpt = this.modelSelectEl.createEl("option", { value: curModel, text: curModel });
        customOpt.selected = true;
      } else if (found) {
        this.modelSelectEl.value = curModel;
      }
    }
    this.updateDeepModeUI();
  }

  updateDeepModeUI() {
    if (!this.deepToggleEl) return;
    const canvasKey = this.getCurrentFile()?.path || this.currentFilePath || "default";
    const enabled = this.plugin.isDeepMode(canvasKey);
    this.deepToggleEl.classList.toggle("active", enabled);
    this.deepToggleEl.setAttribute("aria-pressed", String(enabled));
    this.deepToggleEl.setAttribute("title", enabled
      ? "Deep включён: активный поиск до насыщения"
      : "Deep выключен: обычный режим");
  }

  renderMessageArea(container) {
    this.messagesEl = container.createDiv({ cls: "osint-messages-area" });
  }

  async loadCanvasChat() {
    this.renderCanvasTabs();
    this.updateFileStatus();
    this.messagesEl.empty();

    const currentFile = this.getCurrentFile();
    const canvasKey = currentFile ? currentFile.path : (this.currentFilePath || "default");
    const history = this.getHistory(canvasKey);
    const activeTask = this.plugin.activeTasks?.get(canvasKey);

    // 1. Верхний информационный баннер холста (показывает, в каком именно холсте находимся)
    if (currentFile) {
      const banner = this.messagesEl.createDiv({ cls: "osint-canvas-banner" });
      const leftCol = banner.createDiv({ cls: "osint-banner-col" });

      const titleRow = leftCol.createDiv({ cls: "osint-banner-title-row" });
      const iconSpan = titleRow.createSpan();
      setIcon(iconSpan, "layout");
      titleRow.createSpan({ text: currentFile.basename, cls: "osint-banner-name" });

      const metaRow = leftCol.createDiv({ cls: "osint-banner-meta" });
      let nodeCount = 0;
      try {
        const ctx = await this.plugin.getCanvasContext(currentFile);
        nodeCount = ctx ? ctx.nodesCount : 0;
      } catch (e) {}

      const isRunning = this.isCanvasLoading(canvasKey);
      const statusText = isRunning ? "выполняется сбор данных" : (history.length > 0 ? "завершено" : "пустой холст");
      metaRow.createSpan({ text: `${nodeCount} карточек • ${history.length} сообщ. • ${statusText}` });

      const openBtn = banner.createEl("button", { cls: "osint-banner-btn", text: "Открыть холст" });
      openBtn.addEventListener("click", () => {
        this.openCanvasInWorkspace(currentFile);
      });
    }

    if (history.length === 0 && (!activeTask || activeTask.isDone)) {
      this.appendWelcomeMessage(currentFile);
    } else {
      for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
        const msg = history[messageIndex];
        if (msg.role === "user") {
          this.appendUserMessageUI(msg.content, msg, messageIndex, canvasKey);
        } else if (msg.role === "assistant") {
          this.appendAssistantMessageUI(msg.content, msg.stats, msg.pivots, msg.toolLogs, msg.sources);
        }
      }
    }

    if (activeTask && !activeTask.isDone) {
      this.restoreActiveTaskUI(activeTask);
    } else {
      this.hideTyping();
    }

    this.updateInputControls();
    this.scrollToBottom();
    const recoverableFollowUps = !activeTask ? history.filter(message => message?.role === "user" && message.queued) : [];
    if (recoverableFollowUps.length) {
      setTimeout(() => this.runQueuedFollowUps({
        canvasKey,
        followUps: recoverableFollowUps.map(message => ({ message, row: null }))
      }).catch(error => {
        console.warn("Cannot recover queued follow-up:", error);
        new Notice(`Не удалось восстановить follow-up: ${error.message || error}`);
      }), 0);
    }
  }

  isCanvasLoading(canvasKey = null) {
    const key = canvasKey || (this.getCurrentFile() ? this.getCurrentFile().path : (this.currentFilePath || "default"));
    const task = this.plugin.activeTasks?.get(key);
    return !!task;
  }

  updateInputControls() {
    const isRunning = this.isCanvasLoading();
    const key = this.getCurrentFile()?.path || this.currentFilePath || "default";
    const activeTask = this.plugin.activeTasks?.get(key);
    if (this.stopBtn) {
      this.stopBtn.style.display = isRunning ? "inline-flex" : "none";
      this.stopBtn.disabled = !!activeTask?.cancelRequested;
      this.stopBtn.title = activeTask?.cancelRequested ? "Останавливаю и восстанавливаю ACP..." : "Остановить";
    }
    if (this.sendBtn) {
      if (isRunning) {
        this.sendBtn.title = "Добавить следующее сообщение (follow-up)";
      } else {
        this.sendBtn.title = "Отправить";
      }
    }
  }

  restoreActiveTaskUI(task) {
    this.showTyping("Исследование...");
    this.updateInputControls();

    const liveRow = this.messagesEl.createDiv({ cls: "osint-msg-row assistant" });
    const liveBubble = liveRow.createDiv({ cls: "osint-bubble assistant" });

    const liveToolsBox = liveBubble.createDiv({ cls: "osint-tool-box", style: "margin-bottom:8px;" });
    liveToolsBox.createDiv({ cls: "osint-tool-title", text: "Действия агента:" });
    const liveToolsList = liveToolsBox.createDiv({ cls: "osint-tool-list" });

    const visibleTaskLogs = (task.toolLogs || []).filter(log => !/\[object Object\]/i.test(String(log)));
    if (visibleTaskLogs.length > 0) {
      visibleTaskLogs.forEach(toolTitle => {
        const tItem = liveToolsList.createDiv({ cls: "osint-tool-item" });
        tItem.setText(toolTitle);
      });
    } else if (task.currentStatus) {
      liveToolsList.createDiv({ cls: "osint-tool-item muted", text: task.currentStatus });
    }

    const liveContent = liveBubble.createDiv({ cls: "osint-markdown-content" });
    const cleanSoFar = (task.streamedChunks || "").replace(/```(?:json|canvas)?[\s\S]*?```/g, "").trim();
    if (cleanSoFar) {
      MarkdownRenderer.render(this.plugin.app, cleanSoFar, liveContent, "", this);
    } else {
      liveContent.setText("Выполнение запросов...");
    }

    task.liveBubble = liveBubble;
    task.liveToolsList = liveToolsList;
    task.liveContent = liveContent;

    this.scrollToBottom();
  }

  renderSourcesDetails(bubble, text, explicitSources = []) {
    const sources = extractSources(text, explicitSources);
    if (!sources.length) return sources;
    const details = bubble.createEl("details", { cls: "osint-sources-details" });
    const summary = details.createEl("summary", { cls: "osint-sources-summary" });
    summary.setText(`Источники (${sources.length})`);
    const list = details.createEl("ol", { cls: "osint-sources-list" });
    for (const source of sources) {
      const item = list.createEl("li");
      const link = item.createEl("a", {
        text: source.title || source.url,
        href: source.url,
        title: source.url
      });
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
    return sources;
  }

  finalizeLiveBubbleUI(bubble, text, stats, pivots, sources = []) {
    if (!bubble) return;

    const copyBtn = bubble.createEl("button", {
      cls: "osint-copy-btn",
      title: "Копировать текст"
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", () => {
      let rawText = (text || "").replace(/```(?:json|canvas)?[\s\S]*?```/g, "").trim();
      navigator.clipboard.writeText(rawText || text);
      copyBtn.empty();
      setIcon(copyBtn, "check");
      new Notice("Скопировано в буфер");
      setTimeout(() => {
        copyBtn.empty();
        setIcon(copyBtn, "copy");
      }, 1500);
    });

    if (stats && (stats.added > 0 || stats.updated > 0 || stats.deleted > 0)) {
      const badge = bubble.createDiv({ cls: "osint-cards-badge" });
      const parts = [];
      if (stats.added > 0) parts.push(`+${stats.added} добавлено`);
      if (stats.updated > 0) parts.push(`~${stats.updated} обновлено`);
      if (stats.deleted > 0) parts.push(`-${stats.deleted} удалено`);
      badge.setText(`Холст: ${parts.join(", ")}`);
    }

    this.renderSourcesDetails(bubble, text, sources);

    if (pivots && Array.isArray(pivots) && pivots.length > 0) {
      const pivotBox = bubble.createDiv({ cls: "osint-pivots-box" });
      pivotBox.createDiv({ cls: "osint-pivots-title", text: "Связанные ветки:" });
      const pillsContainer = pivotBox.createDiv({ cls: "osint-pivots-pills" });
      pivots.forEach(p => {
        const pStr = String(p).trim();
        if (!pStr) return;
        const pill = pillsContainer.createSpan({ cls: "osint-pivot-pill", text: pStr, title: pStr });
        pill.addEventListener("click", () => {
          this.textarea.value = `Углубись в ветку: "${pStr}".`;
          this.handleSend();
        });
      });
    }
  }

  appendWelcomeMessage(currentFile = null) {
    const msg = this.messagesEl.createDiv({ cls: "osint-msg osint-msg-system" });
    const box = msg.createDiv({ cls: "osint-welcome-text" });

    const baseName = currentFile ? currentFile.basename : "";
    const isTargetLike = /[\+\d\s\(\)-]{7,}/.test(baseName) && baseName.replace(/\D/g, "").length >= 10;

    if (isTargetLike) {
      box.createDiv({ text: `Холст подготовлен для объекта: ${baseName}` });
      const quickBtn = box.createEl("button", {
        text: `Запустить поиск по номеру ${baseName}`,
        cls: "osint-quickstart-btn",
        style: "margin-top:8px; cursor:pointer;"
      });
      quickBtn.addEventListener("click", () => {
        this.textarea.value = `Проведи OSINT по номеру телефона: ${baseName}`;
        this.handleSend();
      });
    } else {
      box.createDiv({ text: "Введи цель исследования: телефон, email, никнейм, домен или ФИО." });
    }
  }

  renderInputArea(container) {
    const inputArea = container.createDiv({ cls: "osint-input-area" });

    const quickBar = inputArea.createDiv({ cls: "osint-quick-bar" });
    const quicks = [
      { label: "Телефон", prefix: "Анализ по номеру телефона: " },
      { label: "Никнейм", prefix: "Сбор цифрового следа по нику: " },
      { label: "Email", prefix: "Поиск по email: " },
      { label: "Домен / IP", prefix: "Анализ инфраструктуры: " },
      { label: "Глубокий поиск", prefix: "/deep Активно исследуй и развивай все найденные связи по цели: " },
      { label: "/reset", prefix: "/reset" },
      { label: "/stop", prefix: "/stop" }
    ];

    quicks.forEach(q => {
      const pill = quickBar.createSpan({ cls: "osint-pill", text: q.label });
      pill.addEventListener("click", () => {
        this.textarea.value = q.prefix;
        if (q.prefix === "/stop" || q.prefix === "/reset") {
          this.handleSend();
        } else {
          this.textarea.focus();
        }
      });
    });

    const box = inputArea.createDiv({ cls: "osint-textarea-box" });
    this.textarea = box.createEl("textarea", {
      cls: "osint-textarea",
      placeholder: "Введи цель (телефон, ник, домен) или команду (/stop, /reset, /model)..."
    });

    this.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    this.stopBtn = box.createEl("button", {
      cls: "osint-stop-btn",
      title: "Остановить генерацию (/stop)",
      style: "display:none;"
    });
    setIcon(this.stopBtn, "square");
    this.stopBtn.addEventListener("click", () => {
      this.handleStop();
    });

    this.sendBtn = box.createEl("button", {
      cls: "osint-send-btn",
      title: "Отправить"
    });
    setIcon(this.sendBtn, "send");
    this.sendBtn.addEventListener("click", () => {
      this.handleSend();
    });
    this.updateInputControls();
  }

  appendUserMessageUI(text, message = null, messageIndex = -1, canvasKey = null) {
    const row = this.messagesEl.createDiv({ cls: "osint-msg-row user" });
    const stack = row.createDiv({ cls: "osint-user-message-stack" });
    const bubble = stack.createDiv({ cls: "osint-bubble user" });
    bubble.setText(text);

    if (message && messageIndex >= 0) {
      const controls = stack.createDiv({ cls: "osint-user-message-controls" });
      if (message.queued) {
        controls.createSpan({ cls: "osint-queued-label", text: "Следующее сообщение" });
        this.scrollToBottom();
        return row;
      }
      const editBtn = controls.createEl("button", { cls: "osint-user-message-btn", title: "Редактировать сообщение" });
      setIcon(editBtn, "pencil");
      editBtn.addEventListener("click", () => {
        const key = canvasKey || this.getCurrentFile()?.path || this.currentFilePath || "default";
        if (this.plugin.activeTasks.has(key)) {
          new Notice("Сначала остановите или дождитесь текущего ответа.");
          return;
        }
        this.beginUserMessageEdit(stack, bubble, controls, message, messageIndex, key);
      });

      const group = message.branchGroup;
      if (group && Array.isArray(group.variants) && group.variants.length > 1) {
        const active = Math.max(0, Math.min(Number(group.active) || 0, group.variants.length - 1));
        const prevBtn = controls.createEl("button", { cls: "osint-user-message-btn", title: "Предыдущая ветка" });
        setIcon(prevBtn, "chevron-left");
        prevBtn.disabled = active <= 0;
        prevBtn.addEventListener("click", () => this.switchUserMessageBranch(canvasKey, messageIndex, active - 1));
        controls.createSpan({ cls: "osint-branch-counter", text: `${active + 1}/${group.variants.length}` });
        const nextBtn = controls.createEl("button", { cls: "osint-user-message-btn", title: "Следующая ветка" });
        setIcon(nextBtn, "chevron-right");
        nextBtn.disabled = active >= group.variants.length - 1;
        nextBtn.addEventListener("click", () => this.switchUserMessageBranch(canvasKey, messageIndex, active + 1));
      }
    }
    this.scrollToBottom();
    return row;
  }

  async runQueuedFollowUps(completedTask) {
    const canvasKey = completedTask.canvasKey;
    this.followUpDispatches ||= new Set();
    if (this.followUpDispatches.has(canvasKey)) return;
    this.followUpDispatches.add(canvasKey);
    try {
      const entries = Array.isArray(completedTask.followUps) ? completedTask.followUps : [];
      const queuedMessages = entries.map(entry => entry.message).filter(Boolean);
      if (!queuedMessages.length) return;
      const history = this.getHistory(canvasKey);
      const present = queuedMessages.filter(message => history.includes(message));
      if (!present.length) return;
      const file = this.app.vault.getAbstractFileByPath(canvasKey);
      const snapshot = file instanceof TFile ? await this.plugin.captureCanvasSnapshot(file) : "";
      for (const message of present) {
        message.queued = false;
        message.canvasSnapshotBefore = snapshot;
      }
      await this.plugin.saveChatHistories();
      if (this.currentFilePath === canvasKey) await this.loadCanvasChat();
      const combinedText = present.map(message => message.content).join("\n\n[ЕЩЁ ОДНО ДОПОЛНЕНИЕ ПОЛЬЗОВАТЕЛЯ]\n");
      const firstIndex = history.indexOf(present[0]);
      await this.handleSend({
        text: combinedText,
        canvasKey,
        dispatchQueued: true,
        existingUserMessages: present,
        currentUserStartIndex: firstIndex >= 0 ? firstIndex : Math.max(0, history.length - present.length),
        canvasSnapshotBefore: snapshot
      });
    } finally {
      this.followUpDispatches.delete(canvasKey);
    }
  }

  beginUserMessageEdit(stack, bubble, controls, message, messageIndex, canvasKey) {
    stack.addClass("editing");
    bubble.empty();
    controls.empty();
    const editor = bubble.createEl("textarea", { cls: "osint-user-message-editor" });
    editor.value = message.content || "";
    const actions = controls.createDiv({ cls: "osint-user-edit-actions" });
    const cancelBtn = actions.createEl("button", { text: "Отмена" });
    const saveBtn = actions.createEl("button", { cls: "mod-cta", text: "Сохранить и отправить" });
    const cancel = () => this.loadCanvasChat();
    const save = async () => {
      const value = editor.value.trim();
      if (!value) { new Notice("Сообщение не может быть пустым."); return; }
      if (value.startsWith("/")) { new Notice("При редактировании нельзя заменять запрос служебной командой."); return; }
      if (value === String(message.content || "").trim()) { cancel(); return; }
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      try {
        await this.editUserMessage(canvasKey, messageIndex, value);
      } catch (error) {
        console.warn("Cannot edit user message:", error);
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        new Notice(`Не удалось создать ветку: ${error.message || error}`);
      }
    };
    cancelBtn.addEventListener("click", cancel);
    saveBtn.addEventListener("click", save);
    editor.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
      else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
    });
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  async editUserMessage(canvasKey, messageIndex, newText) {
    const history = this.getHistory(canvasKey);
    const message = history[messageIndex];
    if (!message || message.role !== "user") return;
    if (this.plugin.activeTasks.has(canvasKey)) {
      new Notice("Сначала остановите или дождитесь текущего ответа.");
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(canvasKey);
    const currentCanvasState = file instanceof TFile ? await this.plugin.captureCanvasSnapshot(file) : "";
    let group = message.branchGroup;
    if (!group || !Array.isArray(group.variants)) {
      group = {
        id: crypto.randomUUID(), active: 0,
        baseCanvasSnapshot: message.canvasSnapshotBefore || "",
        variants: [{ content: message.content || "", tail: history.slice(messageIndex + 1), canvasState: currentCanvasState }]
      };
    } else {
      const active = Math.max(0, Math.min(Number(group.active) || 0, group.variants.length - 1));
      group.variants[active] = {
        ...group.variants[active], content: message.content || "",
        tail: history.slice(messageIndex + 1), canvasState: currentCanvasState
      };
      if (!group.baseCanvasSnapshot) group.baseCanvasSnapshot = message.canvasSnapshotBefore || "";
    }

    const baseSnapshot = message.canvasSnapshotBefore || group.baseCanvasSnapshot || "";
    group.variants.push({ content: newText, tail: [], canvasState: baseSnapshot });
    group.active = group.variants.length - 1;
    this.plugin.chatHistories[canvasKey] = history.slice(0, messageIndex);

    let restored = false;
    if (file instanceof TFile && baseSnapshot) restored = await this.plugin.restoreCanvasSnapshot(file, baseSnapshot);
    try { await this.plugin.acpClient.resetSession(canvasKey); }
    catch (error) { console.warn("ACP reset before edited message:", error); }
    this.plugin.touchCanvas(canvasKey);
    await this.loadCanvasChat();
    if (!restored && file instanceof TFile) {
      new Notice("Для старого сообщения нет снимка Canvas: чат разветвлён, но карточки старой ветки автоматически не откатились.", 9000);
    }
    await this.handleSend({ text: newText, branchGroup: group, canvasSnapshotBefore: baseSnapshot });
  }

  async switchUserMessageBranch(canvasKey, messageIndex, targetIndex) {
    if (this.plugin.activeTasks.has(canvasKey)) {
      new Notice("Сначала остановите или дождитесь текущего ответа.");
      return;
    }
    const history = this.getHistory(canvasKey);
    const message = history[messageIndex];
    const group = message?.branchGroup;
    if (!group || !Array.isArray(group.variants) || !group.variants[targetIndex]) return;
    const active = Math.max(0, Math.min(Number(group.active) || 0, group.variants.length - 1));
    if (active === targetIndex) return;

    const file = this.app.vault.getAbstractFileByPath(canvasKey);
    const currentCanvasState = file instanceof TFile ? await this.plugin.captureCanvasSnapshot(file) : "";
    group.variants[active] = {
      ...group.variants[active], content: message.content || "",
      tail: history.slice(messageIndex + 1), canvasState: currentCanvasState
    };
    const target = group.variants[targetIndex];
    group.active = targetIndex;
    const targetMessage = {
      ...message, content: target.content || "", branchGroup: group,
      canvasSnapshotBefore: message.canvasSnapshotBefore || group.baseCanvasSnapshot || ""
    };
    this.plugin.chatHistories[canvasKey] = [
      ...history.slice(0, messageIndex), targetMessage,
      ...(Array.isArray(target.tail) ? target.tail : [])
    ];
    const targetCanvasState = target.canvasState || group.baseCanvasSnapshot || "";
    if (file instanceof TFile && targetCanvasState) await this.plugin.restoreCanvasSnapshot(file, targetCanvasState);
    await this.plugin.saveChatHistories();
    try { await this.plugin.acpClient.resetSession(canvasKey); }
    catch (error) { console.warn("ACP reset after branch switch:", error); }
    await this.loadCanvasChat();
  }

  appendAssistantMessageUI(text, stats, pivots, toolLogs, sources = []) {
    const row = this.messagesEl.createDiv({ cls: "osint-msg-row assistant" });
    const bubble = row.createDiv({ cls: "osint-bubble assistant" });

    const copyBtn = bubble.createEl("button", {
      cls: "osint-copy-btn",
      title: "Копировать текст сообщения"
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", () => {
      let rawText = text.replace(/```(?:json|canvas)?[\s\S]*?```/g, "").trim();
      if (!rawText) rawText = text;
      navigator.clipboard.writeText(rawText);
      copyBtn.empty();
      setIcon(copyBtn, "check");
      new Notice("Текст скопирован в буфер");
      setTimeout(() => {
        copyBtn.empty();
        setIcon(copyBtn, "copy");
      }, 1500);
    });

    // Лог инструментов (сворачиваемый, минималистичный)
    const visibleToolLogs = Array.isArray(toolLogs)
      ? toolLogs.filter(log => !/\[object Object\]/i.test(String(log)))
      : [];
    if (visibleToolLogs.length > 0) {
      const details = bubble.createEl("details", { cls: "osint-tool-details" });
      const summary = details.createEl("summary", { cls: "osint-tool-summary" });
      summary.setText(`Действия (${visibleToolLogs.length})`);
      const tList = details.createDiv({ cls: "osint-tool-list" });
      visibleToolLogs.forEach(t => {
        const item = tList.createDiv({ cls: "osint-tool-item" });
        item.setText(t);
      });
    }

    let cleanText = text.replace(/```(?:json)?[\s\S]*?```/g, "").trim();
    const textContainer = bubble.createDiv({ cls: "osint-markdown-content" });
    MarkdownRenderer.render(this.plugin.app, cleanText || "Данные обработаны.", textContainer, "", this);

    // Если в ответе прилетела ошибка 503 перегрузки
    if (text.includes("503") || text.includes("Chat admission capacity")) {
      const errRetryBox = bubble.createDiv({ style: "display:flex; gap:8px; margin-top:8px; padding-top:6px; border-top:1px dashed var(--background-modifier-border);" });
      const rBtn = errRetryBox.createEl("button", { text: "Повторить запрос", style: "cursor:pointer; padding:4px 10px; font-size:12px; border-radius:4px;" });
      rBtn.addEventListener("click", () => {
        const history = this.getHistory();
        const lastUser = [...history].reverse().find(m => m.role === "user");
        if (lastUser && lastUser.content) {
          this.textarea.value = lastUser.content;
          this.handleSend();
        }
      });
      const resetBtn = errRetryBox.createEl("button", { text: "Сбросить сессию (0 токенов)", style: "cursor:pointer; padding:4px 10px; font-size:12px; border-radius:4px;" });
      resetBtn.addEventListener("click", async () => {
        const file = this.getCurrentFile();
        const canvasKey = file ? file.path : "default";
        await this.plugin.resetCanvasSession(canvasKey);
        new Notice("Контекст сброшен");
        const history = this.getHistory();
        const lastUser = [...history].reverse().find(m => m.role === "user");
        if (lastUser && lastUser.content) {
          this.textarea.value = lastUser.content;
          this.handleSend();
        }
      });
    }

    if (stats && (stats.added > 0 || stats.updated > 0 || stats.deleted > 0)) {
      const badge = bubble.createDiv({ cls: "osint-cards-badge" });
      const parts = [];
      if (stats.added > 0) parts.push(`+${stats.added} добавлено`);
      if (stats.updated > 0) parts.push(`~${stats.updated} обновлено`);
      if (stats.deleted > 0) parts.push(`-${stats.deleted} удалено`);
      badge.setText(`Холст: ${parts.join(", ")}`);
    }

    this.renderSourcesDetails(bubble, text, sources);

    if (pivots && Array.isArray(pivots) && pivots.length > 0) {
      const pivotBox = bubble.createDiv({ cls: "osint-pivots-box" });
      pivotBox.createDiv({ cls: "osint-pivots-title", text: "Связанные ветки:" });

      const pillsContainer = pivotBox.createDiv({ cls: "osint-pivots-pills" });
      pivots.forEach(p => {
        const pStr = String(p).trim();
        if (!pStr) return;
        const pill = pillsContainer.createSpan({ cls: "osint-pivot-pill", text: pStr, title: pStr });
        pill.addEventListener("click", () => {
          this.textarea.value = `Углубись в ветку: "${pStr}".`;
          this.handleSend();
        });
      });
    }

    this.scrollToBottom();
  }

  showTyping(statusText = "Hermes запускает разведку...") {
    this.updateInputControls();
    this.typingRow = this.messagesEl.createDiv({ cls: "osint-msg-row assistant typing" });
    this.typingBubble = this.typingRow.createDiv({ cls: "osint-bubble assistant typing-bubble" });
    this.typingBubble.innerHTML = `<span class="osint-spinner"></span> <em>${statusText}</em>`;
    this.scrollToBottom();
  }

  updateTyping(statusText) {
    if (this.typingBubble) {
      const em = this.typingBubble.querySelector("em");
      if (em) em.setText(statusText);
    }
  }

  appendLiveToolLog(toolName) {
    if (this.typingBubble) {
      let logBox = this.typingBubble.querySelector(".osint-live-tools");
      if (!logBox) {
        logBox = this.typingBubble.createDiv({ cls: "osint-live-tools", style: "margin-top:6px;font-size:11px;opacity:0.8;" });
      }
      const item = logBox.createDiv();
      item.setText(`⚙️ ${toolName}`);
      this.scrollToBottom();
    }
  }

  hideTyping() {
    this.updateInputControls();
    if (this.typingRow) {
      this.typingRow.remove();
      this.typingRow = null;
      this.typingBubble = null;
    }
  }

  handleStop() {
    const file = this.getCurrentFile();
    const canvasKey = file ? file.path : (this.currentFilePath || "default");
    const activeTask = this.plugin.activeTasks?.get(canvasKey);
    if (!activeTask && !this.isCanvasLoading(canvasKey)) return;

    if (!activeTask || activeTask.cancelRequested) return;
    activeTask.cancelRequested = true;
    activeTask.currentStatus = "Останавливаю и проверяю состояние ACP...";
    this.plugin.checkpointChatTask(activeTask, true)?.catch(() => {});
    this.plugin.acpClient.cancel(activeTask.acpKey || canvasKey);
    this.updateTyping("Останавливаю и восстанавливаю ACP...");
    this.updateInputControls();
    new Notice("Останавливаю генерацию...");
  }

  appendModelChooserUI(currentModel) {
    const row = this.messagesEl.createDiv({ cls: "osint-msg-row assistant" });
    const bubble = row.createDiv({ cls: "osint-bubble assistant" });

    bubble.createEl("h3", { text: "🤖 Управление моделью" });
    const p = bubble.createEl("p");
    p.createEl("strong", { text: "Текущая активная модель: " });
    p.createEl("code", { text: currentModel });

    const models = sortAcpModels(this.plugin.acpClient?.availableModels, currentModel);
    if (!models.length) {
      bubble.createEl("p", { text: "Список моделей приходит от Hermes при подключении. Подключитесь через «Применить и проверить» либо задайте ID вручную: /model provider/model." });
      this.scrollToBottom();
      return;
    }

    const byProvider = new Map();
    for (const model of models) byProvider.set(model.provider || "без префикса", (byProvider.get(model.provider || "без префикса") || 0) + 1);
    const providers = [...byProvider.entries()].sort((a, b) => b[1] - a[1]);

    bubble.createEl("p", { text: `Доступно моделей: ${models.length}. Провайдеры: ${providers.slice(0, 6).map(([name, count]) => `${name} (${count})`).join(", ")}${providers.length > 6 ? " и др." : ""}` });

    const openBtn = bubble.createEl("button", { cls: "mod-cta", text: "🔍 Найти модель" });
    openBtn.addEventListener("click", () => this.openModelPicker());

    const hint = bubble.createEl("p", { attr: { style: "font-size:11px;opacity:0.7;margin-top:8px" } });
    hint.setText("Или сразу: /model gemini — откроет поиск с этим запросом. Точный ID переключает без диалога.");

    this.scrollToBottom();
  }

  openModelPicker(initialQuery = "") {
    const currentModel = this.plugin.acpClient?.sessionModels.get(this.getCurrentFile()?.path || "default")
      || this.plugin.acpClient?.currentModel || this.plugin.settings.acpModel || "";
    const models = sortAcpModels(this.plugin.acpClient?.availableModels, currentModel);
    if (!models.length) {
      new Notice("Список моделей ещё не получен. Подключитесь к Hermes или укажите ID вручную: /model provider/model");
      return;
    }
    new ModelPickerModal(this.app, models, currentModel, modelId => this.switchModel(modelId), initialQuery).open();
  }

  async switchModel(targetModel) {
    this.showTyping(`Смена модели на ${targetModel}...`);
    try {
      await this.plugin.acpClient.setModel(targetModel, this.getCurrentFile()?.path || "default");
      this.plugin.settings.acpModel = targetModel;
      await this.plugin.saveSettings();
      this.updateFileStatus();
      this.hideTyping();
      this.appendAssistantMessageUI(`✅ **Модель успешно переключена на:** \`${targetModel}\``);
      new Notice(`Модель: ${targetModel}`);
    } catch (err) {
      this.hideTyping();
      this.appendAssistantMessageUI(`❌ Ошибка переключения модели: ${err.message || err}`);
    }
  }

  scrollToBottom() {
    if (this.messagesEl) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }

  async handleSend(options = {}) {
    const raw = (typeof options.text === "string" ? options.text : this.textarea.value).trim();
    if (!raw) return;

    const forcedCanvasKey = typeof options.canvasKey === "string" ? options.canvasKey : "";
    const forcedFile = forcedCanvasKey ? this.app.vault.getAbstractFileByPath(forcedCanvasKey) : null;
    const activeFile = forcedFile instanceof TFile ? forcedFile : this.getCurrentFile();
    const canvasKey = forcedCanvasKey || (activeFile ? activeFile.path : (this.currentFilePath || "default"));
    const isRunning = (this.isCanvasLoading(canvasKey) || !!this.followUpDispatches?.has(canvasKey)) && !options.dispatchQueued;

    // 1. КОМАНДА /stop
    if (raw === "/stop") {
      this.textarea.value = "";
      this.handleStop();
      return;
    }

    if (isRunning) {
      const activeTask = this.plugin.activeTasks?.get(canvasKey);
      if (!activeTask || activeTask.cancelRequested) {
        new Notice(activeTask
          ? "Сейчас завершается отмена. Отправьте сообщение ещё раз после остановки."
          : "Предыдущее follow-up уже передаётся Hermes. Сообщение осталось в поле ввода.");
        return;
      }
      if (raw.startsWith("/")) {
        new Notice("Служебную команду нельзя поставить в follow-up. Сначала завершите текущий ответ.");
        return;
      }
      this.textarea.value = "";
      const history = this.getHistory(canvasKey);
      const queuedMessage = { role: "user", content: raw, queued: true, canvasSnapshotBefore: "" };
      history.push(queuedMessage);
      const row = this.appendUserMessageUI(raw, queuedMessage, history.length - 1, canvasKey);
      (activeTask.followUps ||= []).push({ message: queuedMessage, row });
      await this.plugin.saveChatHistories();
      this.plugin.touchCanvas(canvasKey);
      new Notice("Follow-up добавлен. Hermes получит его следующим сообщением.");
      return;
    }

    this.textarea.value = "";

    // 3. Очистка старых пивотов вида 'Копай дальше про: "/model ..."'
    let text = raw;
    const modelMatch = raw.match(/\/model\s+([^\s"]+)/);
    if (modelMatch) {
      text = `/model ${modelMatch[1]}`;
    }

    // 4. КОМАНДА /clear
    if (text === "/clear") {
      const file = this.getCurrentFile();
      const key = file ? file.path : "default";
      this.plugin.chatHistories[key] = [];
      await this.plugin.resetCanvasSession(key);
      this.loadCanvasChat();
      new Notice("История чата очищена");
      return;
    }

    // 4.1 КОМАНДА /layout или /align (красивое выравнивание холста)
    const lowerCmd = text.toLowerCase().trim();
    if (lowerCmd === "/layout" || lowerCmd === "/align" || lowerCmd === "/beautify" || lowerCmd.includes("выровняй граф") || lowerCmd === "выровняй") {
      this.appendUserMessageUI(text);
      await this.plugin.beautifyActiveCanvas();
      this.appendAssistantMessageUI("✨ **Граф на холсте выровнен:** размеры карточек подогнаны под актуальный текст, наложения устранены, связи выстроены слева направо.");
      return;
    }

    // 5. КОМАНДА /reset или /new (сброс 90k контекста и запуск чистой сессии)
    if (text === "/reset" || text === "/new") {
      const file = this.getCurrentFile();
      const canvasKey = file ? file.path : "default";
      this.appendUserMessageUI(text);
      this.showTyping("Сброс контекста и создание новой сессии...");
      try {
        await this.plugin.resetCanvasSession(canvasKey);
        this.hideTyping();
        this.appendAssistantMessageUI(`🔄 **Сессия для "${file ? file.basename : 'холста'}" сброшена.** Контекст очищен (0 токенов).`);
        await this.plugin.saveChatHistories();
        new Notice("Сессия сброшена");
      } catch (err) {
        this.hideTyping();
        this.appendAssistantMessageUI(`❌ Ошибка сброса сессии: ${err.message}`);
      }
      return;
    }

    // 6. КОМАНДА /model
    if (text.startsWith("/model")) {
      this.appendUserMessageUI(text);
      const parts = text.split(/\s+/);

      if (parts.length === 1 || parts[1] === "list" || parts[1] === "help") {
        const cur = this.plugin.acpClient?.sessionModels.get(this.getCurrentFile()?.path || "default")
          || this.plugin.acpClient?.currentModel || this.plugin.settings.acpModel || "Модель Hermes";

        this.appendModelChooserUI(cur);
        return;
      }

      const query = parts.slice(1).join(" ");
      const available = sortAcpModels(this.plugin.acpClient?.availableModels);
      // Точный ID переключает сразу; иначе показываем поиск с уже введённым запросом.
      // Если списка ещё нет, отдаём ID как есть — так задаются свои модели.
      if (!available.length || available.some(model => model.modelId === query)) {
        await this.switchModel(query);
      } else {
        this.openModelPicker(query);
      }
      return;
    }

    const canvasHistory = this.getHistory(canvasKey);
    this.plugin.touchCanvas(canvasKey);
    this.renderCanvasTabs();
    const canvasSnapshotBefore = Object.prototype.hasOwnProperty.call(options, "canvasSnapshotBefore")
      ? options.canvasSnapshotBefore
      : await this.plugin.captureCanvasSnapshot(activeFile);
    const existingUserMessages = Array.isArray(options.existingUserMessages) ? options.existingUserMessages : [];
    let userMessage;
    if (existingUserMessages.length) {
      for (const existing of existingUserMessages) {
        existing.queued = false;
        existing.canvasSnapshotBefore = canvasSnapshotBefore;
      }
      userMessage = existingUserMessages[existingUserMessages.length - 1];
    } else {
      userMessage = { role: "user", content: text, canvasSnapshotBefore };
      if (options.branchGroup) userMessage.branchGroup = options.branchGroup;
      canvasHistory.push(userMessage);
      if (this.currentFilePath === canvasKey) this.appendUserMessageUI(text, userMessage, canvasHistory.length - 1, canvasKey);
    }
    if (this.currentFilePath === canvasKey) this.showTyping("Hermes Agent подключается...");

    const toolLogs = [];
    let responseText = "";

    const task = {
      canvasKey: canvasKey,
      acpKey: canvasKey,
      targetFile: activeFile,
      userText: text,
      streamedChunks: "",
      toolLogs: toolLogs,
      currentStatus: "",
      appliedBlocks: new Set(),
      totalLiveStats: { added: 0, updated: 0, deleted: 0 },
      liveBubble: null,
      liveToolsList: null,
      liveContent: null,
      renderTimer: null,
      assistantInsertIndex: existingUserMessages.length
        ? Math.max(0, canvasHistory.indexOf(userMessage) + 1)
        : canvasHistory.length,
      followUps: [],
      isDone: false
    };
    this.plugin.activeTasks.set(canvasKey, task);

    try {
      await this.plugin.saveChatHistories();
      const historyEnd = Number.isInteger(options.currentUserStartIndex)
        ? options.currentUserStartIndex
        : canvasHistory.length - 1;
      const previousChatHistory = canvasHistory.slice(0, Math.max(0, historyEnd));
      const canvasCtx = await this.plugin.getCanvasContext(activeFile);
      let canvasContextMsg = "";
      if (canvasCtx && canvasCtx.nodesCount > 0) {
        canvasContextMsg = `[ТЕКУЩИЙ ХОЛСТ "${canvasCtx.file}" (Всего ${canvasCtx.nodesCount} карточек)]:\n${canvasCtx.summary}\n`;
      } else {
        canvasContextMsg = `[ХОЛСТ "${activeFile ? activeFile.basename : 'Новый'}" ПУСТОЙ — начни сбор с чистого листа]\n`;
      }

      const deepMode = isDeepResearchRequest(text, this.plugin.isDeepMode(canvasKey));

      // HERMES ACP: полноценный автономный агент со всеми инструментами.
      if (this.currentFilePath === task.canvasKey) {
        this.updateTyping(deepMode
          ? "Hermes Agent: активный глубокий поиск до насыщения..."
          : "Hermes Agent подключается и запускает разведку...");
      }

        const missionPrompt = `[OBSIDIAN CANVAS OSINT ДЛЯ "${activeFile ? activeFile.basename : 'Холст'}"]
Цель: "${text}"
${canvasContextMsg}
${buildResearchExecutionContract(text, this.plugin.isDeepMode(canvasKey))}
${buildProxyContract(this.plugin.settings)}

Холст находится в Obsidian у клиента и может быть недоступен на машине агента. Используй переданный контекст холста и возвращай изменения JSON-блоками. Не пытайся открыть или записать локальный файл .canvas через терминал.

СТРОГИЕ ПРАВИЛА ИЗОЛЯЦИИ И СКИЛЛЫ:
1. Исследуй ИСКЛЮЧИТЕЛЬНО указанную цель.
   - РАЗРЕШЕНО: использовать скиллы Hermes Agent (skill_view, шаблоны, инструкции по тулам и сетевым протоколам).
   - КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО:
     * Читать другие файлы .canvas и другие заметки в хранилище. Твой контекст заметок — ТОЛЬКО текущий холст!
     * Использовать session_search по чужим расследованиям и прошлым сессиям других людей. Каждое расследование начинается с чистого листа!
     * Примешивать имена, телефоны или факты из других расследований.
2. Источники и методология: открытый интернет, реестры, соцсети, базы данных, curl, python, browser_exec (при необходимости прокси при геоблоках). Ты не ограничен фиксированным набором тулов — пиши любые скрипты на лету. Всесторонне используй все разделы OSINT Framework (https://osintframework.com):
   - Никнеймы: WhatsMyName, Namechk, Sherlock/Maigret, вытягивание постоянных ID профилей (Telegram ID, VK ID, SteamID64, GitHub API, Roblox ID).
   - Почты: Holehe, Epieos, Hunter, MX/SPF, утечки (DeHashed, IntelX).
   - Телефоны: диапазоны DEF, БДПН/MNP (ЦНИИС/НИИР), мессенджеры, доски объявлений (Авито, Юла, Авто.ру), форумы.
   - Бизнес и реестры: ЕГРЮЛ/ЕГРИП (Rusprofile, Checko, Audit-it), Картотека арбитражей (kad.arbitr.ru, тексты решений с паспортными данными и адресами), ФССП (алименты, долги), лицензии Роснедр/МЧС.
   - Геолокация и недвижимость: Публичная кадастровая карта (ПКК Росреестра), Яндекс Панорамы, спутниковые снимки, OpenStreetMap.
   - Транспорт: реестры лизингов Федресурса (VIN грузовиков и спецтехники), авиа/морской трекинг (FlightRadar24, MarineTraffic).
   - Сеть и домены: WHOIS, DNS, crt.sh (сертификаты поддоменов), Censys/Shodan, ASN.
   - Архивы и файлы: Wayback Machine, Archive.today, извлечение EXIF и метаданных документов.

АКТУАЛЬНОСТЬ КАРТОЧЕК (ОБНОВЛЕНИЕ И ОЧИСТКА ВМЕСТО ПЛОЖЕНИЯ ДУБЛЕЙ):
3. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО создавать карточки с отрицательными результатами («В базах спама не найден», «Реестры бизнеса: компаний не найдено», «ФИО не найдено», «Судов нет»). Если данных в открытых источниках нет — просто НЕ создавай карточку!
4. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО создавать карточки-инструкции и советы пользователю («Сделай перевод по СБП чтобы узнать имя», «Сохрани номер в контакты», «Проверь в GetContact»). Ты — исполнитель, а не консультант. На холсте отображаются только найденные ТОБОЙ факты!
5. Если по номеру или цели в открытых источниках нет ФИО или компаний — напиши об этом честно В ТЕКСТЕ ОТВЕТА В ЧАТЕ («В открытых реестрах ФИО не обнаружено»). А на холст добавь ТОЛЬКО базовую подтвержденную карточку (оператор и регион).
6. ОБНОВЛЕНИЕ СУЩЕСТВУЮЩИХ КАРТОЧЕК:
   Если по уже созданной на холсте сущности (человек, статус, адрес, компания, телефон) появились новые факты, уточнения или опровержения — ОБЯЗАТЕЛЬНО обновляй саму карточку через "update_nodes": [{"id": "id_карточки_из_контекста", "text": "### Заголовок\\n\\n• Обновленные факты..."}]. НЕ СОЗДАВАЙ дублирующие карточки на одну и ту же сущность!
7. УДАЛЕНИЕ НЕВАЛИДНОЙ / ОПРОВЕРГНУТОЙ ИНФОРМАЦИИ:
   Если данные оказались невалидными, устарели, гипотеза не подтвердилась (однофамилец, не тот человек, неверный номер, закрытая компания) — ОБЯЗАТЕЛЬНО удаляй эту карточку через "delete_node_ids": ["id_карточки"]. Граф должен оставаться чистым от ложных и устаревших сведений.
8. НОВЫЕ КАРТОЧКИ:
   В "new_nodes" добавляй ТОЛЬКО принципиально новые подтвержденные сущности.
9. Цвета: только критическая подтвержденная информация (ключевые утечки, компрометирующие находки) — color "1" (красный), всё остальное — нейтральные карточки (без цвета).
10. Выдавай карточки в блоках \`\`\`json (можно на лету по ходу расследования и в финале):
\`\`\`json
{
  "summary": "Краткая сводка",
  "pivots": ["зацепка_1", "зацепка_2"],
  "sources": [{"title": "Название источника", "url": "https://example.com/page"}],
  "delete_node_ids": ["id_для_удаления"],
  "update_nodes": [
    { "id": "id_существующей_карточки", "text": "### Заголовок\\n\\n• Актуализированные факты..." }
  ],
  "new_nodes": [
    {
      "id": "уникальный_id",
      "parent_id": "id_родительской_карточки",
      "title": "Заголовок с эмодзи",
      "content": "• Проверенные факты и ссылки"
    }
  ]
}
\`\`\`
Только факты и готовые данные. Без туториалов и нравоучений.`;

        // Создаем живой пузырь только если пользователь всё ещё смотрит этот чат.
        let liveBubble = null;
        let liveToolsList = null;
        let liveContent = null;
        const isWarm = !!this.plugin.acpClient.sessionId;
        const initStatusText = isWarm ? "Анализ цели..." : "Инициализация сессии...";
        if (this.currentFilePath === task.canvasKey) {
          this.hideTyping();
          const liveRow = this.messagesEl.createDiv({ cls: "osint-msg-row assistant" });
          const firstQueuedRow = task.followUps?.find(entry => entry.row?.isConnected)?.row;
          if (firstQueuedRow) this.messagesEl.insertBefore(liveRow, firstQueuedRow);
          liveBubble = liveRow.createDiv({ cls: "osint-bubble assistant" });
          const liveToolsBox = liveBubble.createDiv({ cls: "osint-tool-box", style: "margin-bottom:8px;" });
          liveToolsBox.createDiv({ cls: "osint-tool-title", text: "Шаги исследования:" });
          liveToolsList = liveToolsBox.createDiv({ cls: "osint-tool-list" });
          liveToolsList.createDiv({ cls: "osint-tool-item muted", text: initStatusText });
          liveContent = liveBubble.createDiv({ cls: "osint-markdown-content" });
        }

        task.currentStatus = initStatusText;
        task.liveBubble = liveBubble;
        task.liveToolsList = liveToolsList;
        task.liveContent = liveContent;

        const tryApplyLiveBlocks = async (rawText) => {
          const regex = /```(?:json|canvas)?\s*(\{[\s\S]*?\})\s*```/g;
          let m;
          while ((m = regex.exec(rawText)) !== null) {
            const raw = m[1].trim();
            if (task.appliedBlocks.has(raw)) continue;
            try {
              const data = JSON.parse(raw);
              if (data.new_nodes || data.update_nodes || data.delete_node_ids) {
                task.appliedBlocks.add(raw);
                const s = await this.plugin.applyCanvasActions(data, activeFile);
                task.totalLiveStats.added += (s.added || 0);
                task.totalLiveStats.updated += (s.updated || 0);
                task.totalLiveStats.deleted += (s.deleted || 0);
              }
            } catch (e) {}
          }
        };

        const promptResult = await this.plugin.acpClient.prompt(missionPrompt, {
          history: previousChatHistory,
          onChunk: (chunk) => {
            task.streamedChunks += chunk;
            this.plugin.checkpointChatTask(task);
            task.currentStatus = "";

            tryApplyLiveBlocks(task.streamedChunks);

            if (this.currentFilePath === task.canvasKey && task.liveContent) {
              const muted = task.liveToolsList?.querySelector(".osint-tool-item.muted");
              if (muted) muted.remove();

              if (!task.renderTimer) {
                task.renderTimer = setTimeout(() => {
                  task.renderTimer = null;
                  if (this.currentFilePath !== task.canvasKey || !task.liveContent) return;
                  task.liveContent.empty();
                  const cleanSoFar = task.streamedChunks.replace(/```(?:json|canvas)?[\s\S]*?```/g, "").trim();
                  MarkdownRenderer.render(this.plugin.app, cleanSoFar || "...", task.liveContent, "", this);
                  this.scrollToBottom();
                }, 120);
              }
            }
          },
          onToolStart: (toolTitle) => {
            task.toolLogs.push(toolTitle);
            task.currentStatus = "";

            if (this.currentFilePath === task.canvasKey && task.liveToolsList) {
              const muted = task.liveToolsList.querySelector(".osint-tool-item.muted");
              if (muted) muted.remove();

              const tItem = task.liveToolsList.createDiv({ cls: "osint-tool-item" });
              tItem.setText(toolTitle);
              this.scrollToBottom();
            }
          },
          onToolEnd: (toolTitle, result) => {
            const summary = summarizeAcpToolResult(result);
            const log = summary ? `${toolTitle}: ${summary}` : `${toolTitle}: завершено`;
            task.toolLogs.push(log);
            if (summary && this.currentFilePath === task.canvasKey && task.liveToolsList) {
              const item = task.liveToolsList.createDiv({ cls: "osint-tool-item muted" });
              item.setText(`↳ ${summary}`);
              this.scrollToBottom();
            }
          }
        }, task.acpKey);
        task.cancelled = !!task.cancelRequested || promptResult?.stopReason === "cancelled";
        if (task.cancelRequested) {
          const marker = "🛑 **Генерация остановлена пользователем.**";
          task.streamedChunks = task.streamedChunks.trim()
            ? `${task.streamedChunks.trim()}\n\n${marker}`
            : marker;
        }
        this.updateFileStatus();

        if (task.renderTimer) {
          clearTimeout(task.renderTimer);
          task.renderTimer = null;
        }
        await tryApplyLiveBlocks(task.streamedChunks);

        if (this.currentFilePath === task.canvasKey && task.liveContent) {
          task.liveContent.empty();
          const finalClean = task.streamedChunks.replace(/```(?:json|canvas)?[\s\S]*?```/g, "").trim();
          MarkdownRenderer.render(this.plugin.app, finalClean || "Данные обработаны.", task.liveContent, "", this);
        }

        responseText = task.streamedChunks;

      task.isDone = true;
      let stats = task.totalLiveStats || { added: 0, updated: 0, deleted: 0 };
      let pivots = [];
      let sources = [];

      const osintData = this.plugin.extractJson(responseText);
      if (osintData) {
        if (Array.isArray(osintData.pivots)) {
          pivots = osintData.pivots;
        }
        if (Array.isArray(osintData.sources)) {
          sources = extractSources("", osintData.sources);
        }
      }
      sources = extractSources(responseText, sources);

      // СОХРАНЯЕМ В ИСТОРИЮ НУЖНОГО ХОЛСТА
      const currentCanvasHistory = this.getHistory(task.canvasKey);
      clearTimeout(task.historyTimer);
      const completedMessage = {
        role: "assistant", content: responseText, stats, pivots, sources,
        toolLogs: task.toolLogs || [], incomplete: !!task.cancelled
      };
      if (task.historyMessage) Object.assign(task.historyMessage, completedMessage);
      else {
        task.historyMessage = completedMessage;
        const insertAt = Math.max(0, Math.min(Number(task.assistantInsertIndex) || currentCanvasHistory.length, currentCanvasHistory.length));
        currentCanvasHistory.splice(insertAt, 0, completedMessage);
      }
      this.plugin.touchCanvas(task.canvasKey);
      this.renderCanvasTabs();
      await this.plugin.saveChatHistories();

      // Если пользователь сейчас на этом холсте и живой пузырь на экране — финализируем его
      if (this.currentFilePath === task.canvasKey && task.liveBubble && task.liveBubble.isConnected) {
        this.finalizeLiveBubbleUI(task.liveBubble, responseText, stats, pivots, sources);
        this.scrollToBottom();
      } else if (this.currentFilePath === task.canvasKey) {
        this.appendAssistantMessageUI(responseText, stats, pivots, task.toolLogs || [], sources);
      }

      if (this.plugin.activeTasks.get(task.canvasKey) === task) this.plugin.activeTasks.delete(task.canvasKey);
      this.plugin.finishCanvasKeyMigration(task);
      if (this.currentFilePath === task.canvasKey) {
        this.hideTyping();
      }
      this.updateInputControls();
      if (task.followUps?.length) {
        this.runQueuedFollowUps(task).catch(error => {
          console.warn("Cannot run queued follow-up:", error);
          new Notice(`Не удалось отправить follow-up: ${error.message || error}`);
        });
      }
    } catch (err) {
      clearTimeout(task.renderTimer);
      await this.plugin.checkpointChatTask(task, true)?.catch(() => {});
      if (this.plugin.activeTasks.get(task.canvasKey) === task) this.plugin.activeTasks.delete(task.canvasKey);
      this.plugin.finishCanvasKeyMigration(task);
      if (task.cancelRequested) {
        task.isDone = true;
        task.cancelled = true;
        const marker = "🛑 **Генерация остановлена пользователем.**";
        const stoppedText = task.streamedChunks.trim()
          ? `${task.streamedChunks.trim()}\n\n${marker}`
          : marker;
        task.streamedChunks = stoppedText;
        const stoppedMessage = {
          role: "assistant", content: stoppedText, stats: task.totalLiveStats,
          pivots: [], sources: extractSources(stoppedText), toolLogs: task.toolLogs || [], incomplete: true
        };
        if (task.historyMessage) Object.assign(task.historyMessage, stoppedMessage);
        else {
          task.historyMessage = stoppedMessage;
          const history = (this.plugin.chatHistories[task.canvasKey] ||= []);
          const insertAt = Math.max(0, Math.min(Number(task.assistantInsertIndex) || history.length, history.length));
          history.splice(insertAt, 0, stoppedMessage);
        }
        this.plugin.touchCanvas(task.canvasKey);
        this.renderCanvasTabs();
        await this.plugin.saveChatHistories().catch(() => {});
        if (this.currentFilePath === task.canvasKey) this.loadCanvasChat();
        this.updateInputControls();
        new Notice("Генерация остановлена. ACP готов к следующему запросу.");
        if (task.followUps?.length) this.runQueuedFollowUps(task).catch(error => {
          console.warn("Cannot run queued follow-up after stop:", error);
          new Notice(`Не удалось отправить follow-up: ${error.message || error}`);
        });
        return;
      }
      if (this.currentFilePath === task.canvasKey) {
        this.hideTyping();
        const errRow = this.messagesEl.createDiv({ cls: "osint-msg-row assistant error" });
        const bubble = errRow.createDiv({ cls: "osint-bubble assistant error-bubble" });
        bubble.createDiv({ text: `❌ Ошибка: ${err.message || err}` });

        const actionsBox = bubble.createDiv({ style: "display:flex; gap:8px; margin-top:8px;" });

        const retryBtn = actionsBox.createEl("button", { text: "🔁 Повторить запрос", style: "cursor:pointer; padding:4px 10px; font-size:12px; border-radius:4px;" });
        retryBtn.addEventListener("click", () => {
          this.textarea.value = text;
          this.handleSend();
        });

        const resetBtn = actionsBox.createEl("button", { text: "🔄 Сбросить сессию (0 токенов)", style: "cursor:pointer; padding:4px 10px; font-size:12px; border-radius:4px;" });
        resetBtn.addEventListener("click", async () => {
          const file = this.getCurrentFile();
          const canvasKey = file ? file.path : "default";
          await this.plugin.resetCanvasSession(canvasKey);
          new Notice("Контекст сброшен, повтор запроса...");
          this.textarea.value = text;
          this.handleSend();
        });

        new Notice(`Ошибка OSINT: ${err.message}`);
        this.scrollToBottom();
      }
      this.updateInputControls();
      if (task.followUps?.length) this.runQueuedFollowUps(task).catch(error => {
        console.warn("Cannot run queued follow-up after error:", error);
        new Notice(`Не удалось отправить follow-up: ${error.message || error}`);
      });
    }
  }
}

/**
 * Настройки плагина
 */
class OsintSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Настройки OSINT Canvas Agent" });
    containerEl.createEl("h3", { text: "Подключение Hermes ACP" });
      containerEl.createEl("p", { text: "Настройки сохраняются автоматически. После изменений нажмите «Применить и проверить» или перезапустите плагин. Для SSH локальная установка Hermes не нужна." });
      new Setting(containerEl).setName("Транспорт")
        .addDropdown(dropdown => dropdown
          .addOption("local", "Локальный Hermes · stdio")
          .addOption("ssh", "Внешний Hermes · SSH")
          .addOption("command", "Своя команда · stdio")
          .setValue(this.plugin.settings.acpTransport)
          .onChange(async value => {
            this.plugin.settings.acpTransport = value;
            await this.plugin.saveSettings();
            this.display();
          }));
      const field = (key, name, description, placeholder = "", multiline = false) => {
        const setting = new Setting(containerEl).setName(name).setDesc(description);
        const setup = input => {
          input.setPlaceholder(placeholder).setValue(this.plugin.settings[key] || "").onChange(async value => {
            this.plugin.settings[key] = value;
            await this.plugin.saveSettings();
          });
          input.inputEl.style.width = "100%";
          if (multiline) input.inputEl.rows = 3;
        };
        if (multiline) setting.addTextArea(setup); else setting.addText(setup);
      };
      if (this.plugin.settings.acpTransport === "ssh") {
        field("acpSshHost", "SSH-хост", "Пользователь и сервер либо Host-алиас из ~/.ssh/config. Вход по ключу или через ssh-agent.", "user@server");
        field("acpSshPort", "SSH-порт (необязательно)", "Пусто — из SSH config или стандартный 22.", "22");
        field("acpSshKey", "SSH-ключ (необязательно)", "Локальный путь к приватному ключу; пусто — использовать SSH config / ssh-agent.", "~/.ssh/id_ed25519");
        field("acpSshCommand", "Программа SSH", "Имя или абсолютный путь к OpenSSH на компьютере с Obsidian.", "ssh");
      }
      field("acpCommand", "Команда ACP", this.plugin.settings.acpTransport === "ssh"
        ? "Исполняемый файл Hermes на сервере. Рекомендуется абсолютный путь; пусто — hermes из PATH сервера."
        : "Исполняемый файл без аргументов и без кавычек. В локальном режиме пусто — поиск Hermes автоматически.",
        this.plugin.settings.acpTransport === "ssh" ? "/home/user/.local/bin/hermes" : "hermes");
      field("acpArgs", "Аргументы ACP (JSON)", 'Например ["acp"] или ["-p","obsidian","acp"] для существующего профиля.', '["acp"]', true);
      field("acpCwd", "Рабочая папка Hermes", this.plugin.settings.acpTransport === "ssh"
        ? "Обязательный существующий абсолютный путь НА СЕРВЕРЕ. Vault туда копировать не требуется."
        : "Абсолютный путь рабочей папки агента; пусто — папка vault. Для своей команды это путь, передаваемый агенту в session/new.", "/home/user");
      field("acpEnv", "Переменные окружения (JSON)", "Необязательно. Для SSH передаются только эти переменные, окружение вашего компьютера на сервер не копируется. Значения хранятся в настройках плагина открытым текстом.", "{}", true);
      if (this.plugin.settings.acpTransport === "local") {
        field("acpProxy", "SOCKS5-прокси (необязательно)", "Прокси на этой же машине для обхода геоблоков и Cloudflare. Адрес передаётся Hermes в промпте, чтобы агент повторял через него заблокированные запросы. Пусто — прокси не упоминается. Схема по умолчанию socks5h (DNS резолвит прокси, без утечки).", "socks5h://127.0.0.1:2080");
      }
      field("acpModel", "Модель Hermes (необязательно)", "Пусто — модель из конфигурации Hermes. Можно указать ID модели, который принимает ваш агент.");
      new Setting(containerEl).setName("Автоматически разрешать инструменты")
        .setDesc("Без запроса в Obsidian подтверждать предлагаемые агентом разрешения. По умолчанию включено; выключите, чтобы подтверждать каждое действие вручную.")
        .addToggle(toggle => toggle.setValue(!!this.plugin.settings.acpAutoApprove).onChange(async value => {
          this.plugin.settings.acpAutoApprove = value;
          await this.plugin.saveSettings();
        }));
      new Setting(containerEl).setName("Проверить подключение")
        .setDesc("Переподключится и создаст тестовую ACP-сессию без запроса к модели. Рабочая сессия холста будет отдельной.")
        .addButton(button => button.setButtonText("Применить и проверить").setCta().onClick(async () => {
          button.setDisabled(true);
          try {
            if (this.plugin.activeTasks.size) throw new Error("Сначала остановите или завершите активные запросы.");
            buildAcpLaunch(this.plugin.settings, this.plugin.vaultPath);
            const proxy = isAcpProxyEnabled(this.plugin.settings) ? normalizeAcpProxy(this.plugin.settings.acpProxy) : "";
            this.plugin.configureAcpClient();
            await this.plugin.acpClient.getSession("__connection_check__");
            new Notice(`ACP подключён: ${this.plugin.acpClient.agentInfo?.name || "агент"}. Модель: ${this.plugin.acpClient.currentModel || "из настроек Hermes"}`
              + (proxy ? `. Прокси в промпте: ${proxy}` : ""), 8000);
          } catch (error) { new Notice(`Ошибка ACP: ${error.message}`, 12000); }
          finally { button.setDisabled(false); }
        }));
  }
}

module.exports = VibeOsintPlugin;
