# Развёртывание и использование ainep

Инструкция для пробного развёртывания ainep 0.3.0 на VPS с Ubuntu 24.04 и подключения Claude Code на Mac. Установка выполняется из текущих исходников; публикация npm-пакета не требуется.

На 3 ноября 2026 года локально прошли проверка типов, 44 автоматических теста и сборка на Bun 1.3.0. Производственное развёртывание по этой инструкции ещё не проверялось. Успешный OAuth login/refresh настоящего аккаунта не подтверждён: стенд проверял запросы с искусственными credentials и попытку refresh через CONNECT.

## 1. Схема и требования

```text
Claude Code на Mac
  ├─ сообщения → HTTPS :8443 → ainep API → api.anthropic.com
  └─ OAuth     → HTTPS :8444 → ainep CONNECT → разрешённые хосты
```

Нужны:

- VPS с Ubuntu 24.04, systemd, SSH и sudo.
- Домен, указывающий непосредственно на VPS, без HTTP-проксирования DNS-провайдером.
- Bun >=1.3.0 на VPS и Mac.
- Установленный штатный Claude Code в PATH на Mac.
- Исходники проекта на Mac в `/Users/aleksey/projects/ainep`.

В командах замени `gateway.example.com` своим доменом, `VPS_IP` адресом сервера и `admin` своим SSH-пользователем. Пути к локальному проекту также замени, если они отличаются.

API и CONNECT запускаются отдельными процессами. Сертификат и ключ шлюза у них общие, порты разные. OAuth остаётся под управлением Claude Code: на VPS не нужно переносить credentials клиента.

Launcher задаёт proxy env только дочернему клиенту. Он не блокирует прямую сеть средствами macOS, не меняет настройки браузера и не гарантирует анонимность или отсутствие блокировок аккаунта.

## 2. Подготовить DNS и сеть

Создай DNS-запись A для домена на IPv4 VPS. Если существует AAAA, она должна вести на этот сервер; описанная ниже конфигурация listener использует IPv4, поэтому не публикуй AAAA без отдельной рабочей IPv6-настройки.

Разреши входящие TCP-подключения в панели VPS и существующем firewall:

| Порт | Назначение |
| --- | --- |
| Твой порт SSH | Администрирование |
| 80 | Выпуск и продление TLS-сертификата |
| 8443 | API ainep |
| 8444 | CONNECT ainep |

При возможности ограничь доступ к 8443/8444 своими клиентскими IP. Сохрани доступ по SSH при изменении сетевых правил. Серверу нужны исходящие DNS и HTTPS к upstream и сервисам выпуска сертификата.

## 3. Подготовить VPS

Все команды этого раздела выполняются на VPS под SSH-пользователем с sudo.

```sh
sudo apt update
sudo apt install -y curl unzip rsync openssl certbot
```

Если Bun ещё не установлен:

```sh
curl -fsSL https://bun.com/install | bash
sudo install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun
/usr/local/bin/bun --version
```

Установщик загружает актуальную версию Bun. После установки обязательно выполни проверки проекта из следующего раздела. Проверенная локально версия — 1.3.0.

Создай пользователя и каталог сервиса; команду useradd выполняй только при первой установке:

```sh
sudo useradd --system --user-group \
  --home-dir /opt/ainep --shell /usr/sbin/nologin ainep
sudo install -d -m 0755 /opt/ainep
```

## 4. Передать и собрать проект

На Mac из каталога проекта:

```sh
cd /Users/aleksey/projects/ainep

rsync -av \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='.env*' \
  --exclude='certs/' \
  --exclude='docs/' \
  --exclude='*.log' \
  --exclude='*.tgz' \
  ./ admin@VPS_IP:~/ainep-upload/
```

Передаётся текущее рабочее дерево, включая незакоммиченный launcher. Файлы окружения, сертификаты и отчёты аудита исключены. Не помещай пользовательские данные или credentials в исходники.

На VPS:

```sh
sudo rsync -a "$HOME/ainep-upload/" /opt/ainep/
sudo chown -R ainep:ainep /opt/ainep

cd /opt/ainep
sudo -u ainep /usr/local/bin/bun install --frozen-lockfile
sudo -u ainep /usr/local/bin/bun run check
sudo -u ainep /usr/local/bin/bun test
sudo -u ainep /usr/local/bin/bun run build

/usr/local/bin/bun dist/ainep.js --version
```

Выполняй команды по порядку и остановись при ошибке. Не запускай сервер до успешного завершения проверок и сборки. Ожидаемая версия CLI — 0.3.0. `desy` и `h11` остаются внешними зависимостями: одного файла `dist/ainep.js` без установленных зависимостей недостаточно.

## 5. Выпустить TLS-сертификат

Убедись, что домен уже указывает на VPS, а TCP-порт 80 доступен из интернета и свободен:

```sh
sudo certbot certonly --standalone -d gateway.example.com
```

Если порт 80 уже занят веб-сервером, используй подходящий ему метод Certbot вместо standalone. Не останавливай существующие сервисы вслепую.

Создай каталог копии сертификата для пользователя ainep:

```sh
sudo install -d -o root -g ainep -m 0750 /etc/ainep
sudo install -d -o root -g ainep -m 0750 /etc/ainep/tls
sudo nano /etc/letsencrypt/renewal-hooks/deploy/ainep
```

Вставь следующий скрипт, заменив домен:

```sh
#!/bin/sh
set -eu

cert_dir=/etc/letsencrypt/live/gateway.example.com

install -o root -g ainep -m 0640 \
  "$cert_dir/fullchain.pem" /etc/ainep/tls/fullchain.pem

install -o root -g ainep -m 0640 \
  "$cert_dir/privkey.pem" /etc/ainep/tls/privkey.pem

if systemctl is-active --quiet ainep-api.service; then
  systemctl restart ainep-api.service
fi

if systemctl is-active --quiet ainep-connect.service; then
  systemctl restart ainep-connect.service
fi
```

Примени:

```sh
sudo chmod 0750 /etc/letsencrypt/renewal-hooks/deploy/ainep
sudo /etc/letsencrypt/renewal-hooks/deploy/ainep
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

После настоящего продления hook копирует сертификат и перезапускает активные сервисы. Перезапуск прервёт текущие соединения, включая SSE. Порт 80 должен оставаться доступным для последующих standalone-проверок. Dry-run проверяет продление, а ручной запуск скрипта выше — копирование файлов; после создания сервисов отдельно проверь его перезапуском и повторной HTTPS-проверкой.

## 6. Задать серверную конфигурацию

Сгенерируй отдельный ключ доступа:

```sh
openssl rand -hex 32
```

Сохрани результат в менеджере паролей. Один и тот же ключ используется API, CONNECT и клиентским launcher. Не используй OAuth access token в качестве ключа шлюза.

Создай файл при первой установке:

```sh
sudo install -o root -g root -m 0600 /dev/null /etc/ainep/server.env
sudo nano /etc/ainep/server.env
```

Содержимое:

```dotenv
GATEWAY_HOST=0.0.0.0
GATEWAY_TOKEN=REPLACE_WITH_GENERATED_HEX_TOKEN
TLS_CERT_FILE=/etc/ainep/tls/fullchain.pem
TLS_KEY_FILE=/etc/ainep/tls/privkey.pem
```

Замени placeholder сгенерированным ключом. Порты задаются отдельно в systemd. OAuth-переменные и клиентские credentials на сервер добавлять не нужно. Не повторяй команду install с `/dev/null` при редактировании существующего файла: она очистит его.

## 7. Создать systemd-сервисы

Создай API unit:

```sh
sudo nano /etc/systemd/system/ainep-api.service
```

```ini
[Unit]
Description=ainep API gateway
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=ainep
Group=ainep
WorkingDirectory=/opt/ainep
EnvironmentFile=/etc/ainep/server.env
Environment=GATEWAY_PORT=8443
ExecStart=/usr/local/bin/bun /opt/ainep/dist/ainep.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
UMask=0077

[Install]
WantedBy=multi-user.target
```

Создай CONNECT unit:

```sh
sudo nano /etc/systemd/system/ainep-connect.service
```

```ini
[Unit]
Description=ainep OAuth CONNECT proxy
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=ainep
Group=ainep
WorkingDirectory=/opt/ainep
EnvironmentFile=/etc/ainep/server.env
Environment=GATEWAY_PORT=8444
ExecStart=/usr/local/bin/bun /opt/ainep/dist/ainep.js connect
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
UMask=0077

[Install]
WantedBy=multi-user.target
```

Проверь конфигурацию и запусти:

```sh
sudo systemd-analyze verify \
  /etc/systemd/system/ainep-api.service \
  /etc/systemd/system/ainep-connect.service
sudo systemctl daemon-reload
sudo systemctl enable --now ainep-api ainep-connect
sudo systemctl status ainep-api ainep-connect --no-pager
```

Оба сервиса должны быть active (running). Журналы:

```sh
sudo journalctl -u ainep-api -u ainep-connect -n 100 --no-pager
```

В конфигурации сервиса каталог проекта доступен только для чтения. Установка зависимостей и сборка выполняются отдельно от работающего сервиса.

## 8. Проверить доступ с Mac

API без credentials:

```sh
curl --noproxy '*' -i \
  -X POST \
  https://gateway.example.com:8443/claude/v1/messages \
  -H 'Content-Type: application/json' \
  --data '{}'
```

Ожидается HTTP 401. Это подтверждает TLS, доступность маршрута и обязательность авторизации; обращение к Anthropic этим не проверяется.

CONNECT без credentials:

```sh
curl --noproxy '' \
  --proxy https://gateway.example.com:8444 \
  --head https://claude.ai/
```

Ожидается отказ CONNECT с HTTP 407; curl может завершиться с ненулевым кодом. Это проверка HTTPS до прокси и обязательности авторизации, а не успешного туннеля. Если сборка curl не поддерживает HTTPS proxy, используй сборку с такой поддержкой.

При ошибке TLS проверь домен, цепочку, срок действия сертификата и системное время. Не используй `-k`, `--proxy-insecure` или `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## 9. Настроить Mac

Проверь наличие Bun и штатного Claude Code:

```sh
bun --version
command -v claude
```

Если Bun отсутствует, установи его официальным установщиком и открой новый терминал. Штатный Claude Code должен быть установлен отдельно и доступен в PATH. Launcher использует клиентскую авторизацию; он не извлекает токен из Keychain и не выполняет вход за пользователя.

Собери локальный ainep:

```sh
cd /Users/aleksey/projects/ainep
bun install --frozen-lockfile
bun run check
bun test
bun run build
```

Создай файл конфигурации:

```sh
mkdir -p "$HOME/.config/ainep"
chmod 700 "$HOME/.config/ainep"
touch "$HOME/.config/ainep/client.env"
chmod 600 "$HOME/.config/ainep/client.env"
nano "$HOME/.config/ainep/client.env"
```

```dotenv
GATEWAY_URL=https://gateway.example.com:8443
CONNECT_PROXY_URL=https://gateway.example.com:8444
GATEWAY_TOKEN=REPLACE_WITH_SAME_SERVER_HEX_TOKEN
```

Укажи свой домен и тот же ключ, что на VPS. Оба URL — origin без `/claude`, credentials, query и fragment. HTTPS обязателен вне loopback.

Добавь функцию в `~/.zshrc`:

```sh
ainep() (
  set -a
  . "$HOME/.config/ainep/client.env" || exit 1
  set +a

  bun /Users/aleksey/projects/ainep/dist/ainep.js "$@"
)
```

Примени:

```sh
source "$HOME/.zshrc"
ainep --version
ainep --help
```

Функция загружает доверенный локальный файл как shell-код внутри отдельного процесса shell. Не вставляй в него команды из непроверенных источников. Значения не экспортируются в текущий терминал. Имя штатной команды `claude` не меняется.

## 10. Использовать Claude Code

Из каталога своего проекта:

```sh
ainep run claude
```

Продолжить диалог:

```sh
ainep run claude --resume
```

Все аргументы после `claude` передаются штатному клиенту. Launcher сохраняет рабочий каталог и терминал, передаёт SIGINT/SIGTERM/SIGHUP и код завершения. Он не запускает API или CONNECT на VPS.

Только для дочернего процесса launcher формирует:

- `ANTHROPIC_BASE_URL` с `/claude`.
- `ANTHROPIC_CUSTOM_HEADERS` с ключом шлюза, заменяя прежние custom headers.
- Обе формы регистра HTTP_PROXY/HTTPS_PROXY/ALL_PROXY с Basic credentials CONNECT.
- Обе формы NO_PROXY с hostname API-шлюза и loopback.

Остальное окружение, включая настройки авторизации Claude, наследуется. Наличие унаследованных OAuth credentials не означает, что их действительность проверена ainep.

Первый реальный прогон выполни в пустом каталоге с коротким сообщением. Успешный ответ подтвердит путь сообщений для этого сценария. Затем отдельно проверь продолжение диалога. Успешную ротацию OAuth и первый вход необходимо подтвердить отдельно: локальные mock-тесты этого не доказывают.

Браузерное окно входа не получает proxy env launcher автоматически. Не включай полный запрет прямой сети на Mac до решения маршрутов login/refresh. Не запускай реальный аккаунт через audit-команду как замену обычной проверке: стенд предназначен для искусственных credentials и изолированных сценариев.

## 11. Разобраться с ошибками

| Результат | Что проверить |
| --- | --- |
| API 401 | Совпадение ключа шлюза, затем действительность клиентского OAuth; 401 может прийти от upstream |
| API 400 | Формат запроса, API version, неизвестные поля или неподдерживаемые блоки |
| API 404 | Префикс `/claude` и точный маршрут |
| API 413 | Лимит тела 16 MiB до и после распаковки |
| API 415 | Content-Type или неподдерживаемое Content-Encoding |
| CONNECT 407 | Ключ CONNECT и наличие Proxy-Authorization |
| CONNECT 403 | Хост или порт назначения отсутствует в фиксированном списке |
| 502 | Доступность upstream и журнал соответствующего сервиса |
| Ошибка сертификата | Домен, цепочка сертификата, срок действия, время и доступность TLS listener |
| Отказ сетевого инструмента или MCP | Его назначение может быть запрещено CONNECT-прокси |
| SSE оборвался | Сеть, deadline 10 минут, idle timeout или перезапуск сервиса |

CONNECT разрешает только `platform.claude.com:443`, `claude.ai:443` и `claude.com:443`. Прямой `api.anthropic.com` через CONNECT запрещён. Не расширяй NO_PROXY на Anthropic для обхода ошибки: сначала выясни требуемый маршрут.

API поддерживает только POST `/claude/v1/messages` и `/claude/v1/messages/count_tokens`. Неизвестные протокольные поля отклоняются до отправки upstream. Document-блоки, server tools и все beta-возможности не поддерживаются автоматически. Подробности — в [README](../README.md).

В журналы ainep не должны попадать тела, токены и произвольные заголовки. Не включай дамп окружения и не публикуй вывод диагностики клиента без проверки на секреты.

## 12. Обслуживать сервисы

Статус и текущие журналы на VPS:

```sh
sudo systemctl status ainep-api ainep-connect --no-pager
sudo journalctl -u ainep-api -u ainep-connect -f
```

Перезапуск:

```sh
sudo systemctl restart ainep-api ainep-connect
```

Остановка:

```sh
sudo systemctl stop ainep-api ainep-connect
```

Запуск:

```sh
sudo systemctl start ainep-api ainep-connect
```

Отключение автозапуска и остановка:

```sh
sudo systemctl disable --now ainep-api ainep-connect
```

Для обновления сначала сохрани предыдущий рабочий каталог приложения для отката. Повтори передачу текущих исходников и обнови `/opt/ainep` при остановленных сервисах. Выполни установку с frozen lockfile, check, test и build, затем запусти оба сервиса и повтори проверки из раздела 8. Такой способ предполагает простой; автоматический релиз и развёртывание без простоя здесь не настроены.

Для отката восстанови предыдущий комплект исходников, lockfile, зависимостей и сборки, затем запусти сервисы. Одна замена `dist/ainep.js` не гарантирует совместимость зависимостей.

Для смены ключа обнови `/etc/ainep/server.env`, перезапусти оба сервиса и обнови ключ на каждом Mac. Существующие CONNECT-туннели прервутся при перезапуске. Изменение env-файла не требует daemon-reload; изменение unit-файлов требует.

## Источники и ограничения

- [Действующие решения проекта](decisions.md).
- [Интерфейс CLI и поддерживаемые функции](../README.md).
- [Методика изолированной проверки клиента](oauth-audit.md).
- [Проверка CONNECT с искусственными credentials](connect-audit.md).
- [Установка Bun](https://bun.sh/docs/installation).
- [Установка зависимостей Bun](https://bun.sh/docs/pm/cli/install).
- [systemd service](https://www.freedesktop.org/software/systemd/man/255/systemd.service.html).
- [Certbot standalone и renewal hooks](https://github.com/certbot/certbot/blob/main/certbot/docs/using.rst).

Документ описывает ручную процедуру. Создание этого файла не означает, что VPS, сертификаты, firewall или реальный аккаунт уже настроены и проверены.
