# VibeOSINT — Architecture & System Structure

Техническое описание структуры компонентов, расположения скиллов Hermes ACP, скриптов автоматизации и конфигураций.

---

## 1. Структура проекта и исходный код

- `/home/a/src/vibeosint/`
  - `main.js` — Ядро интеграции, запуск и управление процессом Hermes ACP, парсер JSON-RPC событий, расчет LTR-раскладки графа, дедупликация нод и работа с API.
  - `manifest.json` — Идентификатор и метаданные пакета.
  - `styles.css` — Стили карточек сущностей, подсветка утечек (красный акцент), связи, порты подключений и визуальная иерархия.
  - `.gitignore` — Исключение локальных баз данных, настроек и кэша.

---

## 2. Скиллы Hermes ACP (Расположение и назначение)

Hermes запускается через выделенный профиль:
`hermes -p obsidian acp --accept-hooks`

Скиллы профиля подгружаются из директории:
`/home/a/.hermes/profiles/obsidian/skills/`

А также из глобального хранилища скиллов системы:
`/home/a/.hermes/skills/`

### Ключевые скиллы для расследований:
1. **Telegram Bot OSINT Recon**:
   - Путь: `/home/a/.hermes/profiles/obsidian/skills/research/tg-bot-osint/SKILL.md`
   - Назначение: Первичный пробив цели (телефон, ИНН, никнейм, авто, VIN, ФИО) через пул из 29 сессий Telegram.
2. **Обход блокировок и WAF (Blocked Page Recovery)**:
   - Путь: `/home/a/.hermes/skills/research/blocked-page-recovery/SKILL.md`
   - Назначение: Стратегии восстановления заблокированных/защищенных Cloudflare страниц.
3. **Маршрутизация локального прокси (Local Proxy Routing)**:
   - Путь: `/home/a/.hermes/skills/devops/local-proxy-routing/SKILL.md`
   - Назначение: Маршрутизация запросов агента через SOCKS5/HTTP при ошибках 403 Forbidden и региональных блокировках.
4. **Верификация источников (Grounded Citations)**:
   - Путь: `/home/a/.hermes/skills/research/grounded-citations/SKILL.md`
   - Назначение: Привязка доказательств к открытым реестрам и проверенным URL.

---

## 3. Скрипты автоматизации и пул аккаунтов

- `/home/a/tg_accounts/` (симлинк на `/home/a/files/tg_accounts/`)
  - `osint_bot_query.py` — Главный CLI-скрипт запросов к OSINT-боту. Вызывается агентом Hermes через терминал:
    ```bash
    /home/a/tg_accounts/osint_bot_query.py --query "<НОМЕР_ИЛИ_ИНН_ИЛИ_ЮЗЕР>" --json
    ```
  - `*.session` — 29 авторизованных сессий Telegram для ротации и балансировки запросов.
  - `accounts_state.json` — Состояние пула, лимиты и тайминги аккаунтов.
  - `working_accounts.json` — Список проверенных активных аккаунтов.

- `/home/a/files/`
  - `update_canvas.py` — Скрипт программного обновления структуры графа.
  - `update_canvas_photos.py` — Инжекция фотоматериалов и аватаров в ноды.
  - `update_mishchenko_canvas.py` — Пример целевого пакетного обновления досье.

---

## 4. Конфигурация профиля Hermes ACP

- Конфигурационный файл профиля:
  `/home/a/.hermes/profiles/obsidian/config.yaml`
- Переменные окружения профиля:
  `/home/a/.hermes/profiles/obsidian/.env`
- База состояний сессий:
  `/home/a/.hermes/profiles/obsidian/state.db`
- Логи моста ACP:
  `/home/a/.hermes/logs/acp-bridge.log`

---

## 5. Сетевая инфраструктура и прокси

- Локальный прокси: SOCKS5/HTTP на порту `2080` (или внешний SOCKS5H).
- Переменные окружения, передаваемые в процесс Hermes:
  - `NO_PROXY=127.0.0.1,localhost` — обязательная изоляция локального IPC-моста.
  - `ALL_PROXY` / `HTTPS_PROXY` — маршрутизация внешних сетевых тулов агента.
