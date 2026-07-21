/**
 * MatchStore: IndexedDB + optional cloud (Valkey via five130d HTTP /v0/rpc).
 * L0: saveCloudSnap for any TG user; L1: saveCloudFull requires premium.five130.
 * API: ownerId, listMatches, loadMatch, saveMatch, deleteMatch, exportMatchTxt,
 *      saveCloudSnap, saveCloudFull, cloudList, configureCloud
 */
(function (global) {
  'use strict';

  const DB_NAME = 'five130_kv';
  const DB_VERSION = 1;
  const STORE = 'kv';

  /** @type {{ url: string, enabled: boolean }} */
  var cloudCfg = { url: '', enabled: false };

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

  /** Parse user object from raw WebApp initData query string. */
  function parseUserFromInitData(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try {
      const params = new URLSearchParams(raw);
      const user = params.get('user');
      if (!user) return null;
      const u = JSON.parse(user);
      if (u && u.id != null) return u;
    } catch (e) {}
    return null;
  }

  function parseUserIdFromInitData(raw) {
    const u = parseUserFromInitData(raw);
    return u && u.id != null ? String(u.id) : null;
  }

  /** Raw tgWebAppData from hash/query (Desktop launch params). */
  function launchInitDataRaw() {
    try {
      const loc = global.location;
      if (!loc) return null;
      const hash = String(loc.hash || '').replace(/^#/, '');
      let raw = null;
      if (hash) {
        const hp = new URLSearchParams(hash);
        raw = hp.get('tgWebAppData');
      }
      if (!raw && loc.search) {
        const qp = new URLSearchParams(loc.search);
        raw = qp.get('tgWebAppData');
      }
      if (!raw) return null;
      try { raw = decodeURIComponent(raw); } catch (e) {}
      return raw;
    } catch (e) {}
    return null;
  }

  /**
   * Telegram user from WebApp / initData / launch URL.
   * @returns {{ id: string, first_name?: string, last_name?: string, username?: string }|null}
   */
  function telegramUser() {
    try {
      const tw = global.Telegram && global.Telegram.WebApp;
      let u = tw && tw.initDataUnsafe && tw.initDataUnsafe.user;
      if (!u && tw && tw.initData) u = parseUserFromInitData(tw.initData);
      if (!u) u = parseUserFromInitData(launchInitDataRaw());
      if (u && u.id != null) {
        return {
          id: String(u.id),
          first_name: u.first_name || '',
          last_name: u.last_name || '',
          username: u.username || '',
        };
      }
    } catch (e) {}
    return null;
  }

  /** Display name for UI: first_name, else @username, else id. */
  function telegramDisplayName() {
    const u = telegramUser();
    if (!u) return null;
    if (u.first_name) {
      return u.last_name ? (u.first_name + ' ' + u.last_name) : u.first_name;
    }
    if (u.username) return '@' + u.username;
    return u.id;
  }

  function ownerId() {
    const u = telegramUser();
    return u ? u.id : 'guest';
  }

  /**
   * Why cloud sees guest — for UI (Desktop Mini App vs reply-keyboard).
   * @returns {{ owner: string, reason: string, platform: string }}
   */
  function ownerDiag() {
    const owner = ownerId();
    let platform = '';
    try {
      const tw = global.Telegram && global.Telegram.WebApp;
      platform = (tw && tw.platform) ? String(tw.platform) : '';
      if (owner !== 'guest') {
        return { owner: owner, reason: 'ok', platform: platform };
      }
      if (!tw) {
        return { owner: 'guest', reason: 'no_webapp', platform: platform };
      }
      const hasInit = !!(tw.initData && String(tw.initData).length);
      const hasUnsafeUser = !!(tw.initDataUnsafe && tw.initDataUnsafe.user);
      if (!hasInit && !hasUnsafeUser && !launchInitDataRaw()) {
        return { owner: 'guest', reason: 'empty_init', platform: platform };
      }
      return { owner: 'guest', reason: 'no_user', platform: platform };
    } catch (e) {
      return { owner: 'guest', reason: 'error', platform: platform };
    }
  }

  function indexKey(owner) { return 'idx:' + owner; }
  function matchKey(owner, matchId) { return 'match:' + owner + ':' + matchId; }

  /**
   * @param {{ url?: string, enabled?: boolean }|string|null} opts
   *   URL five130d HTTP, например http://127.0.0.1:7380
   */
  function configureCloud(opts) {
    if (typeof opts === 'string') {
      cloudCfg.url = opts.replace(/\/$/, '');
      cloudCfg.enabled = !!cloudCfg.url;
      return cloudCfg;
    }
    opts = opts || {};
    if (opts.url != null) cloudCfg.url = String(opts.url).replace(/\/$/, '');
    if (opts.enabled != null) cloudCfg.enabled = !!opts.enabled;
    else cloudCfg.enabled = !!cloudCfg.url;
    return cloudCfg;
  }

  function cloudStatus() {
    return {
      enabled: cloudCfg.enabled && !!cloudCfg.url,
      url: cloudCfg.url,
      owner: ownerId(),
      canCloud: ownerId() !== 'guest',
    };
  }

  function rpc(cmd, fields, body) {
    if (!cloudCfg.enabled || !cloudCfg.url) {
      return Promise.resolve({
        ok: false,
        skipped: true,
        err: 'cloud_disabled',
        reply: '',
      });
    }
    const id = 'js_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    const payload = {
      id: id,
      cmd: cmd,
      fields: fields || {},
      user: (fields && fields.user) || ownerId(),
      match_id: fields && fields.match_id,
    };
    if (body != null) payload.body = String(body);
    return fetch(cloudCfg.url + '/v0/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.json();
    }).then(function (j) {
      const reply = (j && j.reply) || '';
      const ok = reply.indexOf('ok=1') === 0;
      const errMatch = /(?:^|\s)err=([^\s]+)/.exec(reply);
      return {
        ok: ok,
        skipped: false,
        reply: reply,
        err: ok ? null : (errMatch ? errMatch[1] : 'rpc_failed'),
        body: j && j.body,
        premium_required: !ok && errMatch && errMatch[1] === 'premium_required',
      };
    }).catch(function (e) {
      return {
        ok: false,
        skipped: false,
        reply: '',
        err: 'network',
        detail: String(e && e.message ? e.message : e),
      };
    });
  }

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

  /**
   * L0: снимок resume в Valkey (если TG user + cloud URL).
   * @return {Promise<{local:object, cloud:object}>}
   */
  async function saveCloudSnap(matchId, matchText, meta) {
    const local = await saveMatch(matchId, matchText, meta);
    const owner = ownerId();
    if (owner === 'guest') {
      const diag = ownerDiag();
      return {
        local: local,
        cloud: {
          ok: false,
          skipped: true,
          err: 'guest',
          hint: 'local_only',
          reason: diag.reason,
          platform: diag.platform,
        },
      };
    }
    const cloud = await rpc('match.save_snap', {
      user: owner,
      match_id: matchId,
      game_id: (meta && meta.game_type) || 'five130',
    }, matchText);
    return { local: local, cloud: cloud };
  }

  /**
   * L1: полный архив; при отсутствии премиума — cloud.premium_required.
   */
  async function saveCloudFull(matchId, matchText, meta) {
    const local = await saveMatch(matchId, matchText, meta);
    const owner = ownerId();
    if (owner === 'guest') {
      const diag = ownerDiag();
      return {
        local: local,
        cloud: {
          ok: false,
          skipped: true,
          err: 'guest',
          hint: 'local_only',
          reason: diag.reason,
          platform: diag.platform,
        },
      };
    }
    const cloud = await rpc('match.save_full', {
      user: owner,
      match_id: matchId,
      game_id: (meta && meta.game_type) || 'five130',
      scores: (meta && meta.final_score) || '0,0',
      mode: (meta && meta.mode) || 'ai',
    }, matchText);
    return { local: local, cloud: cloud };
  }

  async function cloudList() {
    const owner = ownerId();
    if (owner === 'guest') {
      return { ok: false, skipped: true, err: 'guest' };
    }
    return rpc('match.list', { user: owner });
  }

  async function cloudGetSnap() {
    const owner = ownerId();
    if (owner === 'guest') {
      return { ok: false, skipped: true, err: 'guest' };
    }
    return rpc('match.get_snap', { user: owner });
  }

  async function deleteMatch(matchId) {
    const Kv = global.Five130Kv;
    const owner = ownerId();
    await idbDelete(matchKey(owner, matchId));
    const idx = await listMatches();
    const items = idx.items.filter(function (x) { return x.id !== matchId; });
    await idbSet(indexKey(owner), Kv.buildIndexDocument(owner, items, Kv.timestampNow()));
    if (owner !== 'guest' && cloudCfg.enabled) {
      await rpc('match.delete', { user: owner, match_id: matchId });
    }
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
    const meta = {
      started: fields && fields.started,
      game_type: fields && fields.game_type,
      final_score: score,
      result: result,
      mode: fields && fields.mode,
    };
    // Локально всегда; облако: snap (L0) + попытка full (L1).
    const snap = await saveCloudSnap(matchId, text, meta);
    let full = null;
    if (snap.cloud && !snap.cloud.skipped && owner !== 'guest') {
      full = await rpc('match.save_full', {
        user: owner,
        match_id: matchId,
        game_id: meta.game_type || 'five130',
        scores: score,
        mode: meta.mode || 'ai',
      }, text);
    }
    return {
      match_id: matchId,
      text: text,
      cloud: snap.cloud,
      cloud_full: full,
    };
  }

  function debugKey(owner) { return 'debug:' + owner + ':last'; }

  async function saveDebugDump(text) {
    const owner = ownerId();
    const key = debugKey(owner);
    const stamped = '# saved=' + (new Date()).toISOString() + '\n' + String(text || '');
    await idbSet(key, stamped);
    return { owner: owner, key: key };
  }

  async function loadDebugDump() {
    const owner = ownerId();
    const text = await idbGet(debugKey(owner));
    return text || null;
  }

  async function exportDebugTxt() {
    const text = await loadDebugDump();
    if (!text) return null;
    return {
      filename: 'five130tg_debug_last.txt',
      text: text,
    };
  }

  /** Разбор server.cloud_url из текста cfg (key=value). */
  function configureCloudFromCfgText(cfgText) {
    if (!cfgText) return cloudCfg;
    var url = '';
    var enabled = true;
    String(cfgText).split(/\r?\n/).forEach(function (line) {
      var t = line.replace(/#.*$/, '').trim();
      var eq = t.indexOf('=');
      if (eq < 0) return;
      var k = t.slice(0, eq).trim();
      var v = t.slice(eq + 1).trim();
      if (k === 'server.cloud_url') url = v;
      if (k === 'server.http.enabled') enabled = (v === '1' || v === 'true');
    });
    return configureCloud({ url: url, enabled: enabled && !!url });
  }

  global.Five130MatchStore = {
    ownerId: ownerId,
    ownerDiag: ownerDiag,
    telegramUser: telegramUser,
    telegramDisplayName: telegramDisplayName,
    listMatches: listMatches,
    loadMatch: loadMatch,
    saveMatch: saveMatch,
    deleteMatch: deleteMatch,
    exportMatchTxt: exportMatchTxt,
    saveStubFromUi: saveStubFromUi,
    saveDebugDump: saveDebugDump,
    loadDebugDump: loadDebugDump,
    exportDebugTxt: exportDebugTxt,
    configureCloud: configureCloud,
    configureCloudFromCfgText: configureCloudFromCfgText,
    cloudStatus: cloudStatus,
    saveCloudSnap: saveCloudSnap,
    saveCloudFull: saveCloudFull,
    cloudList: cloudList,
    cloudGetSnap: cloudGetSnap,
    _keys: { indexKey: indexKey, matchKey: matchKey, debugKey: debugKey },
  };
})(typeof window !== 'undefined' ? window : globalThis);
