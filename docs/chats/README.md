# Архив переписки (Five-130TG)

## Линия 0.001 (закрыта)

| Файл | Содержание |
|------|------------|
| `user_comments_part_0001tg.txt` | Замечания v0.001 (п.1–9) |
| `chat_transcript_part_0001tg.txt` | Выгрузка user-реплик (часть 1) |
| `user_comments_part_0002tg.txt` | UI polish (часть 2) |
| `chat_transcript_part_0002tg.txt` | Выжимка (часть 2) |

Freeze: [`../releases/v0.001_FREEZE.md`](../releases/v0.001_FREEZE.md) (rev.#043).

## Линия 0.002 (открыта)

| Файл | Содержание |
|------|------------|
| `session_log_v0.002.txt` | **Журнал сеансов** с метками времени |

Старт: [`../releases/v0.002_OPEN.md`](../releases/v0.002_OPEN.md).

### Формат журнала сеансов (обязательно с 0.002)

После **каждого** сеанса вопрос–ответ дописывать в `session_log_v0.002.txt`:

```
--- сеанс N ---
USER       YYYY/MM/DD HH:MM:SS
<текст пользователя>

ASSISTANT  YYYY/MM/DD HH:MM:SS
<краткое резюме ответа / что сделано>
```

- Время — **локальное** (UTC+3), формат строго **`YYYY/MM/DD HH:MM:SS`**.
- Один блок = один обмен (user → assistant).
- При закрытии 0.002 — итоговый `user_comments_part_0003tg.txt` по аналогии с 0001/0002.
