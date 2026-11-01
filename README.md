# ainep

Шлюз для нативного Claude Code: передаёт клиентский OAuth Bearer к фиксированному upstream и проверяет запросы по закрытой схеме. Credentials остаются под управлением клиента; шлюз видит access token в памяти при обработке запроса, но не хранит его и не обновляет. Это не средство гарантированной анонимности или предотвращения блокировок.

## Установка npm-пакета

Подготовлена версия 0.1.0; она ещё не опубликована в registry. Требуется установленный Bun >=1.3.0 в PATH: Node.js сам по себе недостаточен.

После публикации:

```sh
bunx ainep
bunx ainep --help
bunx ainep --version
```

Для глобальной установки: `npm install -g ainep` или `bun add -g ainep`. Команда `ainep` без аргументов запускает сервер с переменными окружения, описанными ниже. Bun читает `.env` из рабочей папки; запускайте сервер из отдельной папки с его конфигурацией. OAuth refresh и CONNECT-прокси в эту версию не входят.

Локальную упаковку можно проверить до публикации:

```sh
npm pack --dry-run
npm pack
```

`prepack` запускает проверку типов, тесты и сборку. В npm-архив включаются только `dist/ainep.js`, package.json, README и файл лицензии, если он добавлен. Исходники, тесты, отчёты, `.env`, сертификаты и декларации внутренних модулей не публикуются. Зависимости desy/h11 устанавливаются npm отдельно и не встроены в сборку.

## Сервер

Нужен Bun 1.3.0 или новее:

```sh
bun install --frozen-lockfile
```

В `.env` с правами 600 задать только отдельный ключ доступа к шлюзу:

```dotenv
GATEWAY_TOKEN="заменить-случайным-ключом"
```

Ключ должен содержать минимум 32 печатных ASCII-символа без пробелов. Генерация: `openssl rand -hex 32`. Файл `.env` исключён из git. `ANTHROPIC_AUTH_TOKEN` на сервере больше не используется; старое серверное значение следует убрать из своего окружения/хранилища при миграции. Программа не читает Keychain.

```sh
bun start
```

По умолчанию listener `http://127.0.0.1:8443`. Для внешнего listener задать `GATEWAY_HOST`, `GATEWAY_PORT`, `TLS_CERT_FILE`, `TLS_KEY_FILE`. Без TLS внешний listener запрещён; проверку TLS upstream отключать нельзя. Сборка: `bun run build`, запуск: `bun dist/ainep.js`.

## Клиент и авторизация

Схема для проверенного custom API origin:

```text
ANTHROPIC_BASE_URL=https://<домен-шлюза>
ANTHROPIC_CUSTOM_HEADERS=x-gateway-token: <отдельный-ключ-шлюза>
```

Это обозначения настроек, а не готовые секреты или инструкция извлечения токена из Keychain. Штатный OAuth access token клиент добавляет в `Authorization: Bearer`; шлюз передаёт его без подмены. Сам `x-gateway-token` остаётся на шлюзе. `x-api-key`, отсутствие или неоднозначность credentials отклоняются. В серверной конфигурации upstream OAuth отсутствует. Ротация клиентского access token не требует перезапуска шлюза.

Тест с временным сохранённым OAuth и тест с `CLAUDE_CODE_OAUTH_TOKEN` прошли на mock в режиме safe-mode. Реальный Keychain и аккаунт не использовались. `--bare` не является проверенным OAuth-сценарием.

**Обновление OAuth пока не проходит через этот шлюз.** Штатный refresh использует отдельный `https://platform.claude.com/v1/oauth/token`; `ANTHROPIC_BASE_URL` его не меняет. Включать полный запрет прямых соединений до решения сетевого пути авторизации рано. Подробности: [docs/oauth-audit.md](docs/oauth-audit.md).

## HTTP и поддерживаемая схема

Только POST `/v1/messages` и `/v1/messages/count_tokens`, необязательный одиночный `?beta=true`. Content-Type — application/json. Поддерживаемая версия `anthropic-version: 2023-06-01` (используется и по умолчанию). Остальные версии отклоняются. Origin всегда `https://api.anthropic.com`; пользователь не может выбирать адрес назначения. Редиректы не выполняются и возвращаются как 502 без Location.

Поддерживаемое подмножество описано desy 0.0.29 в `src/privacy/schema.ts`:

- Оба маршрута: model, messages; optional system, tools, tool_choice, thinking, context_management.
- Messages дополнительно требует max_tokens; допускает metadata.user_id, stream, temperature, top_p, top_k, stop_sequences, service_tier, cache_control, output_config.
- Блоки: text, image (base64/url), thinking, redacted_thinking, tool_use, tool_result. В tool_result — строка или text/image блоки.
- Инструменты: пользовательские JSON Schema, strict/defer_loading/cache_control. Серверные инструменты и document-блоки пока не поддерживаются.
- Context management: только clear_thinking_20251015. Другие варианты отклоняются до добавления схемы и тестов.

Неизвестные поля во вложенных протокольных объектах и неизвестные типы блоков дают 400 без отправки upstream. Tool input, input_schema и output_config.format.schema являются пользовательскими данными с произвольными ключами; строки, включая metadata.user_id, не проверяются на отсутствие личных данных. Это контроль формата, не фильтр содержимого. Beta-заголовок передаётся; это не обещание поддержки всех beta-функций. Неизвестные входящие заголовки не пересылаются.

metadata сохраняется: прежнее удаление отменено. Всё принятое JSON-тело сохраняется побайтно после распаковки, без повторной сериализации. Разбор выполняется JSON.parse: при дублировании ключа проверяется последнее значение. Отдельного лимита глубины нет. Проверка структуры не заменяет все семантические ограничения сервера Anthropic.

Поддерживаются identity, gzip, deflate (zlib), br. Неизвестная/составная кодировка — 415, повреждённое сжатие или UTF-8/JSON — 400, превышение 16 MiB до/после распаковки — 413. Проверка распакованного лимита выполняется внутри декомпрессора.

Входящие cookies, forwarding-заголовки и заголовки SDK не копируются. Из ответа передаются content-type, request-id, retry-after, anthropic-ratelimit-*; cookies и Content-Length/Content-Encoding не копируются. Ошибки upstream, включая 401/429, получает клиент. Повторов и OAuth refresh на сервере нет.

Deadline 10 минут, включая SSE; idleTimeout 60 секунд. При отключении клиента upstream отменяется. После начала SSE ошибку передают обрывом потока, поэтому клиент должен проверять завершающее событие. Журнал содержит только route/status/durationMs до начала ответа; тела и credentials в журнал не попадают.

## Проверка

```sh
bun test
bun run check
bun run build
bun run audit /absolute/path/to/claude docs/oauth-audit.json
```

31 автоматический тест: авторизация и смена клиентского токена, закрытые схемы, отсутствие upstream-вызовов при отказе, сжатие, лимиты, точность тела, защита адреса назначения, SSE и отмена.

Восемь сценариев настоящего клиента на локальном mock описаны в [docs/oauth-audit.md](docs/oauth-audit.md). Стенд использует отдельные временные config/tmp/cwd, фиктивные credentials и sandbox с единственным разрешённым localhost-портом. Настоящие credentials, настройки пользователя и диалоги недоступны. Preflight проверяет изоляцию до запуска Claude; временные файлы удаляются. Реальный вход/refresh и весь сетевой трафик обычного клиента этим не проверены.

Прокси сам по себе не блокирует прямую сеть клиента. Развёртывание на VPS и правила macOS ещё не выполнены. Аудиты [docs/audit.md](docs/audit.md) и [docs/client-audit.md](docs/client-audit.md) описывают предыдущую реализацию; актуальные решения — [docs/decisions.md](docs/decisions.md).

## Лицензия

MIT — см. [LICENSE](LICENSE).
