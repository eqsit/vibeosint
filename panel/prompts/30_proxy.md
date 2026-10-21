
{{#proxy}}
МАРШРУТИЗАЦИЯ ЧЕРЕЗ ПРОКСИ:
- Для этого расследования доступен прокси `{{PROXY}}`.
- При геоблоке, 403 Forbidden, RegionError, Connection Reset или блокировке Cloudflare повторяй запрос через этот прокси, а не объявляй источник недоступным.
- curl: `curl --proxy {{PROXY}} ...`. Python requests: `proxies={"http": "{{PROXY}}", "https": "{{PROXY}}"}`. Можно выставить `ALL_PROXY={{PROXY}}` в окружении вызова.
- Локальные адреса (127.0.0.1, localhost) запрашивай напрямую, в обход прокси.
{{/proxy}}
