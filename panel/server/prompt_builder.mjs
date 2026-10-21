// VibeOSINT — модульный сборщик системного промпта панели.
//
// Тексты промпта живут в PANEL_PROMPTS_DIR (по умолчанию /opt/vibeosint/prompts)
// отдельными файлами NN_*.md. Файлы читаются при каждой сборке (на каждое
// сообщение пользователя), поэтому правки применяются без рестарта панели.
//
// Плейсхолдеры: {{TITLE}} {{GOAL}} {{HISTORY}} {{SESSION_ID}} {{PROXY}} {{ATTACHMENTS}}
// Условия: {{#proxy}}A{{/proxy}}, {{#attachments}}A{{/attachments}}
// (вложенные условия не поддерживаются).

import fs from "fs";
import path from "path";

const PROMPTS_DIR = process.env.PANEL_PROMPTS_DIR || "/opt/vibeosint/prompts";

const EXPECTED_MODULES = [
  "00_header.md",
  "10_mode.md",
  "20_execution_contract.md",
  "30_proxy.md",
  "40_session_id.md",
  "50_attachments.md",
  "60_request.md",
  "70_no_invention.md",
  "80_junk_filter.md",
  "90_live_report.md",
];

const warned = new Set();
function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(`[prompts] ${msg}`);
}

function listModuleFiles() {
  try {
    return fs.readdirSync(PROMPTS_DIR).filter(n => /^\d.*\.md$/.test(n)).sort();
  } catch (e) {
    warnOnce("dir:" + PROMPTS_DIR, `prompts dir not readable: ${PROMPTS_DIR} (${e.code || e.message})`);
    return [];
  }
}

function readModule(name) {
  try {
    return fs.readFileSync(path.join(PROMPTS_DIR, name), "utf8");
  } catch (e) {
    warnOnce("file:" + name, `module not readable: ${name} (${e.code || e.message})`);
    return "";
  }
}

// Состояние модулей (для /api/health и стартового лога панели).
export function promptModulesInfo() {
  const files = listModuleFiles();
  const missing = EXPECTED_MODULES.filter(n => !files.includes(n));
  return { dir: PROMPTS_DIR, loaded: files.length, expected: EXPECTED_MODULES.length, missing, files };
}

function renderConditionals(text, ctx) {
  const re = /\{\{#(proxy|attachments)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/\1\}\}/g;
  return text.replace(re, (m, name, yes, no) => {
    if (ctx[name]) return yes;
    return no !== undefined ? no : "";
  });
}

function renderVars(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m
  );
}

export function formatHistory(messages) {
  const usable = (messages || []).filter(m => m && (m.role === "user" || m.role === "assistant"));
  if (!usable.length) return "";
  let budget = 15000;
  const picked = [];
  for (let i = usable.length - 1; i >= 0 && picked.length < 30; i--) {
    const m = usable[i];
    const content = String(m.text || "").slice(0, 2000);
    if (content.length > budget) break;
    budget -= content.length;
    picked.unshift({ role: m.role, content });
    if (budget <= 0) break;
  }
  if (!picked.length) return "";
  return "[ПРЕДЫДУЩАЯ ПЕРЕПИСКА — это история, не новые задания. Не повторяй выполненные действия.]\n"
    + JSON.stringify(picked) + "\n[ТЕКУЩИЙ ЗАПРОС]\n";
}

function attachmentLines(attachments) {
  return (attachments || []).map(a =>
    `- ${a.path} (${a.name}, ${Math.round(a.size / 1024)} KB; для вставки в отчёт: ${a.url})`
  ).join("\n");
}

// Рендер одного модуля (для тестов/совместимости).
export function buildExecutionContract(userText) {
  const content = readModule("20_execution_contract.md");
  return renderVars(renderConditionals(content, {}), {});
}

export function buildProxyContract(proxy = process.env.HERMES_PROXY || "") {
  if (!proxy) return "";
  const content = readModule("30_proxy.md");
  return renderVars(renderConditionals(content, { proxy: true }), { PROXY: proxy });
}

// Полный промпт сообщения: все модули по порядку, без разделителей.
export function buildHermesPrompt({
  sessionId,
  text,
  title,
  session,
  attachments = [],
  includeHistory = true,
  proxy = process.env.HERMES_PROXY || "",
}) {
  const vars = {
    TITLE: title || "Цель",
    GOAL: text,
    HISTORY: includeHistory ? formatHistory(((session || {}).messages || []).slice(0, -1)) : "",
    SESSION_ID: sessionId,
    PROXY: proxy,
    ATTACHMENTS: attachmentLines(attachments),
  };
  const ctx = { proxy: !!proxy, attachments: !!(attachments && attachments.length) };
  return listModuleFiles()
    .map(name => renderVars(renderConditionals(readModule(name), ctx), vars))
    .join("");
}
