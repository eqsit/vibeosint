import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PANEL_MODELS = [
  { id: 'opencode-go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: 'xhigh' },
  { id: 'codex/gpt-6.1-sol', name: 'GPT 6.1 Sol', reasoning: 'xhigh' },
  { id: 'agy/gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High', reasoning: 'high' },
];
export function normalizeModel(id) {
  let model = String(id || '').replace(/^omniroute[:/]/, '');
  if (model === 'deepseek-v4.1-flash') model = 'opencode-go/' + model;
  return model;
}
export const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export class PanelSettings {
  constructor(file, model = PANEL_MODELS[0].id) {
    this.file = file;
    this.value = { hermesModel: panelModel({hermesModel:model}), hermesProvider: "omniroute", hermesReasoning: PANEL_MODELS.find(m => m.id === normalizeModel(model)).reasoning };
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      this.value = this.validate(saved);
    }
  }
  validate(value) {
    const model = panelModel({hermesModel:value.hermesModel});
    if (!REASONING_LEVELS.includes(value.hermesReasoning)) throw new Error("Invalid panel reasoning");
    return {hermesModel:model, hermesProvider:"omniroute", hermesReasoning:value.hermesReasoning};
  }
  set(patch) {
    const next = this.validate({...this.value,...patch});
    fs.mkdirSync(path.dirname(this.file), {recursive:true});
    const temp = this.file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
    try {
      const fd = fs.openSync(temp, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next,null,2)+"\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp,this.file);
      this.value = next;
    } finally { if(fs.existsSync(temp)) fs.unlinkSync(temp); }
    return this.value;
  }
  select(model) {
    const id = panelModel({hermesModel:model});
    return this.set({hermesModel:id,hermesReasoning:PANEL_MODELS.find(m=>m.id===id).reasoning});
  }
}

export function panelModel(session, defaultModel = PANEL_MODELS[0].id) {
  const model = normalizeModel(session.hermesModel || defaultModel);
  if (!PANEL_MODELS.some(m => m.id === model)) throw new Error(`Модель «${model}» устарела или не поддерживается. Выберите /model из актуального списка; автоматическая замена отключена.`);
  return model;
}
