# Админ-панель Five-130TG (v0.003+)

Дата: 2026/07/21  
Связано: [`VALKEY_DATA_MODEL.md`](VALKEY_DATA_MODEL.md), [`PORTAL_PREMIUM_POINTS.md`](PORTAL_PREMIUM_POINTS.md)

## 1. Назначение

Панель администратора в Mini App (`tg.html`): список игроков, ручная правка красных/синих баллов, премиум, назначение админов.

Кнопка **Админ** (жёлтая) видна только пользователям с ролью админа.

## 2. Владелец и админы

| Роль | Кто | Права |
|------|-----|--------|
| **Владелец** | `@bk1804`, Telegram id `545375021` (`server.owner.telegram_id`) | Полные права: **назначать и снимать** админов; выдача/снятие премиума; красные и синие баллы **любому** telegram id (в т.ч. ещё не заходившему — профиль создаётся) |
| **Админ** | id из `portal:admins` (+ seed из `server.admin.telegram_ids`) | Баллы (в т.ч. новому id), **выдача** премиума, **назначение** других админов |
| **Админ** (ограничение) | — | **Не может** снять статус админа; **не может** снять премиум |
| **Игрок** | остальные в `portal:users` | Нет доступа к панели |

Владельца нельзя понизить до игрока (ни через UI, ни через RPC).

### Матрица операций

| Операция | Владелец | Другой админ |
|----------|----------|--------------|
| Список игроков | да | да |
| `admin.wallet_set` красные/синие (существующий или новый id) | да | да |
| Выдать премиум (`five130=1`) | да | да |
| Снять премиум (`five130=0`) | да | **нет** → `owner_required` |
| **Назначить** админа (`role=admin`) | да | да |
| **Снять** админа (`role=player`) | да | **нет** → `owner_required` |

## 3. Регистрация игроков (без дубликатов)

При входе в Mini App клиент вызывает `user.touch` (имя, `@username`, telegram id).

Сервер:

1. `SADD portal:users {telegram_id}` — Redis/Valkey SET → повторный вход **не создаёт** вторую запись.
2. Обновляет HASH `portal:user:{id}` (`display_name`, `username_tg`, `updated_at`, …).
3. При первом появлении создаёт `portal:wallet:{id}` с `red=0`, `blue=0`.
4. В ответе: `created=1` (новый) или `created=0` (уже был), плюс `role`, `is_admin`, `is_owner`.

Дополнительно игроки попадают в SET при сохранении партии (`match.save_snap` / `save_full`) — тоже через `SADD` (идемпотентно).

## 4. Ключи Valkey

```
{prefix}portal:users              SET   telegram_id всех, кто заходил
{prefix}portal:admins             SET   telegram_id админов (владелец всегда)
{prefix}portal:user:{id}          HASH  профиль, role=player|admin
{prefix}portal:wallet:{id}        HASH  red, blue
{prefix}portal:premium:{id}       HASH  five130, five130_until
```

Cfg (демону):

```
server.owner.telegram_id=545375021
server.admin.telegram_ids=545375021
```

Seed-админы из cfg при старте операций копируются в `portal:admins`. Динамические админы живут только в SET + `role` в HASH.

## 5. RPC

| cmd | Кто | Описание |
|-----|-----|----------|
| `user.touch` | любой TG user | регистрация/обновление профиля |
| `admin.users_list` | админ | тело: `id\|display\|username\|red\|blue\|premium\|role\|is_owner` |
| `admin.wallet_set` | админ / владелец | `red`, `blue`; если user ещё не был — `touch` + запись в `portal:users` |
| `admin.premium_set` / `premium.set` | админ; снятие — только владелец | `five130` / `active` |
| `admin.role_set` | админ (**назначить**); снять — только владелец | `role=admin\|player` |

Поле `fields.admin` = telegram id вызывающего (обязательно для admin.*).

## 6. UI (Mini App)

- Жёлтая кнопка **Админ** в ряду действий.
- Блок **«Игрок по id»**: ввести telegram id (даже если ещё не заходил) → красные/синие → «Начислить»; опционально сразу «Сделать админом».
- Список игроков → выбор → красные, синие, премиум, флаг «Админ».
- Чекбокс «Админ»: владелец и админы **назначают**; **снять** может только владелец; у строки владельца — только просмотр роли.
- Чекбокс «Премиум»: снять может только владелец; выдать — любой админ.

## 7. Клиент

`Five130MatchStore`:

- `touchUser()` — при загрузке cfg / входе;
- `isAdmin()` / `isOwner()` — по ответу `user.touch` и seed cfg;
- `adminRoleSet(userId, role)`.
