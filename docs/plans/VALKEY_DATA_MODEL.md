# Модель данных Valkey/Redis ↔ five130d ↔ портал

**Статус:** ЧЕРНОВИК к обсуждению (2026-07-21)  
**Связь:** [`SERVER_VALKEY_CPP.md`](SERVER_VALKEY_CPP.md), [`PORTAL_PREMIUM_POINTS.md`](PORTAL_PREMIUM_POINTS.md)

---

## 0. Роль прослойки

| Слой | Ответственность |
|------|-----------------|
| **Mini App / бот** | UI; шлёт команды (очередь `cmd`) или читает кэш через API-обёртку |
| **five130d** | Валидация, бизнес-правила, маппинг структур ↔ ключи Valkey, аудит |
| **Valkey/Redis** | Быстрый KV: HASH/STRING/ZSET/LIST; **не** единственный долговременный склад без бэкапа |
| **Позже: SQL** | Истина по деньгам/аудиту (PostgreSQL/SQLite); Valkey — кэш + очереди + лидерборды месяца |

Сейчас эмулируем **портальные структуры в Valkey** (localhost). Позже зеркалируем в SQL.

Префикс ключей: `server.valkey.prefix` → по умолчанию `five130tg:`  
Ниже для ясности пишем логические имена; в коде: `prefix + "portal:user:" + id`.

---

## 1. Игры портала (каталог)

| `game_id` | Название | В Telegram сейчас |
|-----------|----------|-------------------|
| `gomoku` | GomokuTG | нет |
| `renju` | RenjuTG | нет |
| `five125` | Five125+TG | нет |
| `five130` | Five130TG | **да** |
| `drondefense` | DronDefenseTG | нет |

Ключ каталога (HASH):

```
portal:games
  gomoku       = 1
  renju        = 1
  five125      = 1
  five130      = 1
  drondefense  = 1
```

---

## 2. Пользователь портала

### 2.1. Auth: Telegram vs email/пароль

| Канал | Идентификатор | Пароль | Email |
|-------|---------------|--------|-------|
| **Telegram Mini App** (основной сейчас) | `telegram_id` (обязателен) | **не нужен** — доверие к `initData` | опционально (уведомления, связка) |
| **Веб-портал позже** | `email` или `login` | **нужен** (только hash, argon2/bcrypt) | обязателен для логина без TG |

**Рекомендация:** один `user_id` (UUID/ULID); при первом входе из TG создаём профиль без пароля; email/пароль — отдельная привязка (`link_email`), не дублируем аккаунты.

### 2.2. HASH `portal:user:{user_id}`

| Поле | Тип (логич.) | Описание |
|------|--------------|----------|
| `user_id` | string | PK |
| `display_name` | string | Имя в UI (из TG `first_name` / вручную) |
| `telegram_id` | string | пусто, если только веб |
| `username_tg` | string | `@nick`, опционально |
| `email` | string | опционально |
| `password_hash` | string | пусто для TG-only |
| `created_at` | unix | |
| `updated_at` | unix | |
| `status` | enum | `active` / `banned` / `deleted` |
| `locale` | string | `ru` / `en` |
| `role` | enum | `player` / `admin` |

Индексы / множества:

```
portal:users                    SET   telegram_id (SADD — без дубликатов при повторном входе)
portal:admins                   SET   telegram_id админов (владелец всегда; см. ADMIN_PANEL.md)
portal:idx:tg:{telegram_id}     → user_id
portal:idx:email:{email_norm}   → user_id
```

Иерархия админов и RPC: [`ADMIN_PANEL.md`](ADMIN_PANEL.md).

### 2.3. Баллы — HASH `portal:wallet:{user_id}`

| Поле | Описание |
|------|----------|
| `red` | красные (покупные), целое ≥ 0 |
| `blue` | синие (наградные), целое ≥ 0 |
| `updated_at` | unix |

Движения — LIST или отдельный поток аудита (не только баланс):

```
portal:ledger:{user_id}   LIST  → JSON/KV строк: ts,kind,delta_red,delta_blue,reason,ref
```

`kind`: `purchase` | `reward` | `spend_premium` | `gift_in` | `gift_out` | `admin_adjust` | `payout` | …

### 2.4. Премиум по играм — HASH `portal:premium:{user_id}`

Поле на игру (или вложенный JSON; для Redis удобнее плоские поля):

| Поле | Пример | Описание |
|------|--------|----------|
| `five130` | `0` / `1` | флаг «есть премиум сейчас» |
| `five130_until` | unix или `0` | срок; `0` = нет |
| `renju` / `renju_until` | … | то же |
| `gomoku` / `gomoku_until` | … | |
| `five125` / `five125_until` | … | |
| `drondefense` / `drondefense_until` | … | |

Альтернатива: ключ на игру `portal:premium:{user_id}:{game_id}` с полями `active`, `until` — проще TTL-логика.

---

## 3. Прайс-лист и require-лист

### 3.1. Прайс (что купить / сколько стоит) — HASH `portal:price:{sku}`

| Поле | Описание |
|------|----------|
| `sku` | код товара, напр. `premium.five130.30d` |
| `title` | «Премиум Five130TG 30 дней» |
| `game_id` | `five130` или `*` (портал) |
| `currency` | `red` / `blue` / `either` (приоритет списания — правило) |
| `cost` | целое |
| `effect` | `premium_days` / `gift_pack` / … |
| `effect_value` | число (дни, шт.) |
| `enabled` | `0`/`1` |

Каталог SKU: SET `portal:price:index` → члены `sku`.

### 3.2. Require / reward (за что начисляют) — HASH `portal:require:{rule_id}`

| Поле | Описание |
|------|----------|
| `rule_id` | напр. `win.triathlon.renju_five130_dron` |
| `title` | «Победа в троеборье Renju+Five130+DronDefense» |
| `games` | CSV `renju,five130,drondefense` |
| `condition` | `win_all` / `record_month` / `referral_n` / … |
| `condition_param` | JSON/KV (порог рекорда, N рефералов) |
| `reward_currency` | `blue` / `red` |
| `reward_amount` | целое |
| `enabled` | `0`/`1` |
| `period` | `once` / `monthly` / `always` |

Индекс: SET `portal:require:index`.

### 3.3. Вывод синих в деньги — **ПРИНЯТО (предварительно, 2026-07-21)**

| Вариант | Суть | Статус |
|---------|------|--------|
| **A. Нет вывода** | Синие только внутри портала (премиум, подарки, статус) | **основной режим** |
| **B. Ручной вывод** | Заявка → админ → перевод | **задел** (поля/очередь; UI админа позже) |
| **C. Авто-порог** | Автовывод по курсу | не сейчас |
| **D. Мерч/благодарность** | Не кэш | не сейчас |

Политика v0 (может измениться):

```
portal:payout:policy
  enabled=0          # публичный вывод выключен (режим A)
  mode=manual        # задел под B
  min_blue=0
  rate_rub=0
```

```
portal:payout:queue      LIST  заявки (пусто, пока enabled=0)
```

В ledger допускаем `kind=payout_request` / `payout_done` / `payout_reject` для будущего B.  
Автовывод (C) и курс — отдельное решение, не в текущем scope.

---

## 4. Ежемесячная таблица рекордов

ZSET на игру и месяц (`YYYY-MM`):

```
portal:records:{yyyy-mm}:{game_id}
  member = user_id   (или user_id:match_id при нескольких попытках)
  score  = значение рекорда (см. метрику ниже)
```

Мета HASH `portal:records:meta:{yyyy-mm}:{game_id}`:

| Поле | Описание |
|------|----------|
| `metric` | имя метрики |
| `higher_better` | `1`/`0` |
| `updated_at` | unix |

### 4.1. Метрики — **ПРИНЯТО предварительно (может измениться)**

| `game_id` | `metric` | `higher_better` | Смысл |
|-----------|----------|-----------------|-------|
| `five130` | `best_match_score` | `1` | Лучший **счёт партии** игрока за месяц (очки Five-130 после окончания партии vs ИИ; при равенстве — более ранний `updated_at` не поднимает) |
| `renju` / `gomoku` / `five125` / `drondefense` | *TBD* | — | задать при подключении игры |

Топ-N: `ZREVRANGE … 0 99 WITHSCORES`.  
Архив прошлого месяца не удалять (или копировать в SQL).

Для троеборья — отдельный ZSET `portal:records:{yyyy-mm}:triathlon` с составным score или отдельная таблица результатов событий.

---

## 5. Сохранение партий Five130TG (L0 / L1) — **ПРИНЯТО**

Политика (предварительная, как вывод синих):

| Уровень | Кто | Что в Valkey |
|---------|-----|----------------|
| **L0** | любой с `telegram_id` (не `guest`) | мета + **последний снимок** resume (1 current) |
| **L1** | `premium.five130` активен | полный KV MatchStore + индекс истории |
| **Синие** | не открывают облако | только награды/статус |

Гости (`guest`) — только IndexedDB, в Valkey не пишем.

Ключи (после `prefix`):

```
portal:match:snap:{user_id}              STRING  тело снимка (L0), TTL ~14d
portal:match:snap_meta:{user_id}         HASH    match_id, updated_at, game_id
portal:match:body:{user_id}:{match_id}   STRING  полный KV (L1)
portal:match:meta:{user_id}:{match_id}   HASH    game_id, updated_at, mode, scores, premium_full
portal:match:index:{user_id}             ZSET    score=updated_at, member=match_id
portal:premium:{user_id}                 HASH    five130=0|1, five130_until=unix
```

Лимиты старт: L0 — 1 current; L1 — до 50 партий в индексе (вытеснение старых).

PvP relay (отдельно, позже):

```
portal:session:{session_id}     HASH
five130tg:pvp:{match_id}        HASH
```

---

## 6. Протокол команд five130d (расширение v0)

Уже есть: `ping`, `echo`, **`match.*`**, **`premium.get` / `premium.set`**.

| cmd | Назначение |
|-----|------------|
| `match.save_snap` | L0: снимок resume (`user`, `match_id`, тело) |
| `match.save_full` | L1: полный KV; иначе `err=premium_required` |
| `match.get_snap` | L0: текущий снимок |
| `match.get` | L1 тело или snap, если body нет |
| `match.list` | список match_id (индекс L1 + current L0) |
| `match.delete` | удалить body/meta/index (+ snap, если match_id совпал) |
| `premium.get` / `premium.set` | флаг премиума по игре |
| `user.get` / `user.upsert_tg` | профиль (позже) |
| `wallet.get` / `wallet.adjust` | баллы (позже) |
| `price.list` / `require.list` | каталоги (позже) |
| `records.top` / `records.submit` | месяц (позже) |

Тело партии: в очереди Valkey — поле `body_b64` (base64 UTF-8); HTTP `/v0/rpc` — JSON-поле `body` (сырой текст).

---

## 7. Тесты скорости (обязательный трек)

Цель: понять потолок localhost Redis 5 / будущегого Valkey для HASH SET/GET и round-trip через демон.

| Тест | Что меряем |
|------|------------|
| T1 | Прямой `SET`/`GET` / `HSET`/`HGET` через `redis-cli` или hiredis (без демона) |
| T2 | Round-trip `LPUSH cmd` → `BRPOP` → `SET reply` → `GET` (`ping`) |
| T3 | Пачка N=1k/10k `user.upsert` + `wallet.get` через демон |
| T4 | Параллельные клиенты (2–8 процессов) — очередь не должна терять ответы |

Скрипт: `server/scripts/bench_valkey.sh` (черновик).  
Отчёт: `server/run/bench_YYYYMMDD.txt` (gitignore log).

---

## 8. Что ещё сделать (чеклист)

- [x] §3.3 вывод синих: **A + задел B** (предварительно)  
- [x] Метрика рекорда Five130TG: **`best_match_score`** (предварительно)  
- [x] Документация модулей five130d + `doc_structures_five130d.txt`  
- [ ] Бенч T1–T2 на localhost (прогнать и сохранить отчёт)  
- [x] Политика match L0/L1 + команды `match.*` / `premium.*`  
- [ ] Команды `user.*` / `wallet.*` / `records.*` в демоне  
- [ ] UI Mini App: баланс / премиум-бейдж (см. предложение UI)  
- [ ] Зеркало в SQL + бэкапы — после стабилизации схемы  

---

## 9. UI Five130TG — предложение (серверный контур)

Не ломая текущий стол:

1. **Шапка:** бейдж `● Премиум` (если `premium.five130`); мелкий баланс `🔴 n  🔵 m` (тап → панель игрока).  
2. **Панель игрока (модалка):** имя, TG, балансы, срок премиума, кнопка «Как получить баллы».  
3. **Список ходов (премиум):** очки за вариант; hover/long-press — теория ответа (§2 PORTAL).  
4. **Рекорды месяца:** пункт в «Помощь» / отдельная вкладка «Рейтинг» (топ-10).  
5. **Подписи соперника:** везде **ИИ** вместо ПК/компьютер (сделано в коде).  
6. Режим игры: «Против ИИ» / «Два игрока (одно устройство)» / позже «По сети».
