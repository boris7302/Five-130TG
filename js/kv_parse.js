/**
 * Парсер/сборка документов ключ=значение (Five130-MatchFormat).
 * Без JSON.
 */
(function (global) {
  'use strict';

  function parseDocument(text) {
    const lines = String(text || '').split(/\r?\n/);
    const entries = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (!trimmed) {
        entries.push({ type: 'blank', raw: raw });
        continue;
      }
      if (trimmed.startsWith('---') && trimmed.endsWith('---')) {
        entries.push({ type: 'section', name: trimmed.replace(/^-+|-+$/g, ''), raw: raw });
        continue;
      }
      if (trimmed.startsWith('@')) {
        entries.push({ type: 'marker', value: trimmed.slice(1).trim(), raw: raw });
        continue;
      }
      let meta = false;
      let body = trimmed;
      if (body.startsWith('#')) {
        meta = true;
        body = body.slice(1).trim();
      }
      const eq = body.indexOf('=');
      if (eq <= 0) {
        entries.push({ type: 'raw', raw: raw });
        continue;
      }
      const key = body.slice(0, eq).trim();
      let value = body.slice(eq + 1).trim();
      // "0 (human)" → берём значение до скобок как primary при необходимости
      entries.push({ type: 'kv', meta: meta, key: key, value: value, raw: raw });
    }
    return entries;
  }

  function getKv(entries, key, opts) {
    opts = opts || {};
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.type !== 'kv' || e.key !== key) continue;
      if (opts.meta === true && !e.meta) continue;
      if (opts.meta === false && e.meta) continue;
      return e.value;
    }
    return undefined;
  }

  function formatKv(key, value, meta) {
    const line = key + '=' + value;
    return meta ? '# ' + line : line;
  }

  function joinDocument(lines) {
    return lines.join('\n') + (lines.length && !String(lines[lines.length - 1]).endsWith('\n') ? '\n' : '');
  }

  /** Индекс партий → текст Five130-MatchIndex/1 */
  function buildIndexDocument(owner, items, updated) {
    const lines = [
      '# Five130-MatchIndex/1',
      formatKv('owner', owner, true),
      formatKv('updated', updated || timestampNow(), true),
      formatKv('count', String(items.length), false),
    ];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      lines.push(formatKv('id.' + i, it.id, false));
      lines.push(formatKv('started.' + i, it.started || '', false));
      lines.push(formatKv('game_type.' + i, it.game_type || 'five130', false));
      lines.push(formatKv('final_score.' + i, it.final_score || '0,0', false));
      lines.push(formatKv('result.' + i, it.result || 'unknown', false));
    }
    return joinDocument(lines);
  }

  function parseIndexDocument(text) {
    const entries = parseDocument(text);
    const count = parseInt(getKv(entries, 'count') || '0', 10) || 0;
    const owner = getKv(entries, 'owner', { meta: true }) || getKv(entries, 'owner') || 'guest';
    const items = [];
    for (let i = 0; i < count; i++) {
      const id = getKv(entries, 'id.' + i);
      if (!id) continue;
      items.push({
        id: id,
        started: getKv(entries, 'started.' + i) || '',
        game_type: getKv(entries, 'game_type.' + i) || 'five130',
        final_score: getKv(entries, 'final_score.' + i) || '0,0',
        result: getKv(entries, 'result.' + i) || 'unknown',
      });
    }
    return { owner: owner, items: items, entries: entries };
  }

  function timestampNow() {
    const d = new Date();
    const p = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function matchIdNow() {
    const d = new Date();
    const p = function (n) { return n < 10 ? '0' + n : String(n); };
    const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
    return 'm_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '_' + rand;
  }

  /** Минимальный каркас партии (для stub-сохранения из UI). */
  function buildStubMatchText(opts) {
    opts = opts || {};
    const started = opts.started || timestampNow();
    const lines = [
      '# Five130-MatchFormat/1',
      formatKv('app_version', opts.app_version || '0.003', true),
      formatKv('game_type', opts.game_type || 'five130', true),
      formatKv('started', started, true),
      formatKv('target', opts.target || '125', true),
      formatKv('human_player', '0', true),
      formatKv('ai_player', '1', true),
      formatKv('client', opts.client || 'tg-html', true),
      formatKv('owner', opts.owner || 'guest', true),
      formatKv('match_id', opts.match_id, true),
      formatKv('seed', opts.seed || '0', true),
      '',
      '@match end',
      formatKv('finished', timestampNow(), true),
      formatKv('match_over', opts.match_over || '1', true),
      formatKv('match_draw', opts.match_draw || '0', true),
      formatKv('match_winner', opts.match_winner != null ? String(opts.match_winner) : '0', true),
      formatKv('final_score', opts.final_score || '0,0', true),
      formatKv('status', opts.status || 'stub', false),
    ];
    return joinDocument(lines);
  }

  global.Five130Kv = {
    parseDocument: parseDocument,
    getKv: getKv,
    formatKv: formatKv,
    joinDocument: joinDocument,
    buildIndexDocument: buildIndexDocument,
    parseIndexDocument: parseIndexDocument,
    timestampNow: timestampNow,
    matchIdNow: matchIdNow,
    buildStubMatchText: buildStubMatchText,
  };
})(typeof window !== 'undefined' ? window : globalThis);
