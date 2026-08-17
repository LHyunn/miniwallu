// 오목 — Supabase 서버 권위판(렌주룰). 동기화는 티츄/야구와 동일한 버전-갭 스냅샷:
// 모든 변경 RPC가 games.version을 올리고(_emit), 클라이언트는 구독 이벤트에서
// 버전이 앞서면 get_omok_state 풀 스냅샷으로 전량 재그리기한다.
// rules.js는 서버(_ob_*)와 패리티 검증된 같은 판정 — 금수 미리보기(UX)에만 쓴다.
import { sb, rpc, gameChannel, roomPresence, announceGameStart, announceSettings, getRoomStatus, getMyActiveRoom } from "/assets/js/supabase.js";
import { requireAuth } from "/assets/js/auth.js";
import { applyPrefs, initPrefsUI } from "/assets/js/prefs.js";
import { startVersionWatch } from "/assets/js/version.js";
import { mountChrome } from "/assets/js/chrome.js";
import { SIZE, BLACK, isForbidden } from "./rules.js";
import { renderStealthGame } from "./stealth.js";

const el = (id) => document.getElementById(id);

// ---------- 상태 ----------
const S = {
  session: null,
  profile: null,
  screen: "connect",
  room: { id: null, code: null, online: {}, target: 2, isOwner: false },
  game: {
    id: null,
    version: 0,
    status: null,
    scoreA: 0,
    scoreB: 0,
    roundNo: 0,
    winnerTeam: null,
    target: 2,
    rematchSeats: [],
  },
  board: {
    id: null,
    boardNo: 0,
    status: null,
    blackSeat: null,
    turnSeat: null,
    cells: [], // 15x15 2차원 (스냅샷의 1차원 배열에서 변환)
    winnerSeat: null,
    winReason: null,
    winLine: [], // 1-based 평면 인덱스 배열
    turnDeadline: null,
  },
  players: [],
  moves: [], // [{seq, seat, color, r, c}]
  my: { seat: null },
};

let roomChannel = null;
let unsubGame = null;

function setError(msg) {
  const text = msg && msg.message ? msg.message : String(msg);
  if (S.screen === "game") el("status-line").textContent = text;
  else if (S.screen === "lobby") el("lobby-status").textContent = text;
  else el("connect-status").textContent = text;
}

function nickOf(seat) {
  const p = S.players.find((p) => p.seat === seat);
  return p ? p.nickname : "?";
}

// 내 돌 색 (1=흑, 2=백). 판이 없으면 0.
function myColor() {
  if (S.my.seat == null || S.board.blackSeat == null) return 0;
  return S.my.seat === S.board.blackSeat ? 1 : 2;
}

function lastMove() {
  return S.moves.length ? S.moves[S.moves.length - 1] : null;
}

// ---------- 렌더 ----------
const SCREENS = { connect: "screen-connect", lobby: "screen-lobby", game: "screen-game" };

function draw() {
  applyPrefs();
  for (const key in SCREENS) {
    el(SCREENS[key]).classList.toggle("hidden", key !== S.screen);
  }
  document.body.classList.toggle("in-sheet", S.screen === "game");
  if (S.screen === "lobby") drawLobby();
  if (S.screen === "game") {
    drawGame();
    if (document.body.classList.contains("stealth")) renderStealthGame(S);
  }
}

function drawLobby() {
  el("lobby-code").textContent = S.room.code || "";
  document.querySelectorAll("#lobby-seats .seat").forEach((seatEl) => {
    const seat = Number(seatEl.dataset.seat);
    const nick = S.room.online[seat];
    seatEl.querySelector(".seat-name").textContent = nick || "빈 자리";
    seatEl.classList.toggle("filled", !!nick);
    seatEl.classList.toggle("me", seat === S.my.seat);
  });
  el("btn-start").disabled = Object.keys(S.room.online).length < 2;
  el("set-target").value = String(S.room.target);
  el("set-target").disabled = !S.room.isOwner;
  el("settings-owner-hint").classList.toggle("hidden", S.room.isOwner);
}

// 게임 문구 — 일반/월루 시트가 같은 텍스트를 쓴다 (stealth.js에 같은 로직 복제)
function statusText() {
  const b = S.board;
  if (S.game.status === "finished") return "게임 종료";
  if (b.status === "finished") {
    const why = b.winReason === "timeout" ? " (시간 초과)" : "";
    return `${nickOf(b.winnerSeat)} 승리${why} · 다음 판을 기다립니다`;
  }
  if (b.status === "playing") {
    const stone = myColor() === BLACK ? "⚫ 흑" : "⚪ 백";
    return b.turnSeat === S.my.seat ? `내 차례입니다! (${stone})` : `${nickOf(b.turnSeat)}의 차례입니다... (나: ${stone})`;
  }
  return "";
}

let normalCells = []; // 일반 모드 판 div 15x15

function initNormalBoard() {
  const boardEl = el("board");
  boardEl.innerHTML = "";
  normalCells = [];
  for (let r = 0; r < SIZE; r++) {
    const rowRefs = [];
    for (let c = 0; c < SIZE; c++) {
      const div = document.createElement("div");
      div.className = "bd-cell";
      div.dataset.r = r;
      div.dataset.c = c;
      boardEl.appendChild(div);
      rowRefs.push(div);
    }
    normalCells.push(rowRefs);
  }
}

function drawGame() {
  const b = S.board;
  const g = S.game;

  el("scoreline").innerHTML = "";
  const score = document.createElement("span");
  score.append(
    nickOf(0) + " ", Object.assign(document.createElement("b"), { textContent: g.scoreA }),
    " : ", Object.assign(document.createElement("b"), { textContent: g.scoreB }),
    ` ${nickOf(1)} · ${g.target}선승 · ${b.boardNo}판째`
  );
  el("scoreline").appendChild(score);

  const status = el("status-line");
  status.textContent = statusText();
  status.classList.toggle("turn", b.status === "playing" && b.turnSeat === S.my.seat);

  // 판
  const last = lastMove();
  const winKey = new Set(b.winLine || []);
  const showForbid = b.status === "playing" && b.turnSeat === S.my.seat && myColor() === BLACK;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const d = normalCells[r][c];
      d.className = "bd-cell";
      const v = b.cells[r] ? b.cells[r][c] : 0;
      if (v) {
        d.classList.add(v === BLACK ? "s1" : "s2");
        if (last && last.r === r && last.c === c) d.classList.add("last");
        if (winKey.has(r * SIZE + c + 1)) d.classList.add("win");
      } else if (showForbid && isForbidden(b.cells, r, c)) {
        d.classList.add("forbid");
      }
    }
  }

  // 판 종료 오버레이 (매치는 계속)
  const boardOver = b.status === "finished" && g.status === "playing";
  el("board-end").classList.toggle("hidden", !boardOver);
  if (boardOver) {
    const iWon = b.winnerSeat === S.my.seat;
    el("board-end-title").textContent = iWon ? "이겼습니다!" : `${nickOf(b.winnerSeat)} 승리`;
    const body = el("board-end-body");
    body.innerHTML = "";
    if (b.winReason === "timeout") {
      const p = document.createElement("p");
      p.textContent = "시간 초과";
      body.appendChild(p);
    }
    const score = document.createElement("p");
    score.textContent = `${g.scoreA} : ${g.scoreB} (${g.target}선승) · 다음 판은 흑백 교대`;
    body.appendChild(score);
    const voted = g.rematchSeats.includes(S.my.seat);
    el("btn-next-board").classList.toggle("hidden", voted);
    el("next-wait").classList.toggle("hidden", !voted);
  }

  // 매치 종료 오버레이
  const matchOver = g.status === "finished";
  el("match-end").classList.toggle("hidden", !matchOver);
  if (matchOver) {
    const box = el("match-result");
    box.innerHTML = "";
    const big = document.createElement("div");
    big.className = "big";
    big.textContent = `${nickOf(g.winnerTeam)} 승리!`;
    const line = document.createElement("p");
    line.textContent = `${nickOf(0)} ${g.scoreA} : ${g.scoreB} ${nickOf(1)}`;
    box.append(big, line);
  }
}

// ---------- 동기화 ----------
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
    const raw = await rpc("get_omok_state", { p_game: S.game.id });
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

function applySnapshot(raw) {
  const g = raw.game || {};
  S.game.version = g.version ?? 0;
  S.game.status = g.status;
  S.game.scoreA = g.score_a ?? 0;
  S.game.scoreB = g.score_b ?? 0;
  S.game.roundNo = g.round_no ?? 0;
  S.game.winnerTeam = g.winner_team;
  S.game.rematchSeats = g.rematch_seats || [];
  S.game.target = (raw.settings && raw.settings.target_score) ?? 2;
  const b = raw.board || {};
  const flat = b.cells || [];
  const cells = [];
  for (let r = 0; r < SIZE; r++) cells.push(flat.slice(r * SIZE, r * SIZE + SIZE));
  S.board = {
    id: b.id,
    boardNo: b.board_no ?? 0,
    status: b.status,
    blackSeat: b.black_seat,
    turnSeat: b.turn_seat,
    cells,
    winnerSeat: b.winner_seat,
    winReason: b.win_reason,
    winLine: b.win_line || [],
    turnDeadline: b.turn_deadline ? new Date(b.turn_deadline) : null,
  };
  S.players = raw.players || [];
  S.moves = raw.moves || [];
  const me = S.players.find((p) => p.user_id === S.session.user.id);
  S.my.seat = me ? me.seat : null;
}

function subscribeGame() {
  unsubGame = gameChannel(S.game.id, {
    onGameUpdate(row) {
      if ((row.version ?? 0) > S.game.version) refreshGameState();
    },
    onEvent(row) {
      if ((row.version ?? 0) > S.game.version) refreshGameState();
    },
  });
}

function unsubscribeGame() {
  if (unsubGame) {
    unsubGame.unsubscribe();
    unsubGame = null;
  }
}

async function enterGame(gameId) {
  S.game.id = gameId;
  S.screen = "game";
  subscribeGame();
  await refreshGameState();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S.screen === "game") refreshGameState();
});

// 턴 시계(설정 시): 데드라인이 지나면 아무 멤버나 서버에 판정을 요청한다.
setInterval(() => {
  const b = S.board;
  if (S.screen !== "game" || b.status !== "playing" || !b.turnDeadline) return;
  if (Date.now() > b.turnDeadline.getTime() + 500) {
    b.turnDeadline = null; // 중복 호출 방지 (실패해도 다음 스냅샷이 복원)
    rpc("omok_timeout", { p_board: b.id }).catch(() => refreshGameState());
  }
}, 1000);

// ---------- 착수 ----------
async function tryPlace(r, c) {
  const b = S.board;
  if (b.status !== "playing" || b.turnSeat !== S.my.seat) return;
  if (b.cells[r][c] !== 0) return;
  try {
    await rpc("place_stone", { p_board: b.id, p_r: r, p_c: c });
    await refreshGameState();
  } catch (err) {
    setError(err); // "금수(삼삼)" 등 — 턴은 소모되지 않는다
    const stCell = document.querySelector("#sheet-grid .xl-status-cell");
    if (stCell) stCell.textContent = (err && err.message) || String(err);
  }
}

el("board").addEventListener("click", (e) => {
  const d = e.target.closest(".bd-cell");
  if (!d) return;
  tryPlace(parseInt(d.dataset.r, 10), parseInt(d.dataset.c, 10));
});

// 월루 시트의 판 셀 클릭 (stealth.js가 data-r/c를 심는다)
document.addEventListener("click", (e) => {
  if (!document.body.classList.contains("stealth") || S.screen !== "game") return;
  const td = e.target.closest("#sheet-grid td");
  if (!td || td.dataset.r === undefined) return;
  tryPlace(parseInt(td.dataset.r, 10), parseInt(td.dataset.c, 10));
});

// ---------- 방/로비 ----------
async function loadRoomSettings() {
  const { data } = await sb.from("rooms").select("target_score, created_by").eq("id", S.room.id).single();
  if (data) {
    S.room.target = data.target_score;
    S.room.isOwner = data.created_by === S.session.user.id;
  }
}

function subscribeRoomPresence() {
  if (roomChannel) sb.removeChannel(roomChannel);
  roomChannel = roomPresence(
    S.room.id,
    { seat: S.my.seat, nickname: S.profile.nickname },
    (state) => {
      S.room.online = {};
      Object.values(state).forEach((metas) =>
        metas.forEach((m) => {
          if (m.seat != null) S.room.online[m.seat] = m.nickname;
        })
      );
      draw();
    },
    (payload) => {
      if (payload && payload.gameId) enterGame(payload.gameId);
    },
    (settings) => {
      if (settings.target) S.room.target = settings.target;
      draw();
    }
  );
}

el("btn-create").addEventListener("click", async () => {
  try {
    const res = await rpc("create_room", { p_game_type: "omok" });
    S.room.id = res.room_id;
    S.room.code = res.code;
    S.my.seat = 0;
    S.room.isOwner = true;
    S.room.target = 2;
    await rpc("update_room_settings", { p_room: S.room.id, p_target: 2 });
    S.screen = "lobby";
    subscribeRoomPresence();
    draw();
  } catch (err) {
    setError(err);
  }
});

el("join-code").addEventListener("input", (e) => (e.target.value = e.target.value.toUpperCase()));

el("btn-join").addEventListener("click", async () => {
  const code = el("join-code").value.trim();
  if (code.length !== 4) return setError("코드 4자리를 입력해주세요.");
  try {
    const res = await rpc("join_room", { p_code: code });
    S.room.id = res.room_id;
    S.room.code = code.toUpperCase();
    S.my.seat = res.seat;
    await loadRoomSettings();
    const room = await getRoomStatus(S.room.id);
    if (room.status === "playing" && room.current_game_id) {
      await enterGame(room.current_game_id);
    } else {
      S.screen = "lobby";
      subscribeRoomPresence();
      draw();
    }
  } catch (err) {
    setError(err);
  }
});

async function pushSettings() {
  try {
    const target = Number(el("set-target").value);
    await rpc("update_room_settings", { p_room: S.room.id, p_target: target });
    S.room.target = target;
    if (roomChannel) await announceSettings(roomChannel, { target });
  } catch (err) {
    setError(err);
    draw();
  }
}
el("set-target").addEventListener("change", pushSettings);

el("btn-start").addEventListener("click", async () => {
  try {
    const gameId = await rpc("start_game", { p_room: S.room.id });
    if (roomChannel) await announceGameStart(roomChannel, gameId);
    await enterGame(gameId);
  } catch (err) {
    setError(err);
  }
});

// ---------- 이어하기 ----------
let resumeTarget = null;

async function checkResume() {
  const area = el("resume-area");
  try {
    resumeTarget = S.session ? await getMyActiveRoom(S.session.user.id) : null;
  } catch (e) {
    resumeTarget = null;
  }
  if (!resumeTarget || resumeTarget.gameType !== "omok") {
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
    await loadRoomSettings();
    const room = await getRoomStatus(S.room.id);
    if (room.status === "playing" && room.current_game_id) {
      await enterGame(room.current_game_id);
    } else {
      S.screen = "lobby";
      subscribeRoomPresence();
      draw();
    }
  } catch (err) {
    setError(err);
  }
});

// ---------- 재대국/새 게임 ----------
el("btn-next-board").addEventListener("click", async () => {
  try {
    await rpc("omok_next_board", { p_game: S.game.id });
    await refreshGameState();
  } catch (err) {
    setError(err);
  }
});

el("btn-new-game").addEventListener("click", () => {
  unsubscribeGame();
  if (roomChannel) {
    sb.removeChannel(roomChannel);
    roomChannel = null;
  }
  S.room = { id: null, code: null, online: {}, target: 2, isOwner: false };
  S.game = { id: null, version: 0, status: null, scoreA: 0, scoreB: 0, roundNo: 0, winnerTeam: null, target: 2, rematchSeats: [] };
  S.board = { id: null, boardNo: 0, status: null, blackSeat: null, turnSeat: null, cells: [], winnerSeat: null, winReason: null, winLine: [], turnDeadline: null };
  S.players = [];
  S.moves = [];
  S.screen = "connect";
  draw();
  checkResume();
});

// ---------- 부팅 ----------
mountChrome({ filename: "월간집계.xlsx - Excel" });
initPrefsUI({
  themeBtn: el("btn-theme"),
  stealthBtn: el("btn-stealth"),
  stealthTitle: "월간집계.xlsx - Excel",
  normalTitle: "오목",
  onChange: () => draw(),
});
startVersionWatch();
initNormalBoard();

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (S.screen === "game" && document.body.classList.contains("stealth")) draw();
  }, 150);
});

async function boot() {
  const { session, profile } = await requireAuth();
  S.session = session;
  S.profile = { nickname: profile.nickname };
  S.screen = "connect";
  draw();
  checkResume();
}
boot();
