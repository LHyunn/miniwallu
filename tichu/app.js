// 티츄 앱 진입점 (라우터/상태/이벤트 핸들러). 렌더는 render.js에 위임.
//
// 가정(중요, sql/schema.sql·rules.js가 아직 없어 이 세션에서 직접 확정한 계약):
// - get_game_state(p_game) 반환 형태:
//   { game:{id,room_id,status,score_a,score_b,round_no,version,winner_team},
//     round:{id,round_no,phase,turn_seat,lead_seat,trick_no,wish_rank,pending_dragon_seat,out_order},
//     players:[{seat,user_id,nickname,hand_count,tichu,grand_decided,exchange_done,taken_points}, x4],
//     trick:[{seat,cards,ctype,power,is_pass}, ...],  // 현재 트릭의 plays
//     hand:{cards,hidden6,received}, events:[...최근 game_events] }
//   tichu 컬럼은 스키마 설계상 0/100/200(그랜드) 스케일로 저장되어 있다고 보고 0/1/2로 정규화한다.
// - join_room(p_code)은 {room_id, seat, rejoined}를 반환(내 좌석을 알아야 하므로 seat 포함을 가정).
// - start_game(p_room)은 game id(uuid)를 직접 반환.
// - play_cards/pass_turn 등 게임 RPC는 호출 성공 직후 get_game_state로 항상 재동기화한다(realtime은
//   다른 플레이어에게 변경을 알리는 용도). game_events의 payload 스키마가 미확정이라, version이
//   앞으로 나아갔다고 판단되면(증분이든 갭이든) 매번 get_game_state 풀 스냅샷으로 반영한다 — 이벤트별
//   부분 반영 프로토콜은 실제 payload 필드가 정해지면 이 지점만 교체하면 되도록 scheduleRefresh()로
//   단일화해두었다.
// - S.game.status/winnerTeam, S.ui.scoreModalDismissedRound는 지시된 S 모양(core)에는 없지만
//   match-end/score-modal 표시에 꼭 필요해 최소한으로 추가한 필드다.

import { sb, rpc, gameChannel, roomPresence, getState, announceGameStart, announceSettings, getRoomStatus, getMyActiveRoom } from "./net.js?v=11";
import { getSession, onAuth, signInGoogle, signInAnon, ensureProfile } from "./auth.js?v=11";
import { classify, wishObliged, MAHJONG } from "./rules.js?v=11";
import { render } from "./render.js?v=11";

const PENDING_NICK_KEY = "tichu-pending-nick";

const el = (id) => document.getElementById(id);

// ---------- 상태 스토어 ----------
const S = {
  session: null,
  profile: null,
  screen: "auth",
  room: {
    id: null,
    code: null,
    seats: [null, null, null, null],
    online: new Set(),
    targetScore: 1000,
    turnSeconds: 0,
    isOwner: false,
  },
  game: {
    id: null,
    version: 0,
    scoreA: 0,
    scoreB: 0,
    roundNo: 0,
    status: null,
    winnerTeam: null,
    turnSeconds: 0,
    round: {
      id: null,
      phase: null,
      turnSeat: null,
      leadSeat: null,
      trickNo: 0,
      wishRank: null,
      pendingDragonSeat: null,
      outOrder: [],
      turnDeadline: null,
    },
    players: [],
    trick: [],
  },
  my: {
    seat: null,
    hand: [],
    hidden6: [],
    received: [],
    selection: [],
    exchange: { left: null, partner: null, right: null },
  },
  log: [],
  ui: { scoreModalDismissedRound: null },
};

let pendingPlaySelection = null;
let roomChannel = null;
let unsubGame = null;

function draw() {
  applyStealthClass();
  render(S);
}

function setError(msg) {
  const text = msg && msg.message ? msg.message : String(msg);
  if (S.screen === "game") el("turn-indicator-normal").textContent = text;
  else if (S.screen === "lobby") el("lobby-status").textContent = text;
  else if (S.screen === "connect") el("connect-status").textContent = text;
  else el("auth-status").textContent = text;
}

// ---------- 테마 ----------
function setTheme(theme) {
  document.body.dataset.theme = theme;
  el("btn-theme").textContent = theme === "dark" ? "☀️" : "🌙";
  localStorage.setItem("tichu-theme", theme);
}
setTheme(localStorage.getItem("tichu-theme") === "dark" ? "dark" : "light");
el("btn-theme").addEventListener("click", () => {
  setTheme(document.body.dataset.theme === "dark" ? "light" : "dark");
});

// ---------- 월루모드 ----------
function setStealth(on) {
  localStorage.setItem("tichu-stealth", on ? "1" : "0");
  document.title = on ? "재고집계.xlsx - Excel" : "티츄";
  el("btn-stealth").textContent = on ? "📊" : "👔";
  el("btn-stealth").title = on ? "월루모드 끄기" : "월루모드 켜기";
  applyStealthClass();
}
function applyStealthClass() {
  const on = localStorage.getItem("tichu-stealth") !== "0";
  document.body.classList.toggle("stealth", on);
}
el("btn-stealth").addEventListener("click", () => {
  setStealth(localStorage.getItem("tichu-stealth") === "0");
  draw();
});
setStealth(localStorage.getItem("tichu-stealth") !== "0");

// ---------- 인증 ----------
async function handleSession(session) {
  if (!session) {
    S.session = null;
    S.profile = null;
    S.screen = "auth";
    draw();
    return;
  }
  S.session = session;
  const pending = sessionStorage.getItem(PENDING_NICK_KEY);
  if (pending) {
    sessionStorage.removeItem(PENDING_NICK_KEY);
    try {
      const row = await ensureProfile(pending);
      S.profile = { nickname: (row && row.nickname) || pending };
    } catch (e) {
      setError(e);
    }
  }
  if (!S.profile) {
    try {
      const { data } = await sb
        .from("profiles")
        .select("nickname")
        .eq("user_id", session.user.id)
        .maybeSingle();
      if (data) S.profile = { nickname: data.nickname };
    } catch (e) {
      /* 무시 - 닉네임 입력 대기 */
    }
  }
  S.screen = S.profile ? "connect" : "auth";
  draw();
  if (S.profile) checkResume();
}

async function submitAuth(kind) {
  const nickname = el("nickname-input").value.trim();
  if (!nickname) {
    setError("닉네임을 입력해주세요.");
    return;
  }
  try {
    if (!S.session) {
      if (kind === "google") {
        sessionStorage.setItem(PENDING_NICK_KEY, nickname);
        await signInGoogle();
        return; // 리다이렉트됨
      }
      const { data, error } = await signInAnon();
      if (error) throw error;
      S.session = data.session;
    }
    const row = await ensureProfile(nickname);
    S.profile = { nickname: (row && row.nickname) || nickname };
    S.screen = "connect";
    draw();
    checkResume();
  } catch (err) {
    setError(err);
  }
}
el("btn-google").addEventListener("click", () => submitAuth("google"));
el("btn-anon").addEventListener("click", () => submitAuth("anon"));

// ---------- 연결(방 만들기/입장) ----------
el("btn-create").addEventListener("click", async () => {
  try {
    const res = await rpc("create_room", {});
    S.room.id = res.room_id;
    S.room.code = res.code;
    S.my.seat = 0;
    S.room.isOwner = true;
    S.room.targetScore = 1000;
    S.room.turnSeconds = 0;
    el("room-code").textContent = res.code;
    el("create-result").classList.remove("hidden");
    S.screen = "lobby";
    subscribeRoomPresence();
    draw();
  } catch (err) {
    setError(err);
  }
});

el("join-code").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase();
});

// ---------- 이어하기 (진행 중인 방으로 복귀) ----------
let resumeTarget = null;

async function checkResume() {
  const area = el("resume-area");
  try {
    resumeTarget = S.session ? await getMyActiveRoom(S.session.user.id) : null;
  } catch (e) {
    resumeTarget = null;
  }
  if (!resumeTarget) {
    area.classList.add("hidden");
    return;
  }
  el("resume-info").textContent =
    resumeTarget.status === "playing"
      ? `방 ${resumeTarget.code} · 게임이 진행 중입니다`
      : `방 ${resumeTarget.code} · 대기실에서 기다리는 중입니다`;
  area.classList.remove("hidden");
}

el("btn-resume").addEventListener("click", async () => {
  if (!resumeTarget) return;
  try {
    S.room.id = resumeTarget.roomId;
    S.room.code = resumeTarget.code;
    S.my.seat = resumeTarget.seat;
    const room = await getRoomStatus(resumeTarget.roomId);
    S.room.isOwner = !!(S.session && room.created_by === S.session.user.id);
    S.room.targetScore = room.target_score ?? 1000;
    S.room.turnSeconds = room.turn_seconds ?? 0;
    if (room.status === "playing" && room.current_game_id) {
      await enterGame(room.current_game_id);
      return;
    }
    S.screen = "lobby";
    subscribeRoomPresence();
    draw();
  } catch (err) {
    setError(err);
  }
});

el("btn-join").addEventListener("click", async () => {
  const code = el("join-code").value.trim();
  if (code.length !== 4) {
    setError("코드 4자리를 입력해주세요.");
    return;
  }
  try {
    const res = await rpc("join_room", { p_code: code });
    S.room.id = res.room_id;
    S.room.code = code;
    S.my.seat = res.seat ?? 0;
    const room = await getRoomStatus(res.room_id);
    // 방장 여부는 좌석이 아니라 생성자 기준 (재입장해도 유지)
    S.room.isOwner = !!(S.session && room.created_by === S.session.user.id);
    S.room.targetScore = room.target_score ?? 1000;
    S.room.turnSeconds = room.turn_seconds ?? 0;
    // 재입장인데 이미 게임 중이면 바로 게임으로 복귀
    if (res.rejoined && room.status === "playing" && room.current_game_id) {
      await enterGame(room.current_game_id);
      return;
    }
    S.screen = "lobby";
    subscribeRoomPresence();
    draw();
  } catch (err) {
    setError(err);
  }
});

// ---------- 로비 ----------
function subscribeRoomPresence() {
  const nickname = (S.profile && S.profile.nickname) || "";
  roomChannel = roomPresence(
    S.room.id,
    { seat: S.my.seat, nickname },
    (state) => {
      const seats = [null, null, null, null];
      const online = new Set();
      Object.values(state).forEach((entries) => {
        entries.forEach((e) => {
          if (typeof e.seat === "number" && e.seat >= 0 && e.seat < 4) {
            seats[e.seat] = { nickname: e.nickname };
            online.add(e.seat);
          }
        });
      });
      S.room.seats = seats;
      S.room.online = online;
      draw();
    },
    (payload) => {
      // 다른 멤버가 게임을 시작함
      if (payload && payload.gameId) enterGame(payload.gameId);
    },
    (payload) => {
      // 방장이 설정을 변경함
      if (!payload) return;
      if (typeof payload.target === "number") S.room.targetScore = payload.target;
      if (typeof payload.seconds === "number") S.room.turnSeconds = payload.seconds;
      draw();
    }
  );
}

async function enterGame(gameId) {
  unsubscribeRoomPresence();
  S.game.id = gameId;
  S.screen = "game";
  subscribeGame();
  await refreshGameState();
  draw();
}
function unsubscribeRoomPresence() {
  if (roomChannel) {
    roomChannel.unsubscribe();
    roomChannel = null;
  }
}

el("lobby-seats").addEventListener("click", async (e) => {
  const seatEl = e.target.closest(".seat");
  if (!seatEl) return;
  const seat = Number(seatEl.dataset.seat);
  if (S.room.seats[seat]) return;
  try {
    await rpc("switch_seat", { p_room: S.room.id, p_seat: seat });
    S.my.seat = seat;
    if (roomChannel) {
      await roomChannel.track({ seat, nickname: (S.profile && S.profile.nickname) || "" });
    }
  } catch (err) {
    setError(err);
  }
});

el("btn-start").addEventListener("click", async () => {
  try {
    const gameId = await rpc("start_game", { p_room: S.room.id });
    // 다른 멤버들에게 게임 시작 알림 후 입장
    if (roomChannel) await announceGameStart(roomChannel, gameId);
    await enterGame(gameId);
  } catch (err) {
    setError(err);
  }
});

async function updateRoomSettings(target, seconds) {
  try {
    await rpc("set_room_settings", { p_room: S.room.id, p_target: target, p_turn_seconds: seconds });
    S.room.targetScore = target;
    S.room.turnSeconds = seconds;
    if (roomChannel) await announceSettings(roomChannel, { target, seconds });
    draw();
  } catch (err) {
    setError(err);
    draw();
  }
}
el("set-target").addEventListener("change", (e) => {
  updateRoomSettings(Number(e.target.value), S.room.turnSeconds);
});
el("set-timer").addEventListener("change", (e) => {
  updateRoomSettings(S.room.targetScore, Number(e.target.value));
});

// ---------- 게임 동기화 ----------
function applySnapshot(raw) {
  const g = raw.game || {};
  const r = raw.round || {};
  const prevRoundId = S.game.round.id;
  S.game.id = g.id ?? S.game.id;
  S.game.version = g.version ?? S.game.version;
  S.game.scoreA = g.score_a ?? 0;
  S.game.scoreB = g.score_b ?? 0;
  S.game.roundNo = g.round_no ?? S.game.roundNo;
  S.game.status = g.status ?? null;
  S.game.winnerTeam = g.winner_team ?? null;
  S.game.turnSeconds = g.turn_seconds ?? 0;
  S.game.round = {
    id: r.id ?? null,
    phase: r.phase ?? null,
    turnSeat: r.turn_seat ?? null,
    leadSeat: r.lead_seat ?? null,
    trickNo: r.trick_no ?? 0,
    wishRank: r.wish_rank ?? null,
    pendingDragonSeat: r.pending_dragon_seat ?? null,
    outOrder: r.out_order ?? [],
    turnDeadline: r.turn_deadline ?? null,
  };
  S.game.players = (raw.players || [])
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((p) => ({
      seat: p.seat,
      userId: p.user_id,
      nickname: p.nickname,
      handCount: p.hand_count,
      tichu: p.tichu === 200 ? 2 : p.tichu === 100 ? 1 : 0,
      grandDecided: !!p.grand_decided,
      exchangeDone: !!p.exchange_done,
      takenPoints: p.taken_points,
    }));
  S.game.trick = (raw.trick || []).map((p) => ({
    seat: p.seat,
    cards: p.cards,
    ctype: p.ctype,
    power: p.power,
    isPass: !!p.is_pass,
  }));
  const me = S.game.players.find((p) => S.session && p.userId === S.session.user.id);
  if (me) S.my.seat = me.seat;
  const h = raw.hand || {};
  S.my.hand = h.cards || [];
  S.my.hidden6 = h.hidden6 || [];
  S.my.received = h.received || [];
  if (S.game.round.id !== prevRoundId) {
    S.my.selection = [];
    S.my.exchange = { left: null, partner: null, right: null };
    S.ui.scoreModalDismissedRound = null;
  }
  (raw.events || []).forEach((ev) => S.log.push(ev));
}

// setTimeout 디바운스는 백그라운드 탭에서 스로틀되어 갱신이 늦어지므로
// "진행 중이면 1건만 큐잉"하는 플래그 방식으로 즉시 실행한다.
let refreshBusy = false;
let refreshQueued = false;

async function refreshGameState() {
  if (!S.game.id) return;
  if (refreshBusy) {
    refreshQueued = true;
    return;
  }
  refreshBusy = true;
  try {
    const raw = await getState(S.game.id);
    applySnapshot(raw);
    draw();
  } catch (e) {
    setError(e);
  } finally {
    refreshBusy = false;
    if (refreshQueued) {
      refreshQueued = false;
      refreshGameState();
    }
  }
}

function scheduleRefresh() {
  refreshGameState();
}

function subscribeGame() {
  unsubGame = gameChannel(S.game.id, {
    onGameUpdate(row) {
      if ((row.version ?? 0) > S.game.version) scheduleRefresh();
    },
    onEvent(row) {
      S.log.push(row);
      if ((row.version ?? 0) > S.game.version) scheduleRefresh();
    },
    onHand(row) {
      if (S.session && row.user_id === S.session.user.id) {
        S.my.hand = row.cards || [];
        S.my.hidden6 = row.hidden6 || [];
        S.my.received = row.received || [];
        draw();
      }
    },
  });
}
function unsubscribeGame() {
  if (unsubGame) {
    unsubGame.unsubscribe();
    unsubGame = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  checkForUpdate();
  if (S.screen === "game") refreshGameState();
});

// ---------- 턴 타이머 ----------
let timeoutAttempt = null; // { key, retried } — round.id+deadline 조합당 한 번만 자동 시도

function updateTurnTimer() {
  const box = el("turn-timer");
  if (!box) return;
  const dl = S.game.round.turnDeadline;
  if (S.screen !== "game" || S.game.status === "finished" || S.game.round.phase !== "play" || !dl) {
    box.classList.add("hidden");
    return;
  }
  const ms = new Date(dl).getTime() - Date.now();
  box.classList.remove("hidden");
  box.textContent = Math.max(0, Math.ceil(ms / 1000)) + "초";
  if (ms < -2000) tryForceTimeout();
}
setInterval(updateTurnTimer, 1000);

function tryForceTimeout() {
  const round = S.game.round;
  const key = round.id + "|" + round.turnDeadline;
  if (timeoutAttempt && timeoutAttempt.key === key) return;
  timeoutAttempt = { key, retried: false };
  attemptForceTimeout(round.id, key);
}

async function attemptForceTimeout(roundId, key) {
  try {
    await rpc("force_timeout", { p_round: roundId });
  } catch (e) {
    if (timeoutAttempt && timeoutAttempt.key === key && !timeoutAttempt.retried) {
      timeoutAttempt.retried = true;
      setTimeout(() => {
        if (timeoutAttempt && timeoutAttempt.key === key) attemptForceTimeout(roundId, key);
      }, 5000);
    }
  }
}

// ---------- 손패 선택 / 교환 슬롯 ----------
function toggleCardSelection(c) {
  if (S.game.round.phase === "exchange") {
    const order = ["left", "partner", "right"];
    const slot = order.find((k) => S.my.exchange[k] == null);
    if (slot) {
      S.my.exchange[slot] = c;
      draw();
    }
  } else {
    const i = S.my.selection.indexOf(c);
    if (i >= 0) S.my.selection.splice(i, 1);
    else S.my.selection.push(c);
    draw();
  }
}

el("my-hand").addEventListener("click", (e) => {
  const cardEl = e.target.closest(".card-t");
  if (!cardEl) return;
  toggleCardSelection(Number(cardEl.dataset.card));
});

window.addEventListener("stealth-card-toggle", (e) => {
  toggleCardSelection(e.detail.card);
});

el("exchange-slots").addEventListener("click", (e) => {
  const slotEl = e.target.closest(".exchange-slot");
  if (!slotEl) return;
  const key = slotEl.dataset.target;
  if (S.my.exchange[key] != null) {
    S.my.exchange[key] = null;
    draw();
  }
});

el("btn-exchange-ok").addEventListener("click", async () => {
  const { left, partner, right } = S.my.exchange;
  if (left == null || partner == null || right == null) return;
  try {
    await rpc("submit_exchange", {
      p_round: S.game.round.id,
      p_left: left,
      p_partner: partner,
      p_right: right,
    });
    S.my.exchange = { left: null, partner: null, right: null };
    await refreshGameState();
  } catch (err) {
    setError(err);
  }
});

// ---------- 그랜드 티츄 ----------
async function decideGrand(call) {
  try {
    await rpc("decide_grand", { p_round: S.game.round.id, p_call: call });
    await refreshGameState();
  } catch (err) {
    setError(err);
  }
}
el("btn-grand-yes").addEventListener("click", () => decideGrand(true));
el("btn-grand-no").addEventListener("click", () => decideGrand(false));
el("btn-grand-close").addEventListener("click", () => decideGrand(false)); // 다이얼로그 ✕ = 선언 안 함

// ---------- 티츄 ----------
el("btn-tichu").addEventListener("click", async () => {
  try {
    await rpc("call_tichu", { p_round: S.game.round.id });
    await refreshGameState();
  } catch (err) {
    setError(err);
  }
});

// ---------- 용 상납 ----------
async function giftDragon(seat) {
  try {
    await rpc("gift_dragon", { p_round: S.game.round.id, p_to_seat: seat });
    await refreshGameState();
  } catch (err) {
    setError(err);
  }
}
el("btn-dragon-left").addEventListener("click", () => giftDragon((S.my.seat + 3) % 4));
el("btn-dragon-right").addEventListener("click", () => giftDragon((S.my.seat + 1) % 4));

// ---------- 내기 / 소원 / 패스 ----------
function currentTopPlay() {
  const trick = S.game.trick;
  for (let i = trick.length - 1; i >= 0; i--) {
    if (!trick[i].isPass) return trick[i];
  }
  return null;
}

async function submitPlay(cards, wish) {
  try {
    await rpc("play_cards", { p_round: S.game.round.id, p_cards: cards, p_wish: wish });
    S.my.selection = [];
    await refreshGameState();
  } catch (err) {
    setError(err);
  }
}

function openWishOverlay(sel) {
  pendingPlaySelection = sel;
  const box = el("wish-buttons");
  box.innerHTML = "";
  const labels = { 11: "J", 12: "Q", 13: "K", 14: "A" };
  for (let rank = 2; rank <= 14; rank++) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = labels[rank] || String(rank);
    b.addEventListener("click", () => {
      const sel2 = pendingPlaySelection;
      closeWishOverlay();
      submitPlay(sel2, rank);
    });
    box.appendChild(b);
  }
  el("overlay-wish").classList.remove("hidden");
}
function closeWishOverlay() {
  el("overlay-wish").classList.add("hidden");
  pendingPlaySelection = null;
}
el("btn-wish-skip").addEventListener("click", () => {
  const sel = pendingPlaySelection;
  closeWishOverlay();
  submitPlay(sel, null);
});

el("btn-play").addEventListener("click", () => {
  const sel = S.my.selection.slice();
  if (!sel.length) return;
  // 개(53)는 classify가 null을 반환하는 특수 카드 — 단독 리드만 합법 (서버가 검증)
  const isDogLead = sel.length === 1 && sel[0] === 53;
  if (isDogLead) {
    if (currentTopPlay()) {
      setError("개는 리드할 때만 낼 수 있습니다.");
      return;
    }
    submitPlay(sel, null);
    return;
  }
  const info = classify(sel);
  if (!info) {
    setError("유효한 조합이 아닙니다.");
    return;
  }
  if (sel.includes(MAHJONG)) openWishOverlay(sel);
  else submitPlay(sel, null);
});

el("btn-pass").addEventListener("click", async () => {
  const top = currentTopPlay();
  if (S.game.round.wishRank != null) {
    const topCards = top ? top.cards : null;
    if (wishObliged(S.my.hand, topCards, S.game.round.wishRank)) {
      setError("소원을 충족하는 패를 내야 합니다.");
      return;
    }
  }
  try {
    await rpc("pass_turn", { p_round: S.game.round.id });
    await refreshGameState();
  } catch (err) {
    setError(err);
  }
});

// ---------- 라운드/매치 종료 ----------
el("btn-next-round").addEventListener("click", async () => {
  S.ui.scoreModalDismissedRound = S.game.roundNo;
  draw();
  if (S.game.status !== "finished") {
    // 다음 라운드는 서버에 명시적으로 요청 (동시 클릭은 서버가 직렬화 — 실패 무시)
    try {
      await rpc("next_round", { p_game: S.game.id });
    } catch (e) {
      /* 이미 다른 멤버가 시작함 */
    }
  }
});

el("btn-back-lobby").addEventListener("click", () => {
  unsubscribeGame();
  S.room = {
    id: null,
    code: null,
    seats: [null, null, null, null],
    online: new Set(),
    targetScore: 1000,
    turnSeconds: 0,
    isOwner: false,
  };
  S.game = {
    id: null,
    version: 0,
    scoreA: 0,
    scoreB: 0,
    roundNo: 0,
    status: null,
    winnerTeam: null,
    turnSeconds: 0,
    round: {
      id: null,
      phase: null,
      turnSeat: null,
      leadSeat: null,
      trickNo: 0,
      wishRank: null,
      pendingDragonSeat: null,
      outOrder: [],
      turnDeadline: null,
    },
    players: [],
    trick: [],
  };
  S.my = {
    seat: null,
    hand: [],
    hidden6: [],
    received: [],
    selection: [],
    exchange: { left: null, partner: null, right: null },
  };
  S.ui.scoreModalDismissedRound = null;
  timeoutAttempt = null;
  S.screen = "connect";
  draw();
});

// ---------- 부팅 ----------
async function boot() {
  const { data } = await getSession();
  await handleSession(data.session);
  onAuth((_event, session) => {
    if (session && (!S.session || session.user.id !== S.session.user.id)) handleSession(session);
    if (!session && S.session) handleSession(null);
  });
}
draw();
boot();

// ---------- 새 버전 감지 ----------
const APP_VERSION = 11;
function reloadForUpdate() {
  location.replace(location.pathname + "?u=" + Date.now());
}
function checkForUpdate() {
  fetch("version.json?ts=" + Date.now(), { cache: "no-store" })
    .then((r) => r.json())
    .then((v) => {
      const info = el("build-info");
      if (info && v.updated) info.textContent = "마지막 업데이트: " + v.updated;
      if (v.version === APP_VERSION) return;
      const idle = S.screen === "auth" || S.screen === "connect";
      const alreadyTried = sessionStorage.getItem("tichu-reloaded") === String(v.version);
      if (idle && !alreadyTried) {
        sessionStorage.setItem("tichu-reloaded", String(v.version));
        reloadForUpdate();
      } else {
        el("update-notice").classList.remove("hidden");
      }
    })
    .catch(() => {});
}
el("btn-update").addEventListener("click", reloadForUpdate);
checkForUpdate();
setInterval(checkForUpdate, 5 * 60 * 1000);
