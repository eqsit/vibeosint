import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionContract, buildHermesPrompt, promptModulesInfo } from './prompt_builder.mjs';

// Промпты панели собираются из модулей /opt/vibeosint/prompts (см. prompt_builder.mjs).
const base = { sessionId: 'ses_test123', title: 'Тест', session: { messages: [] }, attachments: [], includeHistory: false, proxy: '' };
const baseEnv = { sessionId: 'ses_test123', title: 'Тест', session: { messages: [] }, attachments: [], includeHistory: false };

test('all prompt modules present', () => {
  const info = promptModulesInfo();
  assert.equal(info.missing.length, 0, 'missing: ' + info.missing.join(', '));
  assert.equal(info.loaded, info.expected);
  assert.ok(info.expected >= 10);
});

test('contract stops when scoped questions have supported answers, without saturation mandate', () => {
  const text = buildExecutionContract('Public documentation question');
  assert.match(text, /вопросы пользователя/);
  assert.match(text, /engines="google"/);
  assert.match(text, /ошибка.*не.*отсутствие/i);
  assert.doesNotMatch(text, /Продолжай поиск до насыщения|все ветки пройдены до насыщения|ОБЯЗАТЕЛЬНЫЙ ПЕРВЫЙ ШАГ/);
  assert.match(text, /Остановись/);
});

test('prompts render all key sections', () => {
  const normal = buildHermesPrompt({ ...base, text: 'проверь домен example.com' });
  assert.match(normal, /\[OSINT-РАССЛЕДОВАНИЕ: "Тест"\]/);
  assert.match(normal, /\[РЕЖИМ: OSINT-РАССЛЕДОВАНИЕ\]/);
  assert.match(normal, /ОБЛАСТЬ И КРИТЕРИЙ ЗАВЕРШЕНИЯ/);
  assert.match(normal, /session_id="ses_test123"/);
  assert.match(normal, /Запрос пользователя: проверь домен example\.com/);
  assert.match(normal, /ЗАПРЕТ НА ВЫДУМКИ/);
  assert.match(normal, /ФИЛЬТР МУСОРА/);
  assert.match(normal, /ЖИВОЙ ОТЧЁТ/);
  assert.match(normal, /Проведи полноценную и всестороннюю проверку/);
  assert.doesNotMatch(normal, /Глубокий режим/);
  assert.doesNotMatch(normal, /ПРИКРЕПЛЁННЫЕ ИЗОБРАЖЕНИЯ/);
  assert.doesNotMatch(normal, /МАРШРУТИЗАЦИЯ ЧЕРЕЗ ПРОКСИ/);
  assert.doesNotMatch(normal, /ГЛУБОКОЕ OSINT-РАССЛЕДОВАНИЕ|Глубокий режим/);
  assert.doesNotMatch(normal, /\{\{[#/]/);
});

test('attachments and proxy blocks are conditional', () => {
  const withAtt = buildHermesPrompt({ ...base, text: 'x', attachments: [{ path: '/tmp/a.jpg', name: 'a.jpg', size: 2048, url: '/api/uploads/ses/a.jpg' }] });
  assert.match(withAtt, /ПРИКРЕПЛЁННЫЕ ИЗОБРАЖЕНИЯ/);
  assert.match(withAtt, /\/tmp\/a\.jpg/);

  const prev = process.env.HERMES_PROXY;
  try {
    delete process.env.HERMES_PROXY;
    assert.doesNotMatch(buildHermesPrompt({ ...baseEnv, text: 'x' }), /МАРШРУТИЗАЦИЯ ЧЕРЕЗ ПРОКСИ/);
    process.env.HERMES_PROXY = 'http://127.0.0.1:31313';
    const withProxy = buildHermesPrompt({ ...baseEnv, text: 'x' });
    assert.match(withProxy, /МАРШРУТИЗАЦИЯ ЧЕРЕЗ ПРОКСИ/);
    assert.match(withProxy, /curl --proxy http:\/\/127\.0\.0\.1:31313/);
  } finally {
    if (prev === undefined) delete process.env.HERMES_PROXY; else process.env.HERMES_PROXY = prev;
  }
});

test('history included only when asked', () => {
  const session = { messages: [{ role: 'user', text: 'привет' }, { role: 'assistant', text: 'ок' }, { role: 'user', text: 'текущий' }] };
  const withH = buildHermesPrompt({ ...base, text: 'текущий', session, includeHistory: true });
  assert.match(withH, /ПРЕДЫДУЩАЯ ПЕРЕПИСКА/);
  const noH = buildHermesPrompt({ ...base, text: 'текущий', session, includeHistory: false });
  assert.doesNotMatch(noH, /ПРЕДЫДУЩАЯ ПЕРЕПИСКА/);
});
