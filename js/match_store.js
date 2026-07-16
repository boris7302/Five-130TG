/**
 * MatchStore: IndexedDB, значения — текст ключ=значение.
 * API: ownerId, listMatches, loadMatch, saveMatch, deleteMatch, exportMatchTxt
 */
(function (global) {
  'use strict';

  const DB_NAME = 'five130_kv';
  const DB_VERSION = 1;
  const STORE = 'kv';

  function openDb() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbSet(key, value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbDelete(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function ownerId() {
    try {
      const tw = global.Telegram && global.Telegram.WebApp;
      const u = tw && tw.initDataUnsafe && tw.initDataUnsafe.user;
      if (u && u.id != null) return String(u.id);
    } catch (e) {}
    return 'guest';
  }

  function indexKey(owner) { return 'idx:' + owner; }
  function matchKey(owner, matchId) { return 'match:' + owner + ':' + matchId; }

  async function listMatches() {
    const owner = ownerId();
    const text = await idbGet(indexKey(owner));
    if (!text) {
      return { owner: owner, items: [] };
    }
    return global.Five130Kv.parseIndexDocument(text);
  }

  async function loadMatch(matchId) {
    const owner = ownerId();
    const text = await idbGet(matchKey(owner, matchId));
    return text || null;
  }

  async function saveMatch(matchId, matchText, meta) {
    const Kv = global.Five130Kv;
    const owner = ownerId();
    meta = meta || {};
    await idbSet(matchKey(owner, matchId), matchText);

    const idx = await listMatches();
    const item = {
      id: matchId,
      started: meta.started || Kv.getKv(Kv.parseDocument(matchText), 'started', { meta: true }) || Kv.timestampNow(),
      game_type: meta.game_type || Kv.getKv(Kv.parseDocument(matchText), 'game_type', { meta: true }) || 'five130',
      final_score: meta.final_score || Kv.getKv(Kv.parseDocument(matchText), 'final_score', { meta: true }) || '0,0',
      result: meta.result || 'unknown',
    };
    const items = idx.items.filter(function (x) { return x.id !== matchId; });
    items.unshift(item);
    const doc = Kv.buildIndexDocument(owner, items, Kv.timestampNow());
    await idbSet(indexKey(owner), doc);
    return { ok: true, owner: owner, match_id: matchId };
  }

  async function deleteMatch(matchId) {
    const Kv = global.Five130Kv;
    const owner = ownerId();
    await idbDelete(matchKey(owner, matchId));
    const idx = await listMatches();
    const items = idx.items.filter(function (x) { return x.id !== matchId; });
    await idbSet(indexKey(owner), Kv.buildIndexDocument(owner, items, Kv.timestampNow()));
    return { ok: true };
  }

  async function exportMatchTxt(matchId) {
    const text = await loadMatch(matchId);
    if (!text) return null;
    const started = global.Five130Kv.getKv(
      global.Five130Kv.parseDocument(text), 'started', { meta: true }
    ) || '';
    const stamp = started.replace(/[\/:\s]/g, '').slice(0, 15) || 'export';
    return {
      filename: 'match_' + stamp + '.txt',
      text: text,
    };
  }

  /** Сохранить stub-партию из текущего UI (до подключения движка). */
  async function saveStubFromUi(fields) {
    const Kv = global.Five130Kv;
    const owner = ownerId();
    const matchId = fields && fields.match_id ? fields.match_id : Kv.matchIdNow();
    const text = Kv.buildStubMatchText(Object.assign({
      owner: owner,
      match_id: matchId,
      client: 'tg-html',
    }, fields || {}));
    const score = (fields && fields.final_score) || '0,0';
    const parts = score.split(',');
    const h = parseInt(parts[0], 10) || 0;
    const a = parseInt(parts[1], 10) || 0;
    let result = 'unknown';
    if ((fields && fields.match_draw) === '1' || (fields && fields.match_draw) === 1) result = 'draw';
    else if ((fields && String(fields.match_winner)) === '0') result = 'win';
    else if ((fields && String(fields.match_winner)) === '1') result = 'lose';
    else if (h > a) result = 'win';
    else if (a > h) result = 'lose';
    await saveMatch(matchId, text, {
      started: fields && fields.started,
      game_type: fields && fields.game_type,
      final_score: score,
      result: result,
    });
    return { match_id: matchId, text: text };
  }


  function debugKey(owner) { return 'debug:' + owner + ':last'; }

  /**
   * Сохранить последний отладочный дамп партии (KV-текст) в IndexedDB.
   * Это локальная копия на устройстве — не публичная HTTP-ссылка.
   * @param {string} text Дамп Five130TG-Debug/1
   * @return {Promise<{owner:string, key:string}>}
   */
  async function saveDebugDump(text) {
    const owner = ownerId();
    const key = debugKey(owner);
    const stamped = '# saved=' + (new Date()).toISOString() + '\n' + String(text || '');
    await idbSet(key, stamped);
    return { owner: owner, key: key };
  }

  /** @return {Promise<string|null>} последний debug-дамп или null */
  async function loadDebugDump() {
    const owner = ownerId();
    const text = await idbGet(debugKey(owner));
    return text || null;
  }

  /** Скачать последний debug из MatchStore как .txt */
  async function exportDebugTxt() {
    const text = await loadDebugDump();
    if (!text) return null;
    return {
      filename: 'five130tg_debug_last.txt',
      text: text,
    };
  }

  global.Five130MatchStore = {
    ownerId: ownerId,
    listMatches: listMatches,
    loadMatch: loadMatch,
    saveMatch: saveMatch,
    deleteMatch: deleteMatch,
    exportMatchTxt: exportMatchTxt,
    saveStubFromUi: saveStubFromUi,
    saveDebugDump: saveDebugDump,
    loadDebugDump: loadDebugDump,
    exportDebugTxt: exportDebugTxt,
    _keys: { indexKey: indexKey, matchKey: matchKey, debugKey: debugKey },
  };
})(typeof window !== 'undefined' ? window : globalThis);
