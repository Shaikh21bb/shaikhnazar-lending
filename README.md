# SHAIKH Industries — Sales Agent v1

Один облачный Sales Agent отвечает клиентам 24/7, использует базу знаний компании, помнит диалог, создаёт follow-up в существующем календаре и умеет передавать клиента человеку. Архитектура разделяет движок агента, LLM и каналы, поэтому позже можно добавить другие типы агентов без переписывания Telegram/WhatsApp интеграций.

## Что уже работает

- Telegram использует общий серверный Sales Agent вместо отдельного prompt-кода.
- OpenAI Responses API или Gemini выбираются через серверные env-переменные.
- История сохраняется в `agent_chats`, состояние клиента и handoff — в `customers`.
- Инструмент `create_followup` добавляет задачу в существующий календарь.
- `/api/followups/run` отправляет наступившие follow-up и помечает их выполненными.
- Инструмент `handoff_to_human` выключает автоответы для клиента и создаёт задачу менеджеру.
- Глобальный AI ON/OFF и ручной возврат клиента от человека к AI доступны в текущем интерфейсе.
- WhatsApp Cloud API подготовлен через `/api/webhooks/whatsapp`.
- `/api/sales/simulate` тестирует тот же движок локально без Telegram/WhatsApp.

## Установка

1. Для новой базы выполните `supabase-migration-7.sql`, затем `supabase-migration-8-sales-agent.sql`. В существующем проекте Shaikh.digital миграция 8 уже применена; повторно запускать полную схему 7 не нужно.
2. Скопируйте `.env.example` в `.env.local` и заполните Supabase и один LLM provider.
3. Запустите проект через Vercel CLI или любой совместимый с Vercel Functions локальный runtime.
4. В панели создайте один агент типа WhatsApp или Telegram и привяжите к нему проект с базой знаний.

Минимум для LLM:

```env
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
LLM_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-6-luna
OPENAI_REASONING_EFFORT=low
BUSINESS_TIMEZONE=Asia/Almaty
AUTH_SECRET=replace-with-at-least-32-random-characters
```

Ключ LLM используется только в `api/` и никогда не отправляется во frontend.
API-вызовы OpenAI оплачиваются отдельно; бесплатный тариф для `gpt-6-luna` не заявлен. При необходимости можно выбрать Gemini через env, не меняя код агента.

## Локальная проверка без мессенджера

После создания Sales Agent в Supabase:

```bash
curl -X POST http://localhost:3000/api/sales/simulate \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"demo-1","customerName":"Айгуль","message":"Сколько стоит ваш продукт?"}'
```

Можно продолжать писать с тем же `customerId`: история сохранится. Для production endpoint выключен, если явно не задано `SALES_AGENT_DEV_MODE=true`.

## Настройка реального WhatsApp

Нужны Meta Business / Developer App и WhatsApp Cloud API:

1. Получите permanent access token и Phone Number ID.
2. Добавьте env из секции `WHATSAPP_*` в `.env.example`.
3. В Meta укажите callback URL `https://ВАШ-ДОМЕН/api/webhooks/whatsapp` и тот же `WHATSAPP_VERIFY_TOKEN`.
4. Подпишитесь на событие `messages`.
5. Укажите UUID WhatsApp-агента в `WHATSAPP_AGENT_ID` (необязательно, если он один).
6. Для follow-up позже 24 часов создайте и одобрите в Meta шаблон с одной переменной в body, затем задайте `WHATSAPP_FOLLOWUP_TEMPLATE_NAME` и язык шаблона.

Для входящих webhook проверяется подпись `X-Hub-Signature-256`. Для локальной разработки Meta и платный провайдер не нужны: используйте симулятор.

## Follow-up 24/7

Миграция 9 устанавливает Supabase Cron, который проверяет наступившие follow-up каждые пять минут. Пока секреты не заданы, задание ничего не отправляет. Для включения в Supabase Vault создайте `sales_agent_followup_url` со значением `https://shaikh.digital/api/followups/run` и `sales_agent_cron_secret` со значением того же `CRON_SECRET`, который настроен в Vercel. Секреты не записывайте в Git.

Vercel Hobby поддерживает расписания не чаще одного раза в сутки, поэтому частые follow-up вынесены в Supabase Cron. Endpoint принимает:

```text
Authorization: Bearer <CRON_SECRET>
```

## Важное про текущую авторизацию

Существующий проект использует собственную таблицу `managers_auth`, хранит пароль в открытом виде и разрешает публичные RLS-операции из браузера. В v1 вход и новые опасные серверные действия дополнительно защищены подписанной HttpOnly-сессией (`AUTH_SECRET`), а LLM/Meta secrets никогда не попадают во frontend. Перед полноценным production-запуском кабинета всё равно нужно заменить legacy-авторизацию на Supabase Auth, пароли — захешировать, а публичные политики — закрыть. Это отдельная миграция, потому что мгновенное закрытие текущих политик сломает существующий интерфейс.

## Проверки

```bash
npm test
npm run check
```
