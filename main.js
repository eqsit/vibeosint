const obsidian = require("obsidian");
const { spawn } = require("child_process");
const readline = require("readline");
const crypto = require("crypto");
const {
  Plugin,
  PluginSettingTab,
  Setting,
  ItemView,
  Notice,
  requestUrl,
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
    const candidates = [
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
  return "hermes";
}

/**
 * КЛИЕНТ HERMES ACP (Agent Client Protocol)
 * Запускает автономного Hermes-агента с полным доступом к системе (terminal, web, python)
 */
class HermesAcpClient {
  constructor(vaultPath, defaultModel = "agy/gemini-3.8-flash-high") {
    this.vaultPath = vaultPath;
    this.defaultModel = defaultModel;
    this.currentModel = defaultModel;
    this.proc = null;
    this.sessionId = null;
    this.sessions = new Map(); // canvasKey -> sessionId
    this.updateHandlers = new Map(); // sessionId -> callback
    this.reqId = 1;
    this.pending = new Map();
    this.onUpdate = null;
  }

  ensureProcess() {
    if (this.proc && !this.proc.killed) return;

    const hermesBin = findHermesBinary();
    const os = require("os");
    const path = require("path");
    const homeDir = os.homedir();
    const env = Object.assign({}, process.env, {
      PATH: `${path.join(homeDir, ".local", "bin")}:${path.join(homeDir, ".hermes", "bin")}:${path.join(homeDir, ".hermes", "hermes-agent", "venv", "bin")}:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
      HERMES_APPROVALS_MODE: "off",
      HERMES_YOLO: "1",
      HERMES_ACCEPT_HOOKS: "1",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost"
    });

    try {
      this.proc = spawn(hermesBin, ["-p", "obsidian", "acp", "--accept-hooks"], {
        cwd: this.vaultPath,
        env: env
      });

      const fs = require("fs");
      const logFile = path.join(homeDir, ".hermes", "logs", "acp-bridge.log");
      const logStream = fs.createWriteStream(logFile, { flags: "a" });
      this.proc.stderr.pipe(logStream);
    } catch (spawnErr) {
      console.error("Failed to spawn Hermes ACP:", spawnErr);
      throw new Error(`Не удалось запустить Hermes ACP: ${spawnErr.message}`);
    }

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const msg = JSON.parse(trimmed);

        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          if (timer) clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        } else if (msg.method === "session/request_permission") {
          // Автоматическое подтверждение инструментов агента (ACP протокол: outcome: "selected", optionId)
          const options = msg.params?.options || [];
          const alwaysOpt = options.find(o => o.optionId === "allow_always" || o.kind === "allow_always");
          const selectedId = alwaysOpt ? alwaysOpt.optionId : (options[0]?.optionId || "allow_always");

          const resp = {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              outcome: {
                outcome: "selected",
                optionId: selectedId
              }
            }
          };
          this.proc.stdin.write(JSON.stringify(resp) + "\n");
        } else if (msg.method === "session/update") {
          const sId = msg.params?.sessionId;
          // Продлеваем скользящий таймер неактивности (15 мин) при любом живом событии агента
          for (const item of this.pending.values()) {
            if (item.method === "session/prompt" && (!item.params?.sessionId || item.params?.sessionId === sId)) {
              item.arm?.(900000);
            }
          }
          const handler = (sId && this.updateHandlers?.has(sId)) ? this.updateHandlers.get(sId) : this.onUpdate;
          if (handler) {
            handler(msg.params?.update);
          }
        }
      } catch (e) {
        // не JSON-RPC строка
      }
    });

    this.proc.on("exit", (code) => {
      this.proc = null;
      this.sessionId = null;
      this.sessions.clear();
      for (const [id, item] of this.pending.entries()) {
        if (item.timer) clearTimeout(item.timer);
        item.reject(new Error(`Hermes ACP завершил процесс с кодом ${code}`));
      }
      this.pending.clear();
    });

    this.proc.on("error", (err) => {
      console.error("Hermes ACP process error:", err);
      for (const [id, item] of this.pending.entries()) {
        if (item.timer) clearTimeout(item.timer);
        item.reject(new Error(`Ошибка запуска Hermes ACP: ${err.message}`));
      }
      this.pending.clear();
      this.proc = null;
      this.sessionId = null;
      this.sessions.clear();
    });
  }

  send(method, params, timeoutMs = 30000) {
    this.ensureProcess();
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      let timer = null;
      const arm = (ms) => {
        if (timer) clearTimeout(timer);
        if (ms > 0) {
          timer = setTimeout(() => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              reject(new Error(`Таймаут ответа Hermes ACP (${method})`));
            }
          }, ms);
        }
      };
      arm(timeoutMs);
      this.pending.set(id, { resolve, reject, arm, timer, method, params });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.proc.stdin.write(payload);
    });
  }

  async getSession(canvasKey = "default") {
    if (!this.sessions.has(canvasKey)) {
      await this.send("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { read: true, write: true },
          terminal: true
        }
      }, 20000);
      const res = await this.send("session/new", {
        cwd: this.vaultPath,
        mcpServers: []
      }, 20000);
      const sessId = res.sessionId;
      this.sessions.set(canvasKey, sessId);
      this.sessionId = sessId;

      if (this.defaultModel && !this.defaultModel.includes("gemini") && !this.defaultModel.includes("flash")) {
        try {
          await this.send("session/set_model", {
            sessionId: sessId,
            modelId: this.defaultModel
          }, 10000);
          this.currentModel = this.defaultModel;
        } catch (e) {
          console.warn("Failed to set default ACP model:", e);
        }
      } else {
        this.currentModel = "agy/gemini-3.8-flash-high";
      }
    }
    return this.sessions.get(canvasKey);
  }

  notify(method, params) {
    this.ensureProcess();
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.proc.stdin.write(payload);
  }

  cancel(canvasKey = "default") {
    const sessId = this.sessions.get(canvasKey) || this.sessionId;
    if (sessId && this.proc) {
      this.notify("session/cancel", { sessionId: sessId });
    }
  }

  async resetSession(canvasKey = "default") {
    this.sessions.delete(canvasKey);
    return await this.getSession(canvasKey);
  }

  async setModel(modelId, canvasKey = "default") {
    this.currentModel = modelId;
    this.defaultModel = modelId;

    if (modelId.includes("gemini") || modelId.includes("flash")) {
      // Сбрасываем сессию для новой модели
      this.sessions.delete(canvasKey);
      await this.getSession(canvasKey);
      return this.currentModel;
    }

    const sessId = await this.getSession(canvasKey);
    await this.send("session/set_model", {
      sessionId: sessId,
      modelId: modelId
    }, 15000);
    return modelId;
  }

  async prompt(text, callbacks = {}, canvasKey = "default") {
    const sessId = await this.getSession(canvasKey);

    const updateHandler = (u) => {
      if (!u) return;
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.text) {
        callbacks.onChunk?.(u.content.text);
      } else if (u.sessionUpdate === "tool_call") {
        callbacks.onToolStart?.(u.title || u.name || "Инструмент");
      } else if (u.sessionUpdate === "tool_call_update") {
        callbacks.onToolEnd?.(u.title || u.name, u.result);
      }
    };
    this.updateHandlers.set(sessId, updateHandler);
    this.onUpdate = updateHandler;

    try {
      const res = await this.send("session/prompt", {
        sessionId: sessId,
        prompt: [{ type: "text", text }]
      }, 1800000); // 30 минут скользящий таймаут (продлевается при активности агента)
      return res;
    } finally {
      this.updateHandlers.delete(sessId);
    }
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch (e) {}
      this.proc = null;
      this.sessionId = null;
    }
  }
}

/**
 * Базовый системный шаблон для Hermes и Direct API
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
- Защита контекста: проводи точечную разведку (4-8 целевых шагов) и сразу выдавай карточки на Canvas.

Никаких туториалов, воды и поучений. Только факты.`;

const DEFAULT_SETTINGS = {
  engineMode: "hermes_acp", // "hermes_acp" | "direct_api"
  acpModel: "agy/gemini-3.8-flash-high",
  apiKey: "",
  apiBaseUrl: "https://api.openai.com/v1",
  model: "gpt-4o",
  temperature: 0.05,
  systemPrompt: OSINT_BASE_CONTRACT
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

  const cardWidth = 540;
  const usableWidth = cardWidth - 56;
  const lines = text.split("\n");

  let totalHeight = 48; // базовые верхний и нижний отступы карточки
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      totalHeight += 24;
      continue;
    }

    if (!trimmed) {
      totalHeight += 18;
      continue;
    }

    // Встроенные изображения ![[картинка.jpg]] или ![](...) в markdown-карточке
    if (trimmed.includes("![[") || (trimmed.includes("![") && trimmed.includes("]("))) {
      const sizeMatch = trimmed.match(/\|(\d+)(?:x(\d+))?\]\]/);
      if (sizeMatch) {
        const customH = sizeMatch[2] ? parseInt(sizeMatch[2], 10) : parseInt(sizeMatch[1], 10);
        totalHeight += Math.max(120, customH + 24);
      } else {
        // Полноразмерное изображение в карточке 540px занимает ~480px высоты
        totalHeight += 480;
      }
      continue;
    }

    if (trimmed.startsWith("# ")) {
      totalHeight += 60;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      totalHeight += 48;
      continue;
    }
    if (trimmed.startsWith("### ")) {
      totalHeight += 42;
      continue;
    }

    const indentCount = line.length - line.trimStart().length;
    const indentPx = indentCount * 10;
    const lineUsableW = Math.max(200, usableWidth - indentPx);

    const clean = trimmed.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");
    const hasBold = clean.includes("**") || clean.includes("<b>") || clean.includes("<strong>");
    const charWidth = hasBold ? 10.2 : 9.6;
    const cleanText = clean.replace(/[*_`~]/g, "");

    const charsPerLine = Math.max(20, Math.floor(lineUsableW / charWidth));
    const visualLines = Math.max(1, Math.ceil(cleanText.length / charsPerLine));
    totalHeight += visualLines * 26;

    if (trimmed.startsWith("•") || trimmed.startsWith("-") || trimmed.startsWith("*") || /^\d+\./.test(trimmed)) {
      totalHeight += 8; // отступ между пунктами списка в Obsidian
    }
  }

  totalHeight += 50; // щедрый запас пространства снизу чтобы скроллбар НИКОГДА не появлялся

  return {
    width: Math.round(cardWidth),
    height: Math.max(130, Math.round(totalHeight))
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

class GeminiCanvasOsintPlugin extends Plugin {
  async onload() {
    console.log("Loading Hermes Canvas OSINT Plugin");
    this.activeTasks = new Map(); // canvasKey -> task state
    await this.loadSettings();
    await this.loadChatHistories();

    // Получаем путь к текущему волту для Hermes ACP
    const vaultAdapter = this.app.vault.adapter;
    const vaultPath = (vaultAdapter && vaultAdapter.getBasePath) ? vaultAdapter.getBasePath() : "";

    const defaultModel = this.settings.acpModel || "agy/gemini-3.8-flash-high";
    this.acpClient = new HermesAcpClient(vaultPath, defaultModel);

    // Фоновый прогрев сессии ACP при старте, чтобы запрос уходил мгновенно
    if (this.settings.engineMode === "hermes_acp") {
      setTimeout(() => {
        this.acpClient.getSession("default").then((sid) => {
          console.log("[Hermes ACP] Фоновая сессия прогрета, ID:", sid);
        }).catch((e) => {
          console.warn("[Hermes ACP] Ошибка прогрева:", e);
        });
      }, 1000);
    }

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

  async loadChatHistories() {
    try {
      const adapter = this.app.vault.adapter;
      const chatFile = `${this.manifest.dir}/chats.json`;
      if (await adapter.exists(chatFile)) {
        const raw = await adapter.read(chatFile);
        this.chatHistories = JSON.parse(raw || "{}");
      } else {
        this.chatHistories = {};
      }
    } catch (e) {
      this.chatHistories = {};
    }
  }

  async saveChatHistories() {
    try {
      const adapter = this.app.vault.adapter;
      const chatFile = `${this.manifest.dir}/chats.json`;
      await adapter.write(chatFile, JSON.stringify(this.chatHistories || {}, null, 2));
    } catch (e) {
      console.warn("Failed to save chat histories:", e);
    }
  }

  onunload() {
    console.log("Unloading Hermes Canvas OSINT Plugin");
    if (this.acpClient) {
      this.acpClient.stop();
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

  /**
   * Прямой вызов HTTP API (fallback если ACP не выбран)
   */
  async queryDirectApi(messages) {
    const apiKey = this.settings.apiKey ? this.settings.apiKey.trim() : "";
    let baseUrl = this.settings.apiBaseUrl ? this.settings.apiBaseUrl.trim() : "https://api.openai.com/v1";
    baseUrl = baseUrl.replace(/\/+$/, "");

    const modelName = (this.settings.model || "").toLowerCase();
    const isResponsesApi = modelName.startsWith("muse-spark") || modelName.startsWith("grok-4.6") || modelName.startsWith("gpt-5.6") || baseUrl.endsWith("/responses");

    let endpoint = baseUrl;
    let payload = {};

    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    if (isResponsesApi) {
      if (!endpoint.endsWith("/responses")) {
        endpoint = `${baseUrl}/responses`;
      }
      payload = {
        model: this.settings.model || "muse-spark-1.3-contributor",
        instructions: this.settings.systemPrompt,
        input: messages.map(m => ({ role: m.role, content: m.content }))
      };
    } else {
      if (!endpoint.endsWith("/chat/completions")) {
        endpoint = `${baseUrl}/chat/completions`;
      }
      payload = {
        model: this.settings.model || "agy/gemini-3.8-flash-high",
        messages: [
          { role: "system", content: this.settings.systemPrompt },
          ...messages
        ],
        temperature: this.settings.temperature ?? 0.05
      };
    }

    const response = await requestUrl({
      url: endpoint,
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
      throw: false,
    });

    if (response.status !== 200) {
      let detail = response.text;
      try {
        if (response.json && response.json.error) {
          detail = response.json.error.message || JSON.stringify(response.json.error);
        }
      } catch (e) {}
      throw new Error(`Ошибка API (${response.status}): ${detail}`);
    }

    const json = response.json;
    if (isResponsesApi) {
      let outText = "";
      if (json && Array.isArray(json.output)) {
        for (const item of json.output) {
          if (item.type === "message" && Array.isArray(item.content)) {
            for (const c of item.content) {
              if (c.text) outText += c.text;
            }
          }
        }
      }
      if (!outText) throw new Error("Пустой ответ от Responses API");
      return outText;
    }

    if (!json || !json.choices || !json.choices[0] || !json.choices[0].message) {
      throw new Error("Пустой ответ от нейросети");
    }

    return json.choices[0].message.content;
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
          this.renderCanvasTabs();
          this.updateFileStatus();
          this.loadCanvasChat();
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
    const allCanvasFiles = this.app.vault.getFiles().filter(f => f.extension === "canvas");

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

    const addTab = this.tabsEl.createDiv({
      cls: "osint-canvas-tab osint-tab-add",
      title: "Создать новый холст"
    });
    setIcon(addTab.createSpan(), "plus");
    addTab.addEventListener("click", async () => {
      await this.createNewCanvas();
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
    const modelGroups = [
      {
        label: "OmniRoute",
        models: [
          { id: "agy/gemini-3.8-flash-high", label: "Gemini 3.8 Flash (Быстрая)" },
          { id: "agy/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
          { id: "agy/claude-opus-4-6-thinking", label: "Claude Opus Thinking" },
          { id: "dva/deepseek-v4", label: "DeepSeek V4" },
          { id: "dva/gpt-5-6-sol-high", label: "GPT 5.6 Sol High" },
          { id: "dva/grok-4-5-high", label: "Grok 4.5" }
        ]
      },
      {
        label: "OpenCode",
        models: [
          { id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3" },
          { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
          { id: "qwen3.8-max", label: "Qwen 3.8 Max" },
          { id: "kimi-k3", label: "Kimi K3" },
          { id: "grok-4.6", label: "Grok 4.6" },
          { id: "mimo-v2.5", label: "Mimo V2.5" }
        ]
      },
      {
        label: "OpenRouter",
        models: [
          { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
          { id: "anthropic/claude-opus-5", label: "Claude Opus 5" },
          { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash OR" },
          { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash OR" },
          { id: "qwen/qwen3.8-max", label: "Qwen 3.8 Max OR" },
          { id: "x-ai/grok-4.6", label: "Grok 4.6 OR" }
        ]
      }
    ];

    modelGroups.forEach(grp => {
      const optGroup = this.modelSelectEl.createEl("optgroup", { label: grp.label });
      grp.models.forEach(opt => {
        optGroup.createEl("option", { value: opt.id, text: opt.label });
      });
    });

    this.modelSelectEl.addEventListener("change", async () => {
      await this.switchModel(this.modelSelectEl.value);
    });

    const resetBtn = actions.createEl("button", { cls: "osint-icon-btn", title: "Сбросить контекст сессии" });
    setIcon(resetBtn, "rotate-ccw");
    resetBtn.addEventListener("click", async () => {
      const file = this.getCurrentFile();
      const canvasKey = file ? file.path : "default";
      this.showTyping("Сброс контекста...");
      try {
        await this.plugin.acpClient.resetSession(canvasKey);
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
    clearBtn.addEventListener("click", () => {
      const file = this.getCurrentFile();
      const key = file ? file.path : "default";
      this.plugin.chatHistories[key] = [];
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
    const curModel = (this.plugin.settings.engineMode === "hermes_acp")
      ? (this.plugin.acpClient?.currentModel || this.plugin.settings.acpModel || "agy/gemini-3.8-flash-high")
      : (this.plugin.settings.model || "agy/gemini-3.8-flash-high");

    if (this.modelSelectEl) {
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
      for (const msg of history) {
        if (msg.role === "user") {
          this.appendUserMessageUI(msg.content);
        } else if (msg.role === "assistant") {
          this.appendAssistantMessageUI(msg.content, msg.stats, msg.pivots, msg.toolLogs);
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
  }

  isCanvasLoading(canvasKey = null) {
    const key = canvasKey || (this.getCurrentFile() ? this.getCurrentFile().path : (this.currentFilePath || "default"));
    const task = this.plugin.activeTasks?.get(key);
    return !!(task && !task.isDone);
  }

  updateInputControls() {
    const isRunning = this.isCanvasLoading();
    if (this.stopBtn) {
      this.stopBtn.style.display = isRunning ? "inline-flex" : "none";
    }
    if (this.sendBtn) {
      if (isRunning) {
        this.sendBtn.title = "Скорректировать агента на лету (Steer / Redirect)";
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

    if (task.toolLogs && task.toolLogs.length > 0) {
      task.toolLogs.forEach(toolTitle => {
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

  finalizeLiveBubbleUI(bubble, text, stats, pivots) {
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

    if (pivots && Array.isArray(pivots) && pivots.length > 0) {
      const pivotBox = bubble.createDiv({ cls: "osint-pivots-box" });
      pivotBox.createDiv({ cls: "osint-pivots-title", text: "Связанные ветки:" });
      const pillsContainer = pivotBox.createDiv({ cls: "osint-pivots-pills" });
      pivots.forEach(p => {
        const pStr = String(p).trim();
        if (!pStr) return;
        const pill = pillsContainer.createSpan({ cls: "osint-pivot-pill", text: pStr });
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
      { label: "Углубить", prefix: "Углубись в найденные связи: " },
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

  appendUserMessageUI(text) {
    const row = this.messagesEl.createDiv({ cls: "osint-msg-row user" });
    const bubble = row.createDiv({ cls: "osint-bubble user" });
    bubble.setText(text);
    this.scrollToBottom();
  }

  appendAssistantMessageUI(text, stats, pivots, toolLogs) {
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
    if (toolLogs && Array.isArray(toolLogs) && toolLogs.length > 0) {
      const details = bubble.createEl("details", { cls: "osint-tool-details" });
      const summary = details.createEl("summary", { cls: "osint-tool-summary" });
      summary.setText(`Действия (${toolLogs.length})`);
      const tList = details.createDiv({ cls: "osint-tool-list" });
      toolLogs.forEach(t => {
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
        await this.plugin.acpClient.resetSession(canvasKey);
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

    if (pivots && Array.isArray(pivots) && pivots.length > 0) {
      const pivotBox = bubble.createDiv({ cls: "osint-pivots-box" });
      pivotBox.createDiv({ cls: "osint-pivots-title", text: "Связанные ветки:" });

      const pillsContainer = pivotBox.createDiv({ cls: "osint-pivots-pills" });
      pivots.forEach(p => {
        const pStr = String(p).trim();
        if (!pStr) return;
        const pill = pillsContainer.createSpan({ cls: "osint-pivot-pill", text: pStr });
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

    this.plugin.acpClient.cancel(canvasKey);
    if (activeTask) {
      activeTask.isDone = true;
      this.plugin.activeTasks.delete(canvasKey);
    }
    this.hideTyping();
    this.appendAssistantMessageUI("🛑 **Генерация остановлена пользователем.**");
    new Notice("Генерация остановлена");
  }

  appendModelChooserUI(currentModel) {
    const row = this.messagesEl.createDiv({ cls: "osint-msg-row assistant" });
    const bubble = row.createDiv({ cls: "osint-bubble assistant" });

    bubble.createEl("h3", { text: "🤖 Управление моделью" });
    const p = bubble.createEl("p");
    p.innerHTML = `<strong>Текущая активная модель:</strong> <code>${currentModel}</code>`;

    const models = [
      { id: "agy/gemini-3.8-flash-high", name: "⚡ OmniRoute: Gemini 3.8 Flash High (рекомендуется)", desc: "Основная модель: быстрый глубокий OSINT без лимитов" },
      { id: "muse-spark-1.3-contributor", name: "🚀 OpenCode Go: Muse Spark 1.3", desc: "Альтернатива через Responses API" },
      { id: "deepseek-v4-flash", name: "🧠 DeepSeek V4 Flash", desc: "Аналитическая модель" }
    ];

    const box = bubble.createDiv({ cls: "osint-model-list-box", style: "display:flex; flex-direction:column; gap:6px; margin-top:10px;" });
    models.forEach(m => {
      const btn = box.createEl("button", {
        style: "text-align:left; padding:8px 12px; cursor:pointer; background:var(--background-secondary); border:1px solid var(--background-modifier-border); border-radius:6px;"
      });
      btn.innerHTML = `<div style="font-weight:600;">${m.name}</div><div style="font-size:11px; opacity:0.7;">${m.desc}</div>`;
      btn.addEventListener("click", async () => {
        await this.switchModel(m.id);
      });
    });

    this.scrollToBottom();
  }

  async switchModel(targetModel) {
    this.showTyping(`Смена модели на ${targetModel}...`);
    try {
      if (this.plugin.settings.engineMode === "hermes_acp") {
        await this.plugin.acpClient.setModel(targetModel);
        this.plugin.settings.acpModel = targetModel;
      } else {
        this.plugin.settings.model = targetModel;
      }
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

  async handleSend() {
    const raw = this.textarea.value.trim();
    if (!raw) return;

    const activeFile = this.getCurrentFile();
    const canvasKey = activeFile ? activeFile.path : (this.currentFilePath || "default");
    const isRunning = this.isCanvasLoading(canvasKey);

    // 1. КОМАНДА /stop
    if (raw === "/stop") {
      this.textarea.value = "";
      this.handleStop();
      return;
    }

    // 2. АКТИВНЫЙ СТИРИНГ / ПЕРЕНАПРАВЛЕНИЕ НА ТЕКУЩЕМ ХОЛСТЕ:
    if (isRunning) {
      this.textarea.value = "";
      this.appendUserMessageUI(raw);
      const canvasHistory = this.getHistory(canvasKey);
      canvasHistory.push({ role: "user", content: raw });
      await this.plugin.saveChatHistories();

      const task = this.plugin.activeTasks?.get(canvasKey);
      if (task && task.liveToolsList) {
        const item = task.liveToolsList.createDiv({ cls: "osint-tool-item" });
        item.setText(`🧭 Указание: ${raw}`);
        this.scrollToBottom();
      }

      try {
        await this.plugin.acpClient.prompt(raw, {}, canvasKey);
        new Notice("Указание передано агенту (Redirected active turn)");
      } catch (e) {
        console.warn("Ошибка отправки указания:", e);
      }
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
      await this.plugin.saveChatHistories();
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
        await this.plugin.acpClient.resetSession(canvasKey);
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
        const cur = (this.plugin.settings.engineMode === "hermes_acp")
          ? (this.plugin.acpClient?.currentModel || this.plugin.settings.acpModel || "agy/gemini-3.8-flash-high")
          : (this.plugin.settings.model || "agy/gemini-3.8-flash-high");

        this.appendModelChooserUI(cur);
        return;
      }

      const targetModel = parts[1];
      await this.switchModel(targetModel);
      return;
    }

    this.appendUserMessageUI(text);

    const canvasHistory = this.getHistory(canvasKey);
    canvasHistory.push({ role: "user", content: text });
    await this.plugin.saveChatHistories();

    this.showTyping("Hermes Agent подключается...");

    const toolLogs = [];
    let responseText = "";

    const task = {
      canvasKey: canvasKey,
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
      isDone: false
    };
    this.plugin.activeTasks.set(canvasKey, task);

    try {
      const canvasCtx = await this.plugin.getCanvasContext(activeFile);
      let canvasContextMsg = "";
      if (canvasCtx && canvasCtx.nodesCount > 0) {
        canvasContextMsg = `[ТЕКУЩИЙ ХОЛСТ "${canvasCtx.file}" (Всего ${canvasCtx.nodesCount} карточек)]:\n${canvasCtx.summary}\n`;
      } else {
        canvasContextMsg = `[ХОЛСТ "${activeFile ? activeFile.basename : 'Новый'}" ПУСТОЙ — начни сбор с чистого листа]\n`;
      }

      const isHermesAcp = this.plugin.settings.engineMode === "hermes_acp";

      if (isHermesAcp) {
        // РЕЖИМ 1: HERMES ACP (полноценный автономный агент со всеми инструментами)
        this.updateTyping("Hermes Agent подключается и запускает разведку...");

        const missionPrompt = `[OBSIDIAN CANVAS OSINT ДЛЯ "${activeFile ? activeFile.basename : 'Холст'}"]
Цель: "${text}"
${canvasContextMsg}

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

        // Создаем живой пузырь сообщения в чате
        this.hideTyping();
        const liveRow = this.messagesEl.createDiv({ cls: "osint-msg-row assistant" });
        const liveBubble = liveRow.createDiv({ cls: "osint-bubble assistant" });

        const liveToolsBox = liveBubble.createDiv({ cls: "osint-tool-box", style: "margin-bottom:8px;" });
        liveToolsBox.createDiv({ cls: "osint-tool-title", text: "Шаги исследования:" });
        const liveToolsList = liveToolsBox.createDiv({ cls: "osint-tool-list" });

        const isWarm = !!this.plugin.acpClient.sessionId;
        const initStatusText = isWarm ? "Анализ цели..." : "Инициализация сессии...";
        const initStatus = liveToolsList.createDiv({ cls: "osint-tool-item muted", text: initStatusText });

        const liveContent = liveBubble.createDiv({ cls: "osint-markdown-content" });

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

        await this.plugin.acpClient.prompt(missionPrompt, {
          onChunk: (chunk) => {
            task.streamedChunks += chunk;
            task.currentStatus = "";

            tryApplyLiveBlocks(task.streamedChunks);

            if (this.currentFilePath === canvasKey && task.liveContent) {
              const muted = task.liveToolsList?.querySelector(".osint-tool-item.muted");
              if (muted) muted.remove();

              if (!task.renderTimer) {
                task.renderTimer = setTimeout(() => {
                  task.renderTimer = null;
                  if (this.currentFilePath !== canvasKey || !task.liveContent) return;
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

            if (this.currentFilePath === canvasKey && task.liveToolsList) {
              const muted = task.liveToolsList.querySelector(".osint-tool-item.muted");
              if (muted) muted.remove();

              const tItem = task.liveToolsList.createDiv({ cls: "osint-tool-item" });
              tItem.setText(toolTitle);
              this.scrollToBottom();
            }
          }
        }, canvasKey);

        if (task.renderTimer) {
          clearTimeout(task.renderTimer);
          task.renderTimer = null;
        }
        await tryApplyLiveBlocks(task.streamedChunks);

        if (this.currentFilePath === canvasKey && task.liveContent) {
          task.liveContent.empty();
          const finalClean = task.streamedChunks.replace(/```(?:json|canvas)?[\s\S]*?```/g, "").trim();
          MarkdownRenderer.render(this.plugin.app, finalClean || "Данные обработаны.", task.liveContent, "", this);
        }

        responseText = task.streamedChunks;
      } else {
        // РЕЖИМ 2: DIRECT HTTP API
        this.updateTyping("Запрос к Direct API...");
        const apiMessages = canvasHistory.slice(-10).map((m, idx) => {
          if (idx === canvasHistory.slice(-10).length - 1 && m.role === "user") {
            return { role: "user", content: canvasContextMsg + "\n" + m.content };
          }
          return { role: m.role, content: m.content };
        });

        responseText = await this.plugin.queryDirectApi(apiMessages);
        this.hideTyping();
      }

      task.isDone = true;
      let stats = task.totalLiveStats || { added: 0, updated: 0, deleted: 0 };
      let pivots = [];

      const osintData = this.plugin.extractJson(responseText);
      if (osintData) {
        if (Array.isArray(osintData.pivots)) {
          pivots = osintData.pivots;
        }
        if (!isHermesAcp) {
          const directStats = await this.plugin.applyCanvasActions(osintData, activeFile);
          stats.added += directStats.added || 0;
          stats.updated += directStats.updated || 0;
          stats.deleted += directStats.deleted || 0;
        }
      }

      // СОХРАНЯЕМ В ИСТОРИЮ НУЖНОГО ХОЛСТА
      const currentCanvasHistory = this.getHistory(canvasKey);
      currentCanvasHistory.push({
        role: "assistant",
        content: responseText,
        stats: stats,
        pivots: pivots,
        toolLogs: task.toolLogs || []
      });
      await this.plugin.saveChatHistories();

      // Если пользователь сейчас на этом холсте и живой пузырь на экране — финализируем его
      if (this.currentFilePath === canvasKey && task.liveBubble && task.liveBubble.isConnected) {
        this.finalizeLiveBubbleUI(task.liveBubble, responseText, stats, pivots);
        this.scrollToBottom();
      } else if (this.currentFilePath === canvasKey) {
        this.appendAssistantMessageUI(responseText, stats, pivots, task.toolLogs || []);
      }

      this.plugin.activeTasks.delete(canvasKey);
      if (this.currentFilePath === canvasKey) {
        this.hideTyping();
      }
      this.updateInputControls();
    } catch (err) {
      this.plugin.activeTasks.delete(canvasKey);
      if (this.currentFilePath === canvasKey) {
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
          await this.plugin.acpClient.resetSession(canvasKey);
          new Notice("Контекст сброшен, повтор запроса...");
          this.textarea.value = text;
          this.handleSend();
        });

        new Notice(`Ошибка OSINT: ${err.message}`);
        this.scrollToBottom();
      }
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

    // Выбор режима работы
    new Setting(containerEl)
      .setName("Движок расследования (Engine Mode)")
      .setDesc("Hermes ACP запускает локального агента с полным доступом к терминалу, вебу и скриптам")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("hermes_acp", "⚡ Hermes ACP (Автономный локальный агент)")
          .addOption("direct_api", "🌐 Direct HTTP API (OpenCode Go / OmniRoute)")
          .setValue(this.plugin.settings.engineMode || "hermes_acp")
          .onChange(async (val) => {
            this.plugin.settings.engineMode = val;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.engineMode === "direct_api") {
      const presetBox = containerEl.createDiv({
        style: "background: var(--background-secondary); padding: 10px; border-radius: 6px; margin-bottom: 14px; border: 1px solid var(--background-modifier-border);"
      });
      presetBox.createEl("div", {
        text: "⚡ Быстрые пресеты для Direct API",
        style: "font-weight: 600; margin-bottom: 6px; font-size: 12px;"
      });

      const presetRow = presetBox.createDiv({ style: "display: flex; gap: 8px; flex-wrap: wrap;" });

      const presets = [
        {
          name: "OpenAI Official (GPT-4o)",
          url: "https://api.openai.com/v1",
          key: "",
          model: "gpt-4o"
        },
        {
          name: "OpenRouter (Gemini 2.0 Flash)",
          url: "https://openrouter.ai/api/v1",
          key: "",
          model: "google/gemini-2.0-flash-001"
        }
      ];

      presets.forEach(p => {
        const btn = presetRow.createEl("button", { text: p.name });
        btn.addEventListener("click", async () => {
          this.plugin.settings.apiBaseUrl = p.url;
          this.plugin.settings.model = p.model;
          if (p.key) this.plugin.settings.apiKey = p.key;
          await this.plugin.saveSettings();
          this.display();
          new Notice(`Применен пресет: ${p.name}`);
        });
      });

      new Setting(containerEl)
        .setName("API Key")
        .setDesc("Ключ доступа к API")
        .addText((text) => {
          text
            .setPlaceholder("sk-...")
            .setValue(this.plugin.settings.apiKey)
            .onChange(async (val) => {
              this.plugin.settings.apiKey = val;
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "password";
          text.inputEl.style.width = "280px";
        });

      new Setting(containerEl)
        .setName("API Base URL")
        .setDesc("Эндпоинт сервера")
        .addText((text) => {
          text
            .setValue(this.plugin.settings.apiBaseUrl)
            .onChange(async (val) => {
              this.plugin.settings.apiBaseUrl = val;
              await this.plugin.saveSettings();
            });
          text.inputEl.style.width = "320px";
        });

      new Setting(containerEl)
        .setName("Модель (Model)")
        .setDesc("Имя модели")
        .addText((text) =>
          text
            .setValue(this.plugin.settings.model)
            .onChange(async (val) => {
              this.plugin.settings.model = val;
              await this.plugin.saveSettings();
            })
        );
    }
  }
}

module.exports = GeminiCanvasOsintPlugin;
