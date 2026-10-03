# GTA news monitor

Telegram-бот, который присылает новые публикации с четырёх сайтов:

| Сайт | Откуда берутся новости |
|---|---|
| [Rockstar Newswire](https://www.rockstargames.com/newswire) | GraphQL `graph.rockstargames.com` (тот же запрос, что в маршруте [RSSHub](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/rockstargames/newswire.ts)) |
| [Rockstar Intel](https://rockstarintel.com) | RSS `https://rockstarintel.com/feed` |
| [GTABase](https://www.gtabase.com) | RSS `https://www.gtabase.com/news/?format=feed&type=rss` |
| [GTA BOOM](https://www.gtaboom.com) | RSS `https://www.gtaboom.com/feed` |

Проверка идёт раз в 15 минут через GitHub Actions, сервер не нужен.

## Настройка

1. **Бот.** В Telegram откройте [@BotFather](https://t.me/BotFather) → `/newbot` → получите токен.
2. **chat_id.**
   - *Личка:* напишите своему боту `/start`, затем откройте в браузере
     `https://api.telegram.org/bot<ТОКЕН>/getUpdates` и найдите `"chat":{"id":123456789`.
   - *Канал:* добавьте бота администратором канала, опубликуйте в канале любой пост и откройте ту же ссылку —
     id канала начинается с `-100`.
3. **Репозиторий.** Залейте эту папку в **публичный** репозиторий на GitHub
   (для публичных репозиториев Actions бесплатны без лимита минут).
4. **Секреты.** В репозитории: *Settings → Secrets and variables → Actions → New repository secret*:
   - `TELEGRAM_BOT_TOKEN` — токен из шага 1;
   - `TELEGRAM_CHAT_ID` — id из шага 2.
5. **Первый запуск.** *Actions → GTA news monitor → Run workflow.*
   Первый запуск ничего не присылает: он только запоминает текущие статьи в `state.json`,
   чтобы не завалить чат старыми новостями. Дальше приходят только новые.

## Как это устроено

- `monitor.mjs` — забирает источники, шлёт новое в Telegram, сохраняет `state.json`.
- `lib.mjs` — чистая логика (что новое, сбои, формат сообщений), покрыта тестами.
- `state.json` — какие статьи уже отправлены. Workflow коммитит его после каждой проверки.
- Новое определяется по id статьи, а не по дате: у Rockstar закреплённые посты стоят первыми.
- Если источник не отвечает 3 проверки подряд (~45 мин), придёт одно предупреждение,
  а когда он оживёт — сообщение «снова работает».
- Если Telegram не принял сообщение, неотправленные статьи уйдут при следующей проверке.

## Локально

```bash
npm ci
npm test              # тесты логики
npm run dry-run       # печатает, что было бы отправлено; state.json не меняет
```

Добавить сайт — новая строка в `SOURCES` в `monitor.mjs` (для RSS достаточно ссылки на ленту).

## Что стоит знать

- GitHub запускает расписание с задержкой, иногда 5–30 минут — новость может прийти не сразу.
- GTABase и GTA BOOM стоят за Cloudflare. С домашнего IP они отвечают, а с серверов GitHub
  могут начать требовать проверку — тогда придёт предупреждение из пункта выше.
- В публичном репозитории GitHub отключает расписание после 60 дней без активности.
  Коммиты `state.json` при новых статьях держат репозиторий активным.
