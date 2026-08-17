// 티츄 렌더러 — export function render(S) 단일 진입점, 매 호출마다 전량 재그리기.
// overlay-wish는 서버 상태(phase)로 표시되지 않는 순수 로컬 플로우라 app.js가 직접 제어하며,
// 이 파일은 절대 건드리지 않는다.

import { sortHand, classify, beats, playableBombSet, comboName, DOG } from "./rules.js";
import { renderStealthGame } from "./stealth.js";

const el = (id) => document.getElementById(id);
// '님'으로 끝나는 닉네임(과장님 등)에 호칭이 중복 붙는 것 방지
const nim = (nick) => (nick || "").replace(/님$/, "") + "님";
const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };
const SPECIAL_LABEL = { 52: "마작", 53: "개", 54: "봉황", 55: "용" };

const SCREENS = {
  auth: "screen-auth",
  connect: "screen-connect",
  lobby: "screen-lobby",
  game: "screen-game",
};

function rankLabelOf(rank) {
  return RANK_LABEL[rank] || String(rank);
}

function cardEl(c) {
  const div = document.createElement("div");
  div.className = "card-t";
  div.dataset.card = String(c);
  if (c < 52) {
    const suit = Math.floor(c / 13);
    const rank = (c % 13) + 2;
    div.classList.add("su" + suit);
    const span = document.createElement("span");
    span.className = "rank";
    span.textContent = rankLabelOf(rank);
    div.appendChild(span);
  } else {
    div.classList.add("sp");
    div.textContent = SPECIAL_LABEL[c] || "?";
  }
  return div;
}

function lastNonPass(trick) {
  for (let i = trick.length - 1; i >= 0; i--) {
    if (!trick[i].isPass) return trick[i];
  }
  return null;
}

// 지금 이 선택을 내면 서버가 수리하는가 — 내기 버튼 점등 조건.
// (소원 의무는 서버가 최종 강제하므로 여기서는 검사하지 않는다)
function canPlaySelection(S) {
  if (S.game.round.phase !== "play") return false;
  if (S.game.round.pendingDragonSeat != null) return false;
  const sel = S.my.selection;
  if (!sel.length) return false;
  const myTurn = S.game.round.turnSeat === S.my.seat;
  const top = lastNonPass(S.game.trick);
  if (sel.length === 1 && sel[0] === DOG) return myTurn && !top; // 개는 리드 전용
  const info = classify(sel);
  if (!info) return false;
  if (!top) return myTurn;
  const isBombSel = info.type === "bomb4" || info.type === "bombsf";
  if (!myTurn && !isBombSel) return false;
  return beats(sel, top.cards);
}

// 지금 낼 수 있는 폭탄 구성 카드 집합 (트릭이 열려 있으면 차례 밖이어도 가능)
function bombHighlightSet(S) {
  if (S.game.round.phase !== "play" || S.game.round.pendingDragonSeat != null || S.my.seat == null) {
    return new Set();
  }
  const top = lastNonPass(S.game.trick);
  return playableBombSet(S.my.hand, top ? top.cards : null, S.game.round.turnSeat === S.my.seat);
}

export function render(S) {
  showScreen(S.screen);
  if (S.screen === "lobby") renderLobby(S);
  if (S.screen === "game") renderGame(S);
  if (S.screen === "game" && document.body.classList.contains("stealth")) renderStealthGame(S);
}

function showScreen(name) {
  for (const key in SCREENS) {
    const node = el(SCREENS[key]);
    if (node) node.classList.toggle("hidden", key !== name);
  }
  document.body.classList.toggle("in-sheet", name === "game");
}

// ---------- 로비 ----------
function renderLobby(S) {
  el("lobby-code").textContent = S.room.code || "";
  document.querySelectorAll("#lobby-seats .seat").forEach((seatEl) => {
    const seat = Number(seatEl.dataset.seat);
    const occupant = S.room.seats[seat];
    const mine = seat === S.my.seat;
    const nameEl = seatEl.querySelector(".seat-name");
    nameEl.textContent = occupant ? occupant.nickname + (mine ? " (나)" : "") : "빈 자리";
    seatEl.style.borderColor = mine ? "var(--accent)" : "";
  });
  el("btn-start").disabled = S.room.seats.filter(Boolean).length < 4;

  el("set-target").value = String(S.room.targetScore);
  el("set-timer").value = String(S.room.turnSeconds);
  el("set-target").disabled = !S.room.isOwner;
  el("set-timer").disabled = !S.room.isOwner;
  el("settings-owner-hint").classList.toggle("hidden", S.room.isOwner);
}

// ---------- 게임 화면 ----------
// btn-play/pass/tichu는 월루모드 렌더러(stealth.js)가 시트 셀 안으로 재부모화할 수 있어,
// 정상 렌더 때마다 우선 원래 자리(#game-controls)로 되돌려놓는다.
function restoreControlButtons() {
  const controls = el("game-controls");
  ["btn-play", "btn-pass", "btn-tichu"].forEach((id) => {
    const btn = el(id);
    if (btn && btn.parentNode !== controls) controls.appendChild(btn);
  });
}

function renderGame(S) {
  restoreControlButtons();
  renderScoreboard(S);
  renderOpponents(S);
  renderMyTichu(S);
  renderTrick(S);
  renderMyHand(S);
  renderExchangeSlots(S);
  renderControls(S);
  renderGrandOverlay(S);
  renderExchangeOverlay(S);
  renderDragonOverlay(S);
  renderScoreModal(S);
  renderMatchEnd(S);
  renderTurnIndicator(S);
}

function ensureScoreboard() {
  let box = document.getElementById("js-scoreboard");
  if (!box) {
    box = document.createElement("div");
    box.id = "js-scoreboard";
    box.className = "hint";
    const opponents = el("opponents");
    opponents.parentNode.insertBefore(box, opponents);
  }
  return box;
}

function renderScoreboard(S) {
  const box = ensureScoreboard();
  const parts = ["A팀 " + S.game.scoreA + "점", "B팀 " + S.game.scoreB + "점"];
  if (S.game.round.wishRank != null) parts.push("소원: " + rankLabelOf(S.game.round.wishRank));
  box.textContent = parts.join(" · ");
}

function renderOpponents(S) {
  const mySeat = S.my.seat ?? 0;
  const order = [(mySeat + 3) % 4, (mySeat + 2) % 4, (mySeat + 1) % 4]; // 좌/맞은편/우
  const opEls = document.querySelectorAll("#opponents .op");
  opEls.forEach((opEl, i) => {
    const seat = order[i];
    opEl.dataset.seat = String(seat);
    // 차례는 금빛 링으로 표시 (플레이 단계에서만)
    opEl.classList.toggle(
      "turn",
      S.game.round.phase === "play" && S.game.round.turnSeat === seat
    );
    const p = S.game.players[seat];
    opEl.querySelector(".op-name").textContent = p ? p.nickname : "";
    opEl.querySelector(".op-count").textContent = p ? p.handCount + "장" : "";
    const badge = opEl.querySelector(".op-tichu");
    badge.textContent = "";
    badge.className = "op-tichu";
    if (p && p.tichu === 2) {
      badge.textContent = "라지 티츄";
      badge.classList.add("b-grand");
    } else if (p && p.tichu === 1) {
      badge.textContent = "스몰 티츄";
      badge.classList.add("b-tichu");
    }
  });
}

// 내 선언 상태 뱃지 (상대 뱃지는 renderOpponents가 담당)
function renderMyTichu(S) {
  const badge = el("my-tichu");
  const me = S.my.seat != null ? S.game.players[S.my.seat] : null;
  if (!me || !me.tichu) {
    badge.classList.add("hidden");
    return;
  }
  badge.textContent = me.tichu === 2 ? "라지 티츄 선언 중" : "스몰 티츄 선언 중";
  badge.className = me.tichu === 2 ? "my-tichu-badge grand" : "my-tichu-badge";
}

function renderTrick(S) {
  const area = el("trick-area");
  area.innerHTML = "";
  const top = lastNonPass(S.game.trick);
  if (!top) return;
  const wrap = document.createElement("div");
  wrap.className = "trick-play";
  const cardsWrap = document.createElement("div");
  cardsWrap.className = "trick-cards";
  (top.cards || []).forEach((c) => cardsWrap.appendChild(cardEl(c)));
  wrap.appendChild(cardsWrap);
  const caption = document.createElement("div");
  caption.className = "trick-caption";
  const p = S.game.players[top.seat];
  const combo = comboName(top.cards || []);
  caption.textContent =
    (p ? p.nickname : "") + (top.seat === S.my.seat ? " (나)" : "") + (combo ? " · " + combo : "");
  wrap.appendChild(caption);
  area.appendChild(wrap);
}

function isExchangeDone(S) {
  const me = S.game.players[S.my.seat];
  return me ? me.exchangeDone : false;
}

function placeHandInExchangeOverlay(handEl) {
  const card = document.querySelector("#overlay-exchange .card");
  const slots = el("exchange-slots");
  if (card && handEl.parentNode !== card) card.insertBefore(handEl, slots);
}
function placeHandInGameNormal(handEl) {
  const normal = el("game-normal");
  // 정적 마크업 순서(my-hand → sel-combo → game-controls) 복원 — 앵커가 controls면
  // 교환 왕복 후 my-hand가 sel-combo 뒤로 삽입된다
  const anchor = el("sel-combo");
  if (normal && handEl.parentNode !== normal) normal.insertBefore(handEl, anchor);
}

function renderMyHand(S) {
  const handEl = el("my-hand");
  const inExchange = S.game.round.phase === "exchange" && !isExchangeDone(S);
  handEl.innerHTML = "";
  if (inExchange) {
    placeHandInExchangeOverlay(handEl);
    const placed = new Set(Object.values(S.my.exchange).filter((v) => v != null));
    sortHand(S.my.hand.filter((c) => !placed.has(c))).forEach((c) => handEl.appendChild(cardEl(c)));
  } else {
    placeHandInGameNormal(handEl);
    const bombSet = bombHighlightSet(S);
    sortHand(S.my.hand).forEach((c) => {
      const node = cardEl(c);
      if (S.my.selection.includes(c)) node.classList.add("sel");
      if (bombSet.has(c)) node.classList.add("bombable");
      handEl.appendChild(node);
    });
  }
  // 내 차례면 손패 영역에 금빛 글로우
  handEl.classList.toggle(
    "turn",
    S.game.round.phase === "play" && S.game.round.turnSeat === S.my.seat
  );
}

function renderExchangeSlots(S) {
  const mySeat = S.my.seat ?? 0;
  const seatOf = { left: (mySeat + 3) % 4, partner: (mySeat + 2) % 4, right: (mySeat + 1) % 4 };
  const labels = { left: "왼쪽", partner: "파트너", right: "오른쪽" };
  document.querySelectorAll("#exchange-slots .exchange-slot").forEach((slotEl) => {
    const key = slotEl.dataset.target;
    const c = S.my.exchange[key];
    slotEl.innerHTML = "";
    const hint = document.createElement("p");
    hint.className = "hint";
    const p = S.game.players[seatOf[key]];
    hint.textContent = labels[key] + (p ? " · " + p.nickname : "");
    slotEl.appendChild(hint);
    if (c != null) slotEl.appendChild(cardEl(c));
  });
  const filled = Object.values(S.my.exchange).filter((v) => v != null).length;
  el("btn-exchange-ok").textContent = `교환 확정 (${filled}/3)`;
  el("btn-exchange-ok").disabled = filled < 3;
}

function renderControls(S) {
  const myTurn = S.game.round.turnSeat === S.my.seat;
  const trickOpen = !!lastNonPass(S.game.trick);
  el("btn-play").disabled = !canPlaySelection(S);
  el("btn-pass").disabled = !(myTurn && trickOpen && S.game.round.pendingDragonSeat == null);
  // 현재 선택의 조합명 (무효면 안내) — 플레이 단계에서만
  const comboBox = el("sel-combo");
  if (S.game.round.phase === "play" && S.my.selection.length > 0) {
    comboBox.textContent = comboName(S.my.selection) || "유효하지 않은 조합";
    comboBox.classList.remove("hidden");
  } else {
    comboBox.classList.add("hidden");
  }
  const me = S.game.players[S.my.seat];
  // 스몰 티츄는 첫 카드를 내기 전(14장 보유)까지만 — 그 후엔 버튼 자체를 숨긴다
  const canTichu =
    !!me && me.tichu === 0 && S.my.hand.length === 14 && S.game.round.phase !== "grand";
  el("btn-tichu").disabled = !canTichu;
  el("btn-tichu").classList.toggle("hidden", !canTichu);
}

function isGrandDecided(S) {
  const me = S.game.players[S.my.seat];
  return me ? me.grandDecided : false;
}

function renderGrandOverlay(S) {
  const show = S.game.round.phase === "grand" && !isGrandDecided(S);
  el("overlay-grand").classList.toggle("hidden", !show);
  if (show) {
    // 백드롭에 가려지는 판단 근거(점수·상대 선언)를 다이얼로그 안에 표시
    const parts = ["현재 A팀 " + S.game.scoreA + "점 · B팀 " + S.game.scoreB + "점"];
    (S.game.players || []).forEach((p) => {
      if (p.tichu === 2 && p.seat !== S.my.seat) parts.push(p.nickname + " 라지 티츄 선언!");
    });
    el("grand-status").textContent = parts.join(" · ");
    const box = el("grand-hand");
    box.innerHTML = "";
    sortHand(S.my.hand).forEach((c) => box.appendChild(cardEl(c)));
  }
}

function renderDragonOverlay(S) {
  const show = S.my.seat != null && S.game.round.pendingDragonSeat === S.my.seat;
  el("overlay-dragon").classList.toggle("hidden", !show);
}

function renderExchangeOverlay(S) {
  const show = S.game.round.phase === "exchange" && !isExchangeDone(S);
  el("overlay-exchange").classList.toggle("hidden", !show);
}

function renderScoreModal(S) {
  const show =
    S.game.round.phase === "scored" && S.ui.scoreModalDismissedRound !== S.game.roundNo;
  el("score-modal").classList.toggle("hidden", !show);
  if (!show) return;
  const body = el("score-body");
  body.innerHTML = "";
  const line = document.createElement("p");
  line.textContent = "A팀 " + S.game.scoreA + "점 · B팀 " + S.game.scoreB + "점";
  body.appendChild(line);
  (S.game.players || []).forEach((p) => {
    if (!p.tichu) return;
    const row = document.createElement("p");
    const success = S.game.round.outOrder && S.game.round.outOrder[0] === p.seat;
    const label = p.tichu === 2 ? "라지 티츄" : "스몰 티츄";
    row.textContent = p.nickname + ": " + label + " " + (success ? "성공" : "실패");
    body.appendChild(row);
  });
}

function renderMatchEnd(S) {
  const show = S.game.status === "finished";
  el("match-end").classList.toggle("hidden", !show);
  if (!show) return;
  const box = el("match-result");
  box.innerHTML = "";
  const p = document.createElement("p");
  const winner = S.game.winnerTeam === 0 ? "A팀" : S.game.winnerTeam === 1 ? "B팀" : "";
  p.textContent = winner + " 승리! (A " + S.game.scoreA + " : B " + S.game.scoreB + ")";
  box.appendChild(p);
}

function renderTurnIndicator(S) {
  const box = el("turn-indicator-normal");
  if (S.game.status === "finished") {
    box.textContent = "게임 종료";
    return;
  }
  if (S.my.seat != null && S.game.round.pendingDragonSeat === S.my.seat) {
    box.textContent = "용을 상대에게 넘겨주세요.";
    return;
  }
  if (S.game.round.phase === "grand") {
    box.textContent = "라지 티츄를 선언하시겠습니까?";
    return;
  }
  if (S.game.round.phase === "exchange") {
    box.textContent = "교환할 카드 3장을 골라주세요.";
    return;
  }
  const myTurn = S.game.round.turnSeat === S.my.seat;
  const turnPlayer = S.game.players[S.game.round.turnSeat];
  box.textContent = myTurn
    ? "내 차례입니다!"
    : turnPlayer
    ? nim(turnPlayer.nickname) + "의 차례입니다..."
    : "";
}
