# ainep

Локальный проект Aleksey: шлюз AI-провайдеров; Claude — первый провайдер на /claude. Не обещает предотвращение блокировок аккаунта.

Работать на русском, код на английском. Применять owner и js-style. Читать `docs/decisions.md` перед изменениями. Реализовывать по одному согласованному модулю; последующие модули требуют отдельного согласования.

## Стек и команды

- Bun 1.3.0+, TypeScript strict, h11 1.0.21, desy 0.0.29, встроенный fetch.
- `bun install --frozen-lockfile` — зависимости.
- `bun start` — сервер из исходников.
- `npm pack --dry-run` / `npm pack` — проверка состава / создание npm-архива; prepack запускает check, test и build.
- CLI пакета: `ainep`, `--help`, `--version`; требует Bun в PATH.
- `bun test` — локальные HTTP/SSE тесты с искусственными credentials.
- `bun run check` — проверка типов.
- `bun run build` — JS-сборка и декларации типов.
- `bun run audit /absolute/path/to/claude [report.json]` — ручной изолированный прогон настоящего клиента на macOS, отдельно от unit/integration tests.

## Структура

- `src/proxy/proxy.ts` — HTTP-модуль, экспорт startProxy и его типы.
- `src/proxy/main.ts` — запуск API или `ainep connect` с переменными окружения.
- `src/connect/connect.ts` — отдельный авторизованный HTTP(S) CONNECT listener; фиксированный список хостов авторизации.
- `src/run/run.ts` — launcher `ainep run claude [args...]`; настройки API/CONNECT только в окружении дочернего процесса, наследование терминала и передача сигналов.
- `src/proxy/proxy.test.ts` — интеграционные проверки с локальным upstream.
- `src/privacy/privacy.ts` — ограниченная распаковка, проверка UTF-8/JSON и сохранение исходных байтов.
- `src/providers/provider.ts` — общий контракт провайдера.
- `src/providers/claude/claude.ts` — маршруты, upstream, OAuth, query/version и заголовки Claude.
- `src/providers/claude/schema.ts` — закрытые desy-схемы Claude.
- `src/privacy/privacy.test.ts` — проверки очистки, точности значений и ошибок декодирования.
- `src/audit/audit.ts` — macOS sandbox, preflight, mock API, сценарии клиента и отчёт со структурой запросов.
- `src/audit/main.ts` — CLI запуска стенда.
- `docs/client-audit.md` и `docs/client-audit.json` — выводы и обезличенные результаты фактического запуска.
- `docs/audit.md` — исходный аудит cc-gateway и Claude Code 2.1.281.
- `docs/decisions.md` — действующие решения и ожидающие согласования вопросы.

## Инварианты

Не читать реальные credentials или историю для тестов. Не выводить тела запросов, токены, произвольные URL или заголовки в логи. Не отключать проверку TLS. Не разрешать клиенту выбирать upstream и не следовать редиректам. При неподдерживаемом формате возвращать ошибку.

В h11 1.0.21 createSizeLimitModule использует copyReq, который теряет Request.signal. Прокси ограничивает тело самостоятельно, сохраняя исходный Request. Не заменять эту реализацию без теста отключения клиента.

Privacy сохраняет metadata и всё принятое тело побайтно после декодирования. sanitizeBody принимает checkBody от провайдера. Неизвестные протокольные поля/типы отклоняются. JSON разбирается штатным JSON.parse, отдельного запрета дубликатов и лимита глубины нет. Tool input, JSON Schema, тексты и непрозрачный metadata.user_id остаются пользовательскими данными; их ключи/содержимое не являются перечнем протокольных полей. Новые API-блоки требуют расширения schemas конкретного провайдера и тестов. Proxy требует x-gateway-token отдельно от клиентского Authorization: Bearer; x-api-key отклоняется. Серверный OAuth удалён из конфигурации; клиентский токен не сохраняется и не кэшируется. Полной анонимизации или совместимости всех функций это не означает.

Audit запускается с искусственными API/OAuth credentials и allowlist окружения, отдельными CLAUDE_CONFIG_DIR/CLAUDE_CODE_TMPDIR/TMPDIR. Не подменять HOME, не наследовать secrets, не ослаблять network deny при сбое клиента. Sandbox preflight должен пройти до запуска Claude. В отчёте сохраняются имена полей, типы/длины, имена заголовков; значения credentials, идентификаторов и содержимое диалогов не сохраняются. Изоляция macOS не равнозначна VM: разрешён системный доступ, пользовательские каталоги и известные Keychain Mach-сервисы запрещены.


Проверка после введения /claude: docs/provider-audit.json; методика — docs/oauth-audit.md. Восемь сценариев штатного клиента успешны на mock. OAuth refresh использует отдельный фиксированный TOKEN_URL; ANTHROPIC_BASE_URL его не меняет. Полный запрет прямой сети до решения этого вопроса не включать.

Схемы используют desy 0.0.29. Не применять optional()/allowEmpty() напрямую к обязательным полям: они разрешают null/undefined. Общие схемы не мутировать при добавлении optionality. createObject исключает массивы и использует shape без прототипа для строгой проверки ключей.

Npm-пакет 0.3.0: bin → dist/ainep.js, files → только dist/ainep.js (README/package.json/license добавляет npm). JS-сборка external для зависимостей desy/h11. Публиковать отчёты аудита, пользовательские данные и секреты нельзя. Лицензия MIT выбрана пользователем; текст в LICENSE. Публикация в registry пока не выполнена.

Маршруты Claude только /claude/v1/messages и /claude/v1/messages/count_tokens. Старые /v1/... отклоняются. Для локальных тестов startProxy принимает upstreamOrigins: { claude: origin }; клиент назначение менять не может. Журнал содержит provider/route/status/durationMs.

CONNECT: команда ainep connect, default 127.0.0.1:8444; для внешнего listener TLS обязателен. Proxy Basic login ainep, пароль GATEWAY_TOKEN. Разрешены только platform.claude.com:443, claude.ai:443, claude.com:443; api.anthropic.com запрещён. Не логировать Proxy-Authorization. openConnection — программная подстановка для локальных тестов. Сборка и тесты выполняются без создания tgz, если пользователь не попросил релиз/архив. Проверка docs/connect-audit.json наблюдает CONNECT попытки refresh, а не успешную ротацию токена.

Launcher: обязательны GATEWAY_URL и CONNECT_PROXY_URL (origin без пути и credentials, HTTPS вне loopback), GATEWAY_TOKEN. Сам добавляет /claude и proxy credentials. Заменяет обе формы proxy env/NO_PROXY и ANTHROPIC_CUSTOM_HEADERS только у дочернего процесса. Остальное окружение и OAuth клиента наследуются. Без shell/alias/hijack, изменения Keychain и firewall. Тесты используют искусственный claude во временном PATH; не запускать реальный аккаунт для тестов.
