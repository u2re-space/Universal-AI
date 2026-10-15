# Чаты, Telegram и Decisions API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать агенту, CLI, HTTP и WebSocket один слой для решений, модерации чатов и черновиков ответов, плюс адаптер Telegram Bot API.

**Architecture:** `POST /v1/decisions` (модель по умолчанию `openai/gpt-6-luna-decisions`) возвращает вероятности. Модерация в режиме `auto` сначала пробует `POST /v1/moderations` с `omni-moderation-latest` и при 404/405/501 переходит на decisions. Telegram ходит в Bot API через `node:https`. Сервер каналов слушает только localhost, пока не задан `channels.token`.

**Tech Stack:** Node.js 26, ESM, только встроенные модули, существующий `createClient` на `node:https`.

## Global Constraints

- Внешних зависимостей и SDK нет.
- Исходники в `src/` с отступом в 4 пробела и карточкой JSDoc.
- Секреты (токен бота, токен сервера) не печатаются и маскируются в `ai config show`.
- Удаление сообщения в Telegram только при действии `hide` в группе, супергруппе или канале. Личные чаты и сообщения о самоповреждении не удаляются автоматически.
- `tools.channels` по умолчанию выключен. `telegram.reply` по умолчанию выключен.

---

### Task 1: Вопросы и вердикт

**Files:**
- Create: `src/channels/questions.js`
- Create: `src/channels/verdict.js`
- Test: `test/channels.test.js`

Наборы `community`, `support`, `smm`, `guard`, `route`. Типы вопросов: `noul`, `choice`, `score`. Пороги `reviewAt` 0.5 и `blockAt` 0.9 дают `allow`, `review` или `hide`.

### Task 2: Клиент decisions и модерация

**Files:**
- Modify: `src/openai/client.js`
- Create: `src/channels/decide.js`
- Create: `src/channels/moderate.js`

`client.decisions.create` и `client.moderations.create`. `moderateText` реализует режим `auto`.

### Task 3: Ответы и маршрутизация команды

**Files:**
- Create: `src/channels/reply.js`
- Create: `src/channels/handle.js`
- Modify: `src/agent/team.js`
- Modify: `src/core/config-defaults.js`
- Modify: `src/core/config.js`

`agent.route=decisions` спрашивает набор `route` и выбирает encoder или planner. Ошибка API оставляет прежнюю эвристику.

### Task 4: Telegram

**Files:**
- Create: `src/telegram/client.js`
- Create: `src/telegram/update.js`
- Create: `src/telegram/policy.js`
- Create: `src/telegram/poll.js`
- Test: `test/telegram.test.js`

Методы: `getMe`, `getUpdates`, `sendMessage`, `deleteMessage`, `getChat`, `banChatMember`, `restrictChatMember`.

### Task 5: HTTP, WebSocket и инструменты

**Files:**
- Create: `src/channels/dispatch.js`
- Create: `src/channels/server.js`
- Create: `src/channels/tool-handlers.js`
- Modify: `src/agent/tool-specs.js`
- Modify: `src/agent/tools.js`
- Modify: `src/cli.js`
- Modify: `src/cli-help.js`
- Create: `src/commands/channels.js`

`POST /v1/decisions`, `/v1/moderate`, `/v1/chats/reply`, `/v1/telegram/webhook`, WebSocket `/v1/channels`. Команды: `ai decide`, `ai moderate`, `ai channels --listen`, `ai telegram poll|send`. Инструменты: `decide`, `moderate_text`, `channel_reply`, `telegram_call`.
