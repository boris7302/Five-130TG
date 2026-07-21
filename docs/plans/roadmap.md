# Roadmap Five-130TG

| Версия | Статус | Фокус |
|--------|--------|--------|
| 0.001 | **ЗАКРЫТА** (2026-07-16, rev.#043) | HTML Mini App, UI appearance, Help |
| **0.002** | **ОТКРЫТА** (2026-07-16, rev.#045+) | Сервер; PvP; **премиум-аналитика**; каркас **баллов портала** |
| **0.003** | **ОТКРЫТА** (2026-07-21) | Админ-панель, баллы, премиум; см. [`ADMIN_PANEL.md`](ADMIN_PANEL.md) |
| 0.004 | план | CloudStorage; рефералы → синие баллы; платежи → красные |
| 0.010 | план | Flutter Web UI; другие игры портала на общих баллах |

## Принятые продуктовые решения (2026-07-21)

См. **[`PORTAL_PREMIUM_POINTS.md`](PORTAL_PREMIUM_POINTS.md)**:

1. Сервер(а) с бэкапами.  
2. Премиум Five-130TG: очки за ходы, скрытые кости 0–6, дефицит, угроза базара, hover-подсказки.  
3. Баллы портала (покупка премиума, подарки, другие игры, приоритет к разработчикам).  
4. Красные (покупные) и синие (наградные) баллы; админ- и игрок-панели.

## Сервер (2026-07-21)

- Путь **с сервером** — основной; **без сервера — на стоп**.
- Valkey + C++ демон `five130d`: [`SERVER_VALKEY_CPP.md`](SERVER_VALKEY_CPP.md), код в `server/`.

## Ссылки

- Freeze 0.001: [`../releases/v0.001_FREEZE.md`](../releases/v0.001_FREEZE.md)
- Open 0.002: [`../releases/v0.002_OPEN.md`](../releases/v0.002_OPEN.md)
- План 0.002: [`v0.002_plan.md`](v0.002_plan.md)
- PvP: [`v0.002_pvp_telegram.md`](v0.002_pvp_telegram.md)
- Портал / премиум / баллы: [`PORTAL_PREMIUM_POINTS.md`](PORTAL_PREMIUM_POINTS.md)
- Сервер Valkey/C++: [`SERVER_VALKEY_CPP.md`](SERVER_VALKEY_CPP.md)
- Модель данных Valkey: [`VALKEY_DATA_MODEL.md`](VALKEY_DATA_MODEL.md)
