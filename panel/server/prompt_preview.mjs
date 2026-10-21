// Предпросмотр собранного промпта панели без запуска сервера.
// Использование: node /opt/vibeosint/server/prompt_preview.mjs
import { buildHermesPrompt, promptModulesInfo } from "./prompt_builder.mjs";

const info = promptModulesInfo();
console.log(`# modules: ${info.loaded}/${info.expected} from ${info.dir}`);
if (info.missing.length) console.log(`# MISSING: ${info.missing.join(", ")}`);
console.log("# files: " + info.files.join(", "));
console.log("");

const sample = buildHermesPrompt({
  sessionId: "ses_preview",
  title: "Пример цели",
  text: "проверь домен example.com (пример для предпросмотра, не расследование)",
  session: { messages: [] },
  attachments: [],
  includeHistory: false,
});
console.log(sample);
