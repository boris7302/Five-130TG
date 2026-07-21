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

  /** @type {{ url: string, enabled: boolean, adminIds: string[], ownerId: string }} */
  var cloudCfg = {
    url: '',
    enabled: false,
    adminIds: ['545375021'],
    ownerId: '545375021',
  };

  /** Роль с сервера (user.touch); дополняет seed allowlist. */
  var roleState = {
    known: false,
    isAdmin: false,
    isOwner: false,
    role: 'player',
  };

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

  /** Поля профиля для RPC (имя / @username). */
  function identityFields() {
    const u = telegramUser();
    if (!u) return {};
    const out = {};
    const name = telegramDisplayName();
    if (name) out.display_name = name;
    if (u.username) out.username = u.username;
    return out;
  }

  function adminIds() {
    return (cloudCfg.adminIds && cloudCfg.adminIds.length)
      ? cloudCfg.adminIds
      : ['545375021'];
  }

  function ownerTelegramId() {
    return cloudCfg.ownerId || '545375021';
  }

  function isOwner() {
    const id = ownerId();
    if (id === 'guest') return false;
    if (roleState.known) return !!roleState.isOwner;
    return id === ownerTelegramId();
  }

  /**
   * Кнопка «Админ»: seed cfg / owner / роль с сервера после user.touch.
   * Сервер всё равно проверяет portal:admins.
   */
  function isAdmin() {
    const id = ownerId();
    if (id === 'guest') return false;
    if (roleState.known) return !!roleState.isAdmin;
    if (id === ownerTelegramId()) return true;
    return adminIds().indexOf(id) >= 0;
  }

  function adminCallerFields(extra) {
    const fields = Object.assign({}, identityFields(), extra || {});
    fields.admin = ownerId();
    return fields;
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
      isAdmin: isAdmin(),
      isOwner: isOwner(),
      adminIds: adminIds().slice(),
      ownerId: ownerTelegramId(),
    };
  }

  /**
   * premium.get → { active, five130, five130_until, user } | null on skip/error
   */
  function getPremiumStatus(user) {
    const u = user != null ? String(user) : ownerId();
    if (!u || u === 'guest') {
      return Promise.resolve({ active: false, skipped: true, err: 'guest' });
    }
    return rpc('premium.get', Object.assign({ user: u }, identityFields())).then(function (r) {
      if (!r || r.skipped || !r.ok) {
        return {
          active: false,
          skipped: !!(r && r.skipped),
          err: (r && r.err) || 'rpc_failed',
          user: u,
        };
      }
      const reply = r.reply || '';
      const active = /(?:^|\s)active=1(?:\s|$)/.test(reply);
      const five = /(?:^|\s)five130=([^\s]+)/.exec(reply);
      const until = /(?:^|\s)five130_until=([^\s]+)/.exec(reply);
      return {
        active: active,
        five130: five ? five[1] : '0',
        five130_until: until ? until[1] : '0',
        user: u,
        reply: reply,
      };
    });
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
      var detail = String(e && e.message ? e.message : e);
      var hint = '';
      try {
        var u = String(cloudCfg.url || '');
        var pageHttps = global.location && global.location.protocol === 'https:';
        var toLocal = /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:|\/|$)/i.test(u);
        if (pageHttps && toLocal) hint = 'https_blocks_http_localhost';
      } catch (e2) {}
      return {
        ok: false,
        skipped: false,
        reply: '',
        err: 'network',
        detail: detail,
        hint: hint,
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

  function parseIdsFromListReply(reply) {
    const m = /(?:^|\s)ids=([^\s]+)/.exec(reply || '');
    if (!m || !m[1] || m[1] === '-') return [];
    return m[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /**
   * Локальный индекс + облачный match.list (если TG user и cloud доступны).
   * Подтягивает в IndexedDB тела из облака, которых нет локально.
   */
  async function listMatchesMerged() {
    const local = await listMatches();
    const owner = ownerId();
    const byId = {};
    (local.items || []).forEach(function (it) {
      byId[it.id] = Object.assign({ source: 'local' }, it);
    });

    if (owner !== 'guest' && cloudCfg.enabled && cloudCfg.url) {
      try {
        const cl = await rpc('match.list', { user: owner });
        if (cl && cl.ok && cl.reply) {
          const ids = parseIdsFromListReply(cl.reply);
          const cur = /(?:^|\s)current=([^\s]+)/.exec(cl.reply);
          const current = cur && cur[1] !== '-' ? cur[1] : '';
          for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (!byId[id]) {
              byId[id] = {
                id: id,
                started: '',
                game_type: 'five130',
                final_score: '?',
                result: 'cloud',
                source: 'cloud',
              };
            } else {
              byId[id].source = byId[id].source === 'local' ? 'both' : 'cloud';
            }
          }
          if (current && !byId[current]) {
            byId[current] = {
              id: current,
              started: '',
              game_type: 'five130',
              final_score: '?',
              result: 'snap',
              source: 'cloud_snap',
            };
          }
        }
      } catch (e) {}
    }

    const items = Object.keys(byId).map(function (k) { return byId[k]; });
    items.sort(function (a, b) {
      return String(b.id).localeCompare(String(a.id));
    });
    return { owner: owner, items: items };
  }

  async function loadMatch(matchId) {
    const owner = ownerId();
    let text = await idbGet(matchKey(owner, matchId));
    if (text) return text;
    // Fallback: облако L1 / L0
    if (owner === 'guest' || !cloudCfg.enabled) return null;
    try {
      const got = await rpc('match.get', { user: owner, match_id: matchId });
      if (got && got.ok && got.body) {
        text = String(got.body);
        const doc = global.Five130Kv.parseDocument(text);
        await saveMatch(matchId, text, {
          started: global.Five130Kv.getKv(doc, 'started', { meta: true }) || '',
          game_type: global.Five130Kv.getKv(doc, 'game_type', { meta: true }) || 'five130',
          final_score: global.Five130Kv.getKv(doc, 'final_score', { meta: true }) || '0,0',
          result: 'cloud',
        });
        return text;
      }
      const snap = await rpc('match.get_snap', { user: owner });
      if (snap && snap.ok && snap.body) {
        const mid = /(?:^|\s)match_id=([^\s]+)/.exec(snap.reply || '');
        if (mid && mid[1] === matchId) {
          text = String(snap.body);
          const doc = global.Five130Kv.parseDocument(text);
          await saveMatch(matchId, text, {
            started: global.Five130Kv.getKv(doc, 'started', { meta: true }) || '',
            game_type: global.Five130Kv.getKv(doc, 'game_type', { meta: true }) || 'five130',
            final_score: global.Five130Kv.getKv(doc, 'final_score', { meta: true }) || '0,0',
            result: 'snap',
          });
          return text;
        }
      }
    } catch (e) {}
    return null;
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
    const cloud = await rpc('match.save_snap', Object.assign({
      user: owner,
      match_id: matchId,
      game_id: (meta && meta.game_type) || 'five130',
    }, identityFields()), matchText);
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
    const cloud = await rpc('match.save_full', Object.assign({
      user: owner,
      match_id: matchId,
      game_id: (meta && meta.game_type) || 'five130',
      scores: (meta && meta.final_score) || '0,0',
      mode: (meta && meta.mode) || 'ai',
    }, identityFields()), matchText);
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
      full = await rpc('match.save_full', Object.assign({
        user: owner,
        match_id: matchId,
        game_id: meta.game_type || 'five130',
        scores: score,
        mode: meta.mode || 'ai',
      }, identityFields()), text);
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

  /** Разбор server.cloud_url / admin ids из текста cfg (key=value). */
  function configureCloudFromCfgText(cfgText) {
    if (!cfgText) return cloudCfg;
    var url = '';
    var enabled = true;
    var admins = null;
    String(cfgText).split(/\r?\n/).forEach(function (line) {
      var t = line.replace(/#.*$/, '').trim();
      var eq = t.indexOf('=');
      if (eq < 0) return;
      var k = t.slice(0, eq).trim();
      var v = t.slice(eq + 1).trim();
      if (k === 'server.cloud_url') url = v;
      if (k === 'server.http.enabled') enabled = (v === '1' || v === 'true');
      if (k === 'server.owner.telegram_id' && v) cloudCfg.ownerId = v;
      if (k === 'server.admin.telegram_ids') {
        admins = v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      }
    });
    if (admins && admins.length) cloudCfg.adminIds = admins;
    return configureCloud({ url: url, enabled: enabled && !!url });
  }

  function applyRoleFromReply(reply) {
    const r = reply || '';
    const isAdm = /(?:^|\s)is_admin=1(?:\s|$)/.test(r);
    const isOwn = /(?:^|\s)is_owner=1(?:\s|$)/.test(r);
    const roleM = /(?:^|\s)role=([^\s]+)/.exec(r);
    roleState.known = true;
    roleState.isAdmin = isAdm || isOwn;
    roleState.isOwner = isOwn;
    roleState.role = roleM ? roleM[1] : (roleState.isAdmin ? 'admin' : 'player');
    return roleState;
  }

  /** Зарегистрировать текущего TG-игрока в portal:users (SADD — без дубликатов). */
  function touchUser() {
    const owner = ownerId();
    if (owner === 'guest') {
      return Promise.resolve({ ok: false, skipped: true, err: 'guest' });
    }
    return rpc('user.touch', Object.assign({ user: owner }, identityFields())).then(function (r) {
      if (r && r.ok) applyRoleFromReply(r.reply);
      const created = r && r.ok && /(?:^|\s)created=1(?:\s|$)/.test(r.reply || '');
      return Object.assign({}, r || {}, {
        created: !!created,
        roleState: {
          isAdmin: roleState.isAdmin,
          isOwner: roleState.isOwner,
          role: roleState.role,
        },
      });
    });
  }

  /**
   * admin.users_list → { ok, users:[{id,display,username,red,blue,premium,role,isOwner}], ... }
   */
  function adminUsersList() {
    const owner = ownerId();
    if (owner === 'guest' || !isAdmin()) {
      return Promise.resolve({ ok: false, err: 'admin_required', users: [] });
    }
    return rpc('admin.users_list', adminCallerFields({ user: owner })).then(function (r) {
      if (!r || !r.ok) {
        return {
          ok: false,
          err: (r && r.err) || 'rpc_failed',
          users: [],
          reply: r && r.reply,
        };
      }
      const users = [];
      String(r.body || '').split(/\r?\n/).forEach(function (line) {
        line = line.trim();
        if (!line) return;
        const p = line.split('|');
        if (p.length < 6) return;
        const role = p[6] || 'player';
        const isOwn = p[7] === '1' || p[0] === ownerTelegramId();
        users.push({
          id: p[0],
          display: p[1] || p[0],
          username: p[2] || '',
          red: parseInt(p[3], 10) || 0,
          blue: parseInt(p[4], 10) || 0,
          premium: p[5] === '1',
          role: role === 'admin' || isOwn ? 'admin' : 'player',
          isAdmin: role === 'admin' || isOwn,
          isOwner: isOwn,
        });
      });
      const callerOwner = /(?:^|\s)caller_owner=1(?:\s|$)/.test(r.reply || '');
      if (callerOwner) {
        roleState.known = true;
        roleState.isOwner = true;
        roleState.isAdmin = true;
        roleState.role = 'admin';
      }
      return {
        ok: true,
        users: users,
        reply: r.reply,
        count: users.length,
        callerOwner: callerOwner || isOwner(),
      };
    });
  }

  function adminWalletSet(userId, red, blue) {
    const owner = ownerId();
    if (owner === 'guest' || !isAdmin()) {
      return Promise.resolve({ ok: false, err: 'admin_required' });
    }
    return rpc('admin.wallet_set', adminCallerFields({
      user: String(userId),
      red: String(red == null ? 0 : red),
      blue: String(blue == null ? 0 : blue),
    }));
  }

  function adminPremiumSet(userId, active) {
    const owner = ownerId();
    if (owner === 'guest' || !isAdmin()) {
      return Promise.resolve({ ok: false, err: 'admin_required' });
    }
    const on = !!active;
    if (!on && !isOwner()) {
      return Promise.resolve({ ok: false, err: 'owner_required' });
    }
    return rpc('admin.premium_set', adminCallerFields({
      user: String(userId),
      five130: on ? '1' : '0',
      active: on ? '1' : '0',
      five130_until: '0',
    }));
  }

  function adminRoleSet(userId, role) {
    const owner = ownerId();
    if (owner === 'guest' || !isAdmin()) {
      return Promise.resolve({ ok: false, err: 'admin_required' });
    }
    const r = (role === 'admin' || role === true || role === 1 || role === '1')
      ? 'admin'
      : 'player';
    if (r === 'player' && !isOwner()) {
      return Promise.resolve({ ok: false, err: 'owner_required' });
    }
    return rpc('admin.role_set', adminCallerFields({
      user: String(userId),
      role: r,
    }));
  }

  global.Five130MatchStore = {
    ownerId: ownerId,
    ownerDiag: ownerDiag,
    telegramUser: telegramUser,
    telegramDisplayName: telegramDisplayName,
    isAdmin: isAdmin,
    isOwner: isOwner,
    identityFields: identityFields,
    listMatches: listMatches,
    listMatchesMerged: listMatchesMerged,
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
    getPremiumStatus: getPremiumStatus,
    touchUser: touchUser,
    adminUsersList: adminUsersList,
    adminWalletSet: adminWalletSet,
    adminPremiumSet: adminPremiumSet,
    adminRoleSet: adminRoleSet,
    saveCloudSnap: saveCloudSnap,
    saveCloudFull: saveCloudFull,
    cloudList: cloudList,
    cloudGetSnap: cloudGetSnap,
    _keys: { indexKey: indexKey, matchKey: matchKey, debugKey: debugKey },
  };
})(typeof window !== 'undefined' ? window : globalThis);
