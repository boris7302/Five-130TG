/**
 * Five-130 game engine (JS port of C++ core for Telegram Mini App).
 * Format/rules: rules_125 + rules_130. No JSON match format — MatchStore stays KV.
 * @version 0.001
 */
(function (global) {
  'use strict';

  const HAND_SIZE = 7;
  const MATCH_TARGET = 125;
  const HUMAN = 0;
  const AI = 1;
  const FIVE130_WIN_MIN = 125;
  const FIVE130_WIN_HIGH = 130;
  const FIVE130_REFLECT = 235;
  const FIVE130_OVERFLOW_DRAW = 10;

  /** Версия Mini App / JS-движка (как APP_VERSION в C++). */
  const APP_VERSION = "0.001";

  const EndId = { MainLeft: 0, MainRight: 1, BranchUp: 2, BranchDown: 3 };
  const EndName = ['влево', 'вправо', 'вверх', 'вниз'];

  function Tile(lo, hi) {
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    return { lo: lo, hi: hi, isDouble: lo === hi, pipSum: lo + hi, label: lo + '|' + hi };
  }
  function tileEq(a, b) { return a && b && a.lo === b.lo && a.hi === b.hi; }
  function allTiles() {
    const out = [];
    for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) out.push(Tile(a, b));
    return out;
  }

  function roundPips5(sum) {
    const r = sum % 5;
    if (r === 0) return sum;
    if (r <= 2) return sum - r;
    return sum + (5 - r);
  }
  /**
   * Штраф за остаток на руке (rules_125 §5; рыба §7.2).
   * Один 0|0 → −25; один 6|6 → −50; оба (только эти два) → −75;
   * иначе сумма pip, округлённая до кратного 5 (§5.1/§5.3).
   */
  function leftoverHandPenalty(hand) {
    if (!hand.length) return 0;
    let has00 = false, has66 = false, other = 0;
    for (let i = 0; i < hand.length; i++) {
      const t = hand[i];
      if (t.lo === 0 && t.hi === 0) has00 = true;
      else if (t.lo === 6 && t.hi === 6) has66 = true;
      else other++;
    }
    if (other === 0) {
      if (has00 && has66) return -75;
      if (has00 && hand.length === 1) return -25;
      if (has66 && hand.length === 1) return -50;
      // несколько копий одного дубля невозможно в комплекте — fallback ниже
    }
    if (hand.length === 1 && hand[0].isDouble) {
      if (hand[0].lo === 0) return -25;
      if (hand[0].lo === 6) return -50;
    }
    let sum = 0;
    for (let i = 0; i < hand.length; i++) sum += hand[i].pipSum;
    const rounded = roundPips5(sum);
    return rounded < 3 ? 0 : -rounded;
  }
  function opponentFinishPenalty(finishing, oppHand) {
    let f00 = false, f66 = false;
    for (let i = 0; i < finishing.length; i++) {
      if (finishing[i].lo === 0 && finishing[i].hi === 0) f00 = true;
      if (finishing[i].lo === 6 && finishing[i].hi === 6) f66 = true;
    }
    if (!f00 && !f66) return 0;
    if (f00 && f66) return 75;
    if (f66 && oppHand.length === 1 && oppHand[0].lo === 0 && oppHand[0].hi === 0) return 50;
    if (f00 && oppHand.length === 1 && oppHand[0].lo === 6 && oppHand[0].hi === 6) return 25;
    return f66 ? 50 : 25;
  }
  function loserHas00And66(hand) {
    let a = false, b = false;
    for (let i = 0; i < hand.length; i++) {
      if (hand[i].lo === 0 && hand[i].hi === 0) a = true;
      if (hand[i].lo === 6 && hand[i].hi === 6) b = true;
    }
    return a && b;
  }

  function newArm() { return { active: false, tiles: [] }; }
  function newBoard() {
    return {
      hasCenter: false,
      center: { tile: Tile(0, 0), player: -1 },
      mainLeft: newArm(), mainRight: newArm(),
      branchUp: newArm(), branchDown: newArm(),
      mainLineDoubles: [],
      hasSpinner: false, spinnerAtCenter: false,
      spinnerArm: EndId.MainRight, spinnerIndex: 0,
    };
  }
  function arm(b, end) {
    if (end === EndId.MainLeft) return b.mainLeft;
    if (end === EndId.MainRight) return b.mainRight;
    if (end === EndId.BranchUp) return b.branchUp;
    return b.branchDown;
  }
  function spinnerTile(b) {
    if (!b.hasSpinner) return b.center;
    if (b.spinnerAtCenter) return b.center;
    return arm(b, b.spinnerArm).tiles[b.spinnerIndex];
  }
  function isMainLineDoubleClosed(b, ref) {
    if (ref.atCenter) {
      return b.center.tile.isDouble && b.mainLeft.tiles.length && b.mainRight.tiles.length;
    }
    const a = arm(b, ref.arm);
    if (ref.index >= a.tiles.length || !a.tiles[ref.index].tile.isDouble) return false;
    return ref.index + 1 < a.tiles.length;
  }
  function spinnerClosedBothSides(b) {
    if (!b.hasSpinner) return false;
    return isMainLineDoubleClosed(b, {
      atCenter: b.spinnerAtCenter, arm: b.spinnerArm, index: b.spinnerIndex,
    });
  }
  function tryAssignSpinner(b) {
    if (b.hasSpinner) return;
    for (let i = 0; i < b.mainLineDoubles.length; i++) {
      const ref = b.mainLineDoubles[i];
      if (isMainLineDoubleClosed(b, ref)) {
        b.hasSpinner = true;
        b.spinnerAtCenter = ref.atCenter;
        b.spinnerArm = ref.arm;
        b.spinnerIndex = ref.index;
        return;
      }
    }
  }
  function updateBranches(b) {
    tryAssignSpinner(b);
    const on = b.hasSpinner && spinnerClosedBothSides(b);
    b.branchUp.active = on;
    b.branchDown.active = on;
  }
  function activeEnds(b) {
    const ids = [EndId.MainLeft, EndId.MainRight, EndId.BranchUp, EndId.BranchDown];
    const out = [];
    for (let i = 0; i < ids.length; i++) if (arm(b, ids[i]).active) out.push(ids[i]);
    return out;
  }
  function openPip(b, end) {
    const a = arm(b, end);
    if (!a.active) return -1;
    if (!a.tiles.length) {
      if (end === EndId.MainRight) return b.center.tile.hi;
      if (end === EndId.MainLeft) return b.center.tile.lo;
      if (end === EndId.BranchUp || end === EndId.BranchDown) {
        return b.hasSpinner ? spinnerTile(b).tile.lo : -1;
      }
      return -1;
    }
    const last = a.tiles[a.tiles.length - 1].tile;
    const prev = a.tiles.length === 1
      ? ((end === EndId.BranchUp || end === EndId.BranchDown)
          ? spinnerTile(b).tile : b.center.tile)
      : a.tiles[a.tiles.length - 2].tile;
    const inward = (prev.lo === last.lo || prev.lo === last.hi) ? prev.lo : prev.hi;
    return last.lo === inward ? last.hi : last.lo;
  }
  function isDoubleAtEnd(b, end) {
    const a = arm(b, end);
    if (!a.active) return false;
    if (a.tiles.length) return a.tiles[a.tiles.length - 1].tile.isDouble;
    if (end === EndId.MainLeft || end === EndId.MainRight) return b.center.tile.isDouble;
    return b.hasSpinner && spinnerTile(b).tile.isDouble;
  }
  function canConnect(b, tile, end) {
    if (!b.hasCenter) return false;
    if (!arm(b, end).active) return false;
    const pip = openPip(b, end);
    return tile.lo === pip || tile.hi === pip;
  }
  function placeFirst(b, tile, player) {
    b.center = { tile: tile, player: player };
    b.hasCenter = true;
    b.hasSpinner = false;
    b.spinnerAtCenter = false;
    b.mainLineDoubles = [];
    if (tile.isDouble) b.mainLineDoubles.push({ atCenter: true, arm: EndId.MainLeft, index: 0 });
    b.mainLeft.active = true;
    b.mainRight.active = true;
    b.branchUp.active = false;
    b.branchDown.active = false;
    updateBranches(b);
  }
  function placeOnEnd(b, tile, end, player) {
    const a = arm(b, end);
    a.tiles.push({ tile: tile, player: player });
    if (tile.isDouble && (end === EndId.MainLeft || end === EndId.MainRight)) {
      b.mainLineDoubles.push({ atCenter: false, arm: end, index: a.tiles.length - 1 });
    }
    updateBranches(b);
  }
  function isFirstMoveOnly(b) {
    return b.hasCenter && !b.mainLeft.tiles.length && !b.mainRight.tiles.length &&
      !b.branchUp.tiles.length && !b.branchDown.tiles.length;
  }
  function firstMovePipSum(b) {
    const t = b.center.tile;
    if (t.isDouble) return t.lo === 5 ? 10 : 0;
    return t.lo + t.hi;
  }
  function scoringEndsPipSum(b) {
    if (isFirstMoveOnly(b)) return firstMovePipSum(b);
    let sum = 0;
    const ends = activeEnds(b);
    for (let i = 0; i < ends.length; i++) {
      const id = ends[i];
      const a = arm(b, id);
      if ((id === EndId.BranchUp || id === EndId.BranchDown) && !a.tiles.length) continue;
      const pip = openPip(b, id);
      if (pip < 0) continue;
      sum += isDoubleAtEnd(b, id) ? pip * 2 : pip;
    }
    return sum;
  }

  function listLegalMovesBase(board, hand, requiredFirst, block0066) {
    const out = [];
    if (!board.hasCenter) {
      if (requiredFirst) {
        for (let i = 0; i < hand.length; i++) {
          if (tileEq(hand[i], requiredFirst)) {
            out.push({ end: EndId.MainLeft, tile: hand[i], isFirst: true, extra: [] });
            break;
          }
        }
        return out;
      }
      for (let i = 0; i < hand.length; i++) {
        const t = hand[i];
        if (block0066 && ((t.lo === 0 && t.hi === 0) || (t.lo === 6 && t.hi === 6))) continue;
        out.push({ end: EndId.MainLeft, tile: t, isFirst: true, extra: [] });
      }
      return out;
    }
    const ends = activeEnds(board);
    for (let i = 0; i < hand.length; i++) {
      for (let j = 0; j < ends.length; j++) {
        if (canConnect(board, hand[i], ends[j])) {
          out.push({ end: ends[j], tile: hand[i], isFirst: false, extra: [] });
        }
      }
    }
    return out;
  }

  /**
   * Перечисляет все комбинации дублей размера >= 2 без общих концов/камней (§2.8).
   * @param {{tile:object,end:number}[]} options Варианты (дубль, конец).
   * @return {{tile:object,end:number}[][]} Список комбинаций.
   */
  function findAllDoubleCombos(options) {
    const out = [];
    function rec(start, current) {
      if (current.length >= 2) out.push(current.slice());
      for (let i = start; i < options.length; i++) {
        const c = options[i];
        let usedEnd = false, usedTile = false;
        for (let j = 0; j < current.length; j++) {
          if (current[j].end === c.end) usedEnd = true;
          if (tileEq(current[j].tile, c.tile)) usedTile = true;
        }
        if (!usedEnd && !usedTile) {
          current.push(c);
          rec(i + 1, current);
          current.pop();
        }
      }
    }
    rec(0, []);
    return out;
  }

  /**
   * Легальные ходы с составными дублями: одиночные + все комбинации §2.8.
   * @param {object} board Доска.
   * @param {object[]} hand Рука.
   * @param {object|null} requiredFirst Обязательный первый камень (или null).
   * @param {boolean} block0066 Запрет 0|0/6|6 на первом ходе.
   * @return {object[]} Список ходов.
   */
  function listLegalMovesForHand(board, hand, requiredFirst, block0066) {
    const base = listLegalMovesBase(board, hand, requiredFirst, block0066);
    if (!board.hasCenter || requiredFirst) return base;
    const doubles = [], singles = [];
    for (let i = 0; i < base.length; i++) {
      (base[i].tile.isDouble ? doubles : singles).push(base[i]);
    }
    const choices = [];
    for (let i = 0; i < doubles.length; i++) {
      const m = doubles[i];
      let dup = false;
      for (let j = 0; j < choices.length; j++) {
        if (tileEq(choices[j].tile, m.tile) && choices[j].end === m.end) { dup = true; break; }
      }
      if (!dup) choices.push({ tile: m.tile, end: m.end });
    }
    const combos = findAllDoubleCombos(choices);
    if (!combos.length) return base;
    const out = [];
    for (let i = 0; i < singles.length; i++) out.push(singles[i]);
    for (let i = 0; i < doubles.length; i++) out.push(doubles[i]);
    for (let c = 0; c < combos.length; c++) {
      const combo = combos[c];
      const primary = combo[0];
      const extra = [];
      for (let i = 1; i < combo.length; i++) {
        extra.push({ end: combo[i].end, tile: combo[i].tile, isFirst: false });
      }
      out.push({ end: primary.end, tile: primary.tile, isFirst: false, extra: extra });
    }
    return out;
  }

  function allPlacings(move) {
    const out = [{ end: move.end, tile: move.tile, isFirst: move.isFirst }];
    const extra = move.extra || [];
    for (let i = 0; i < extra.length; i++) out.push(extra[i]);
    return out;
  }
  function samePlacings(a, b) {
    const pa = allPlacings(a), pb = allPlacings(b);
    if (pa.length !== pb.length) return false;
    for (let i = 0; i < pa.length; i++) {
      if (pa[i].end !== pb[i].end || !tileEq(pa[i].tile, pb[i].tile) ||
          !!pa[i].isFirst !== !!pb[i].isFirst) return false;
    }
    return true;
  }
  function moveLabel(move) {
    const steps = allPlacings(move);
    if (steps[0].isFirst) return 'Первый: ' + steps[0].tile.label;
    if (steps.length === 1) return steps[0].tile.label + ' → ' + EndName[steps[0].end];
    return steps.map(function (s) { return s.tile.label + '→' + EndName[s.end]; }).join(' + ');
  }

  const OPENING_PRIORITY = [
    Tile(1, 1), Tile(2, 2), Tile(3, 3), Tile(4, 4), Tile(5, 5),
    Tile(1, 2), Tile(1, 3), Tile(1, 4), Tile(1, 5), Tile(1, 6),
    Tile(2, 3), Tile(2, 4), Tile(2, 5), Tile(2, 6), Tile(3, 4),
  ];
  function handHas(hand, tile) {
    for (let i = 0; i < hand.length; i++) if (tileEq(hand[i], tile)) return true;
    return false;
  }
  function removeTile(hand, tile) {
    for (let i = 0; i < hand.length; i++) {
      if (tileEq(hand[i], tile)) { hand.splice(i, 1); return true; }
    }
    return false;
  }
  function determineOpening(h0, h1) {
    for (let i = 0; i < OPENING_PRIORITY.length; i++) {
      const t = OPENING_PRIORITY[i];
      if (handHas(h0, t)) return { starter: 0, tile: t };
      if (handHas(h1, t)) return { starter: 1, tile: t };
    }
    return { starter: 0, tile: Tile(1, 1) };
  }

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
  }
  function mulberry32(a) {
    return function () {
      let t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function createMatch(opts) {
    opts = opts || {};
    const seed = opts.seed != null ? (opts.seed >>> 0) : ((Date.now() ^ (Math.random() * 1e9)) >>> 0);
    const rng = mulberry32(seed);
    const match = {
      gameType: opts.gameType === 'five125' ? 'five125' : 'five130',
      scores: [0, 0],
      gameIndex: 0,
      lastWinner: 0,
      fishNextStarter: false,
      fishStarter: 0,
      matchOver: false,
      matchWinner: -1,
      matchDraw: false,
      statusLine: '',
      overflowCount: [0, 0],
      overflowTotal: 0,
      seed: seed,
      round: null,
    };
    startRound(match, rng);
    return { match: match, rng: rng };
  }

  function legalMoves(round) {
    if (!round.board.hasCenter && round.requiredOpening) {
      if (round.currentPlayer !== round.starter) return [];
      return listLegalMovesForHand(round.board, round.hands[round.currentPlayer],
        round.requiredOpening, true);
    }
    if (!round.board.hasCenter) {
      return listLegalMovesForHand(round.board, round.hands[round.currentPlayer], null, true);
    }
    return listLegalMovesForHand(round.board, round.hands[round.currentPlayer], null, false);
  }

  function anyoneCanMove(round) {
    const block = !round.board.hasCenter;
    for (let p = 0; p < 2; p++) {
      if (listLegalMovesBase(round.board, round.hands[p], null, block).length) return true;
    }
    return false;
  }

  function deal(round, rng) {
    const deck = allTiles();
    shuffle(deck, rng);
    round.hands = [deck.slice(0, HAND_SIZE), deck.slice(HAND_SIZE, HAND_SIZE * 2)];
    round.market = deck.slice(HAND_SIZE * 2);
    round.board = newBoard();
    round.roundOver = false;
    round.winner = -1;
    round.endReason = null;
    round.moveScores = [0, 0];
    round.lastFinishTiles = [];
    round.actionLog = [];
    round.message = '';
    round.requiredOpening = null;
    round.currentPlayer = round.starter;
  }

  function startRound(match, rng) {
    const round = {
      board: newBoard(),
      hands: [[], []],
      market: [],
      currentPlayer: 0,
      starter: 0,
      firstGame: match.gameIndex === 0,
      requiredOpening: null,
      roundOver: false,
      endReason: null,
      winner: -1,
      moveScores: [0, 0],
      lastFinishTiles: [],
      actionLog: [],
      message: '',
    };
    deal(round, rng);
    if (match.fishNextStarter) {
      round.starter = match.fishStarter;
      match.fishNextStarter = false;
      round.currentPlayer = round.starter;
    } else if (match.gameIndex === 0) {
      const op = determineOpening(round.hands[0], round.hands[1]);
      round.starter = op.starter;
      round.currentPlayer = op.starter;
      round.requiredOpening = op.tile;
      if (op.starter === HUMAN) {
        applyMove(round, {
          end: EndId.MainLeft, tile: op.tile, isFirst: true, extra: [],
        });
        round.message = 'Автооткрытие: ' + op.tile.label;
      } else {
        round.message = 'Первый ход партии: ' + op.tile.label + ' (компьютер)';
      }
    } else {
      round.starter = match.lastWinner;
      round.currentPlayer = round.starter;
    }
    match.round = round;
    return round;
  }

  function applyMove(round, move) {
    if (round.roundOver) return false;
    const moves = legalMoves(round);
    let ok = false;
    for (let i = 0; i < moves.length; i++) {
      if (samePlacings(moves[i], move)) { ok = true; move = moves[i]; break; }
    }
    if (!ok) {
      // allow exact required opening auto without full scan quirks
      if (!round.board.hasCenter && move.isFirst && round.requiredOpening &&
          tileEq(move.tile, round.requiredOpening) &&
          round.currentPlayer === round.starter &&
          handHas(round.hands[round.currentPlayer], move.tile)) {
        ok = true;
      } else {
        round.message = 'Недопустимый ход.';
        return false;
      }
    }
    const steps = allPlacings(move);
    for (let i = 0; i < steps.length; i++) {
      removeTile(round.hands[round.currentPlayer], steps[i].tile);
    }
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].isFirst) {
        placeFirst(round.board, steps[i].tile, round.currentPlayer);
        round.requiredOpening = null;
      } else {
        placeOnEnd(round.board, steps[i].tile, steps[i].end, round.currentPlayer);
      }
    }
    round.lastFinishTiles = steps.map(function (s) { return s.tile; });
    const pip = scoringEndsPipSum(round.board);
    let log = moveLabel(move);
    if (pip > 0 && pip % 5 === 0) {
      round.moveScores[round.currentPlayer] += pip;
      log += ' [+' + pip + ']';
      round.message = 'За ход +' + pip + ' (сумма концов ' + pip + ')';
    } else round.message = '';
    round.actionLog.push({ player: round.currentPlayer, text: log });

    if (!round.hands[round.currentPlayer].length) {
      round.roundOver = true;
      round.endReason = 'handEmpty';
      round.winner = round.currentPlayer;
      return true;
    }
    if (!anyoneCanMove(round) && !round.market.length) {
      round.roundOver = true;
      round.endReason = 'fish';
      round.winner = round.currentPlayer;
      round.message = 'Рыба! Ходов больше нет!';
      return true;
    }
    round.currentPlayer = 1 - round.currentPlayer;
    return true;
  }

  function drawFromMarket(round) {
    if (round.roundOver) return false;
    if (legalMoves(round).length) {
      round.message = 'Есть ход — рынок не нужен.';
      return false;
    }
    if (!round.market.length) {
      passTurn(round, 'рынок пуст');
      return false;
    }
    while (round.market.length) {
      const drawn = round.market.pop();
      round.hands[round.currentPlayer].push(drawn);
      if (listLegalMovesBase(round.board, round.hands[round.currentPlayer], null,
          !round.board.hasCenter).length) {
        round.actionLog.push({
          player: round.currentPlayer,
          text: round.currentPlayer === AI ? 'рынок' : ('рынок: ' + drawn.label),
        });
        round.message = round.currentPlayer === AI
          ? 'Компьютер взял с рынка.'
          : ('Взяли ' + drawn.label);
        return true;
      }
    }
    passTurn(round, 'рынок пуст');
    return false;
  }

  function passTurn(round, reason) {
    round.actionLog.push({ player: round.currentPlayer, text: 'пропуск: ' + reason });
    round.currentPlayer = 1 - round.currentPlayer;
    if (!round.market.length && !anyoneCanMove(round)) {
      round.roundOver = true;
      round.endReason = 'fish';
      round.winner = round.currentPlayer === 0 ? 1 : 0; // last placer approx
      // better: last placing from log
      for (let i = round.actionLog.length - 1; i >= 0; i--) {
        const t = round.actionLog[i].text;
        if (t.indexOf('пропуск') === 0 || t.indexOf('рынок') === 0) continue;
        round.winner = round.actionLog[i].player;
        break;
      }
      round.message = 'Рыба! Ходов больше нет!';
    }
  }

  function settleRound(round) {
    const d = {
      player0: round.moveScores[0],
      player1: round.moveScores[1],
      moveScore: [round.moveScores[0], round.moveScores[1]],
      leftover: [0, 0],
      finish: [0, 0],
      endReason: round.endReason,
      winner: round.winner,
      summary: '',
    };
    if (round.endReason === 'handEmpty' && round.winner >= 0) {
      const opp = 1 - round.winner;
      const finishPen = opponentFinishPenalty(round.lastFinishTiles, round.hands[opp]);
      let leftover = 0;
      if (finishPen === 0 || loserHas00And66(round.hands[opp])) {
        leftover = leftoverHandPenalty(round.hands[opp]);
      }
      d.leftover[opp] = leftover;
      d.finish[opp] = -finishPen;
      if (round.winner === 0) d.player1 += leftover - finishPen;
      else d.player0 += leftover - finishPen;
    } else {
      d.leftover[0] = leftoverHandPenalty(round.hands[0]);
      d.leftover[1] = leftoverHandPenalty(round.hands[1]);
      d.player0 += d.leftover[0];
      d.player1 += d.leftover[1];
    }
    if (round.endReason === 'fish') {
      d.summary = 'Рыба! Ходов больше нет! Итог: Вы ' + d.player0 + '  Комп ' + d.player1;
    } else {
      d.summary = 'Итог игры: Вы ' + d.player0 + '  Комп ' + d.player1;
    }
    return d;
  }

  function applyFive130Reflection(scores, overflowCount, overflowTotal) {
    let total = overflowTotal;
    const applied = [false, false];
    for (let p = 0; p < 2; p++) {
      if (scores[p] > FIVE130_WIN_HIGH) {
        scores[p] = FIVE130_REFLECT - scores[p];
        applied[p] = true;
        overflowCount[p]++;
        total++;
      }
    }
    return { applied: applied, overflowTotal: total };
  }

  function evaluateFive130End(scores) {
    const q0 = scores[0] >= FIVE130_WIN_MIN;
    const q1 = scores[1] >= FIVE130_WIN_MIN;
    if (!q0 && !q1) return null;
    if (scores[0] === scores[1]) {
      return { draw: true, winner: -1, status: 'Ничья!' };
    }
    if (scores[0] === FIVE130_WIN_MIN && scores[1] === FIVE130_WIN_HIGH) {
      return { draw: false, winner: 0, status: 'Победа!' };
    }
    if (scores[1] === FIVE130_WIN_MIN && scores[0] === FIVE130_WIN_HIGH) {
      return { draw: false, winner: 1, status: 'Победил компьютер' };
    }
    let w;
    if (q0 && !q1) w = 0;
    else if (q1 && !q0) w = 1;
    else w = scores[0] > scores[1] ? 0 : 1;
    return {
      draw: false, winner: w,
      status: w === HUMAN ? 'Победа!' : 'Победил компьютер',
    };
  }

  function applyRoundResult(match, round, delta) {
    match.scores[0] += delta.player0;
    match.scores[1] += delta.player1;
    // §8.2: очки партии могут уходить в минус (списания при рыбе / остатке).
    match.gameIndex++;
    if (round.endReason === 'fish') {
      match.fishNextStarter = true;
      match.fishStarter = round.winner;
    } else if (round.winner >= 0) {
      match.lastWinner = round.winner;
    }

    if (match.gameType === 'five130') {
      const refl = applyFive130Reflection(match.scores, match.overflowCount, match.overflowTotal);
      match.overflowTotal = refl.overflowTotal;
      if (match.overflowTotal >= FIVE130_OVERFLOW_DRAW) {
        match.matchOver = true;
        match.matchDraw = true;
        match.matchWinner = -1;
        match.statusLine = 'Ничья! (10 списаний)';
        return;
      }
      const end = evaluateFive130End(match.scores);
      if (end) {
        match.matchOver = true;
        match.matchDraw = end.draw;
        match.matchWinner = end.winner;
        match.statusLine = end.status;
        return;
      }
    } else if (match.scores[0] >= MATCH_TARGET || match.scores[1] >= MATCH_TARGET) {
      match.matchOver = true;
      if (match.scores[0] === match.scores[1]) {
        match.matchDraw = true;
        match.matchWinner = -1;
        match.statusLine = 'Ничья!';
      } else {
        match.matchWinner = match.scores[0] > match.scores[1] ? 0 : 1;
        match.statusLine = match.matchWinner === HUMAN ? 'Победа!' : 'Победил компьютер';
      }
      return;
    }
    match.statusLine = 'Счёт партии: ' + match.scores[0] + ' : ' + match.scores[1];
  }

  /** Simple AI: prefer scoring moves, then finish, else random among top. */
  function scoreMove(round, move) {
    // simulate lightly: prefer pip%5 and emptying hand
    let s = 0;
    const steps = allPlacings(move);
    if (round.hands[AI].length === steps.length) {
      s += 2000;
      for (let i = 0; i < steps.length; i++) {
        if (steps[i].tile.lo === 6 && steps[i].tile.hi === 6) s += 800;
        if (steps[i].tile.lo === 0 && steps[i].tile.hi === 0) s += 500;
      }
    }
    // heuristic without full clone: doubles +20
    for (let i = 0; i < steps.length; i++) if (steps[i].tile.isDouble) s += 20;
    return s + Math.random() * 5;
  }

  function pickAiMove(round) {
    const moves = legalMoves(round);
    if (!moves.length) return null;
    let best = -1e9;
    const top = [];
    for (let i = 0; i < moves.length; i++) {
      const sc = scoreMove(round, moves[i]);
      if (sc > best + 0.01) { best = sc; top.length = 0; top.push(moves[i]); }
      else if (Math.abs(sc - best) <= 30) top.push(moves[i]);
    }
    return top[Math.floor(Math.random() * top.length)];
  }

  function runAiTurn(match) {
    const round = match.round;
    if (!round || round.roundOver || round.currentPlayer !== AI || match.matchOver) return;
    const moves = legalMoves(round);
    if (moves.length) {
      applyMove(round, pickAiMove(round));
      return;
    }
    if (round.market.length) {
      drawFromMarket(round);
      if (!round.roundOver && round.currentPlayer === AI && legalMoves(round).length) {
        applyMove(round, pickAiMove(round));
      }
      return;
    }
    passTurn(round, 'нет хода');
  }

  /**
   * Раскладка стола без наложений + pip inward/outward.
   * TG v0.001: загибы только vertical→налево (docs/BEND_REQUIREMENTS.md).
   * @param {object} board Доска.
   * @param {object} [opts]
   * @param {number} [opts.maxVertUp] Макс. длина вертикали вверх (клетки) до загиба.
   * @param {number} [opts.maxVertDown] Макс. длина вертикали вниз до загиба.
   * @param {boolean} [opts.bendVerticalCCW=true] Загиб ↺: up→влево, down→вправо (без 2-го загиба).
   * @param {object} [opts.meta] Выход: bendUp/bendDown индексы (−1 = нет).
   * @return {object[]} placed tiles
   */
  function boardSnapshot(board, opts) {
    opts = opts || {};
    const placed = [];
    const meta = opts.meta || {};
    meta.bendUp = -1;
    meta.bendDown = -1;
    if (!board.hasCenter) return placed;

    function sz(horiz) {
      return horiz ? { w: 1.72, h: 0.88 } : { w: 0.88, h: 1.72 };
    }
    const GAP = 0.14;
    const HALF_BODY = 0.22; // tile_w/4 ≈ полкорпуса (§5.4/§5.5)
    const bendCCW = opts.bendVerticalCCW !== false && opts.bendVerticalLeft !== false;
    const maxUp = opts.maxVertUp != null ? opts.maxVertUp : 1e9;
    const maxDown = opts.maxVertDown != null ? opts.maxVertDown : 1e9;

    function orientMain(tile) { return !tile.isDouble; }
    function orientBranch(tile) { return !!tile.isDouble; }
    function otherPip(tile, inward) {
      return tile.lo === inward ? tile.hi : tile.lo;
    }

    function pushTile(tile, player, x, y, horiz, flags, leftOrTop, rightOrBot) {
      placed.push({
        a: leftOrTop,
        b: rightOrBot,
        lo: tile.lo,
        hi: tile.hi,
        human: player === HUMAN,
        horiz: horiz,
        x: x,
        y: y,
        isCenter: !!(flags && flags.isCenter),
        isSpinner: !!(flags && flags.isSpinner),
        bent: !!(flags && flags.bent),
      });
    }

    const cTile = board.center.tile;
    const cHoriz = orientMain(cTile);
    const cSz = sz(cHoriz);
    pushTile(cTile, board.center.player, 0, 0, cHoriz, {
      isCenter: true,
      isSpinner: board.hasSpinner && board.spinnerAtCenter,
    }, cTile.lo, cTile.hi);

    let prevHalf = cSz.w / 2;
    let cursor = 0;
    let prevOpen = cTile.lo;
    for (let i = 0; i < board.mainLeft.tiles.length; i++) {
      const p = board.mainLeft.tiles[i];
      const h = orientMain(p.tile);
      const s = sz(h);
      cursor = cursor - prevHalf - GAP - s.w / 2;
      const inward = prevOpen;
      const outward = otherPip(p.tile, inward);
      const isSp = board.hasSpinner && !board.spinnerAtCenter &&
        board.spinnerArm === EndId.MainLeft && board.spinnerIndex === i;
      pushTile(p.tile, p.player, cursor, 0, h, { isSpinner: isSp }, outward, inward);
      prevOpen = outward;
      prevHalf = s.w / 2;
    }

    prevHalf = cSz.w / 2;
    cursor = 0;
    prevOpen = cTile.hi;
    for (let i = 0; i < board.mainRight.tiles.length; i++) {
      const p = board.mainRight.tiles[i];
      const h = orientMain(p.tile);
      const s = sz(h);
      cursor = cursor + prevHalf + GAP + s.w / 2;
      const inward = prevOpen;
      const outward = otherPip(p.tile, inward);
      const isSp = board.hasSpinner && !board.spinnerAtCenter &&
        board.spinnerArm === EndId.MainRight && board.spinnerIndex === i;
      pushTile(p.tile, p.player, cursor, 0, h, { isSpinner: isSp }, inward, outward);
      prevOpen = outward;
      prevHalf = s.w / 2;
    }

    let sx = 0;
    let sy = 0;
    let spinnerHalfH = cSz.h / 2;
    let spinnerPipVal = board.hasSpinner ? spinnerTile(board).tile.lo : -1;
    if (board.hasSpinner && !board.spinnerAtCenter) {
      for (let i = 0; i < placed.length; i++) {
        if (placed[i].isSpinner) {
          sx = placed[i].x;
          sy = placed[i].y;
          spinnerHalfH = sz(placed[i].horiz).h / 2;
          break;
        }
      }
    }

    /**
     * Ветка вверх/вниз; при превышении maxStraight — хвост налево (TG §4).
     * @param {object[]} tiles
     * @param {boolean} goingUp
     * @param {number} maxStraight
     * @param {string} metaKey 'bendUp'|'bendDown'
     */
    /**
     * Ветка вверх/вниз.
     * Вертикаль: дубль горизонтально, ординар вертикально (§2.1).
     * Первый загиб ↺ только: up→влево, down→вправо (§3.0/§4.3–§4.4).
     * Без повторных загибов. Turn — к боковой половине open-pip (§5.4/§5.5).
     * После гориз. дубля на вертикали ординар продолжает ось (§4.2) либо
     * при загибе идёт сбоку на том же Y (§BEND_REQUIREMENTS).
     */
    function layoutBranch(tiles, goingUp, maxStraight, metaKey) {
      // +1 = вправо (down), −1 = влево (up)
      const sideSign = goingUp ? -1 : 1;
      let mode = 'vert';
      let prevHalfV = spinnerHalfH;
      let cursorY = sy;
      let cursorX = sx;
      let prevOpenLocal = spinnerPipVal;
      let prevW = cSz.w;
      let prevH = cSz.h;
      let prevHoriz = cHoriz;
      let sideHalf = 0;

      for (let i = 0; i < tiles.length; i++) {
        const p = tiles[i];

        if (mode === 'vert') {
          // На вертикальной оси: дубль всегда горизонтальный.
          const horiz = !!p.tile.isDouble;
          const s = sz(horiz);
          const nextY = goingUp
            ? cursorY - prevHalfV - GAP - s.h / 2
            : cursorY + prevHalfV + GAP + s.h / 2;
          const extent = Math.abs(nextY - sy) + s.h / 2;

          if (bendCCW && extent > maxStraight && i > 0) {
            mode = 'side';
            meta[metaKey] = i;
            // L-стык: docs/BEND_TURN_GEOMETRY.md (не «T» на торце).
            const turnHoriz = !p.tile.isDouble;
            const turnSz = sz(turnHoriz);
            if (prevHoriz) {
              // После гориз. дубля на вертикали — сбоку на том же Y.
              cursorY = cursorY;
            } else {
              // Flush: up — верхние края, down — нижние края.
              cursorY = goingUp
                ? (cursorY - prevH / 2 + turnSz.h / 2)
                : (cursorY + prevH / 2 - turnSz.h / 2);
            }
            sideHalf = prevW / 2;
            cursorX = sx;
            // fall through — текущий камень уже боковой
          } else {
            cursorY = nextY;
            const inward = prevOpenLocal;
            const outward = otherPip(p.tile, inward);
            if (!horiz) {
              // вертикальный ординар: a=top, b=bottom
              if (goingUp) pushTile(p.tile, p.player, sx, cursorY, false, {}, outward, inward);
              else pushTile(p.tile, p.player, sx, cursorY, false, {}, inward, outward);
            } else {
              // гориз. дубль на вертикальной оси: a=left, b=right (оба lo)
              pushTile(p.tile, p.player, sx, cursorY, true, {}, p.tile.lo, p.tile.hi);
            }
            prevOpenLocal = outward;
            prevHalfV = s.h / 2;
            prevW = s.w;
            prevH = s.h;
            prevHoriz = horiz;
            continue;
          }
        }

        // mode === 'side': горизонтальный хвост (один загиб, без второго).
        // Ось горизонтальная §2.2: ординар горизонтально, дубль вертикально.
        const horiz = !p.tile.isDouble;
        const s = sz(horiz);
        cursorX = cursorX + sideSign * (sideHalf + GAP + s.w / 2);
        const inward = prevOpenLocal;
        const outward = otherPip(p.tile, inward);
        if (horiz) {
          // ординар влево: left=outward,right=inward; вправо: left=inward,right=outward
          if (sideSign < 0) {
            pushTile(p.tile, p.player, cursorX, cursorY, true, { bent: true }, outward, inward);
          } else {
            pushTile(p.tile, p.player, cursorX, cursorY, true, { bent: true }, inward, outward);
          }
        } else {
          // вертикальный дубль на гориз. хвосте
          pushTile(p.tile, p.player, cursorX, cursorY, false, { bent: true }, p.tile.lo, p.tile.hi);
        }
        prevOpenLocal = outward;
        sideHalf = s.w / 2;
        prevW = s.w;
        prevH = s.h;
        prevHoriz = horiz;
      }
    }

    layoutBranch(board.branchUp.tiles, true, maxUp, 'bendUp');
    layoutBranch(board.branchDown.tiles, false, maxDown, 'bendDown');

    return placed;
  }

  function spinnerLabel(board) {
    if (!board.hasSpinner) return '';
    return spinnerTile(board).tile.label;
  }
  function centerLabel(board) {
    if (!board.hasCenter) return '';
    return board.center.tile.label;
  }

  /** Отладочный дамп партии (ключ=значение + графика). */
  function buildDebugDump(match, extra) {
    const r = match.round;
    const lines = [];
    lines.push('# Five130TG-Debug/1');
    lines.push('# app_version=' + APP_VERSION);
    lines.push('# dumped=' + (new Date()).toISOString());
    lines.push('# seed=' + match.seed);
    lines.push('# game_type=' + match.gameType);
    lines.push('# scores=' + match.scores[0] + ',' + match.scores[1]);
    lines.push('# game_index=' + match.gameIndex);
    lines.push('# match_over=' + (match.matchOver ? 1 : 0));
    lines.push('# status=' + match.statusLine);
    if (r) {
      lines.push('# round_over=' + (r.roundOver ? 1 : 0));
      lines.push('# current=' + r.currentPlayer);
      lines.push('# hands=' + r.hands[0].length + ',' + r.hands[1].length);
      lines.push('# market=' + r.market.length);
      lines.push('# center=' + (r.board.hasCenter ? r.board.center.tile.label : 'empty'));
      lines.push('# spinner=' + (spinnerLabel(r.board) || 'none'));
      const snap = boardSnapshot(r.board);
      lines.push('# snap_count=' + snap.length);
      for (let i = 0; i < snap.length; i++) {
        const t = snap[i];
        lines.push('snap.' + i + '=' + t.a + '|' + t.b +
          ';xy=' + t.x.toFixed(3) + ',' + t.y.toFixed(3) +
          ';horiz=' + (t.horiz ? 1 : 0) +
          ';center=' + (t.isCenter ? 1 : 0) +
          ';spinner=' + (t.isSpinner ? 1 : 0) +
          ';human=' + (t.human ? 1 : 0));
      }
      lines.push('@log');
      for (let i = 0; i < r.actionLog.length; i++) {
        lines.push('log.' + i + '=' + r.actionLog[i].player + ':' + r.actionLog[i].text);
      }
    }
    if (extra) {
      lines.push('@extra');
      Object.keys(extra).forEach(function (k) {
        lines.push(k + '=' + extra[k]);
      });
    }
    return lines.join('\n') + '\n';
  }

  global.Five130Engine = {
    APP_VERSION: APP_VERSION,
    HUMAN: HUMAN,
    AI: AI,
    EndId: EndId,
    EndName: EndName,
    Tile: Tile,
    createMatch: createMatch,
    startRound: startRound,
    legalMoves: legalMoves,
    applyMove: applyMove,
    drawFromMarket: drawFromMarket,
    passTurn: passTurn,
    settleRound: settleRound,
    applyRoundResult: applyRoundResult,
    runAiTurn: runAiTurn,
    pickAiMove: pickAiMove,
    moveLabel: moveLabel,
    samePlacings: samePlacings,
    allPlacings: allPlacings,
    boardSnapshot: boardSnapshot,
    spinnerLabel: spinnerLabel,
    centerLabel: centerLabel,
    scoringEndsPipSum: scoringEndsPipSum,
    leftoverHandPenalty: leftoverHandPenalty,
    buildDebugDump: buildDebugDump,
  };
})(typeof window !== 'undefined' ? window : globalThis);
