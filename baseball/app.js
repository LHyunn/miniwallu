// 숫자야구 — Supabase 서버 권위판. 동기화는 티츄와 동일한 버전-갭 스냅샷:
// 모든 변경 RPC가 games.version을 올리고(_emit), 클라이언트는 games UPDATE 구독에서
// 버전이 앞서면 get_bb_state 풀 스냅샷으로 전량 재그리기한다.
import { sb, rpc, gameChannel, roomPresence, announceGameStart, announceSettings, getRoomStatus, getMyActiveRoom } from "/assets/js/supabase.js";
import { requireAuth } from "/assets/js/auth.js";
import { applyPrefs, initPrefsUI } from "/assets/js/prefs.js";
import { startVersionWatch } from "/assets/js/version.js";
import { mountChrome } from "/assets/js/chrome.js";
import { renderStealthGame, restoreControls } from "./stealth.js";

const el = (id) => document.getElementById(id);

// ---------- 상태 ----------
const S = {
  session: null,
  profile: null,
  screen: "connect",
  room: {
    id: null,
    code: null,
    online: {}, // seat → nickname (presence)
    target: 3,
    digits: 4,
    isOwner: false,
  },
  game: {
    id: null,
    version: 0,
    status: null,
    scoreA: 0,
    scoreB: 0,
    roundNo: 0,
    winnerTeam: null,
    target: 3,
    rematchSeats: [],
  },
  round: { id: null, status: null, digits: 4, turnSeat: null, winnerSeat: null, secretsSet: [] },
  players: [],
  guesses: [],
  my: { seat: null, secret: null },
  revealed: null,
};

let roomChannel = null;
let unsubGame = null;

function setError(msg) {
  const text = msg && msg.message ? msg.message : String(msg);
  if (S.screen === "game") el("status-line").textContent = text;
  else if (S.screen === "lobby") el("lobby-status").textContent = text;
  else el("connect-status").textContent = text;
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
    restoreControls();
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
  el("set-digits").value = String(S.room.digits);
  el("set-target").value = String(S.room.target);
  el("set-digits").disabled = !S.room.isOwner;
  el("set-target").disabled = !S.room.isOwner;
  el("settings-owner-hint").classList.toggle("hidden", S.room.isOwner);
}

function nickOf(seat) {
  const p = S.players.find((p) => p.seat === seat);
  return p ? p.nickname : "?";
}

function fmtSB(g) {
  if (g.strikes === 0 && g.balls === 0) return "OUT";
  return `${g.strikes}S ${g.balls}B`;
}

function drawGame() {
  const r = S.round;
  const g = S.game;
  const mySeat = S.my.seat;

  el("scoreline").innerHTML = "";
  const score = document.createElement("span");
  score.append(
    nickOf(0) + " ", Object.assign(document.createElement("b"), { textContent: g.scoreA }),
    " : ", Object.assign(document.createElement("b"), { textContent: g.scoreB }),
    ` ${nickOf(1)} · ${g.target}선승 · ${r.digits}자리 · ${g.roundNo}판째`
  );
  el("scoreline").appendChild(score);

  const setting = r.status === "setting";
  const playing = r.status === "playing";
  const mySet = S.round.secretsSet.includes(mySeat);

  el("secret-phase").classList.toggle("hidden", !setting);
  el("play-phase").classList.toggle("hidden", setting);

  const status = el("status-line");
  status.classList.remove("turn");
  if (setting) {
    if (mySet) {
      status.textContent = "상대가 숫자를 정하는 중...";
      el("secret-hint").textContent = "내 숫자: " + (S.my.secret || "설정됨");
      el("secret-input").classList.add("hidden");
      el("btn-secret").classList.add("hidden");
    } else {
      status.textContent = `서로 다른 숫자 ${r.digits}자리를 정하세요`;
      el("secret-hint").textContent = "상대가 이 숫자를 맞혀야 합니다.";
      el("secret-input").classList.remove("hidden");
      el("btn-secret").classList.remove("hidden");
      el("secret-input").maxLength = r.digits;
      el("secret-input").placeholder = "0123456789".slice(0, r.digits);
    }
  } else if (playing) {
    const myTurn = r.turnSeat === mySeat;
    status.textContent = myTurn ? "내 차례입니다!" : `${nickOf(r.turnSeat)}의 차례입니다...`;
    status.classList.toggle("turn", myTurn);
    el("guess-input").disabled = !myTurn;
    el("btn-guess").disabled = !myTurn;
    el("guess-input").maxLength = r.digits;
    el("guess-input").placeholder = myTurn ? "0123456789".slice(0, r.digits) : "";
  } else if (r.status === "finished") {
    status.textContent = "판 종료";
  }

  el("my-secret-line").innerHTML = "";
  if (!setting && S.my.secret) {
    el("my-secret-line").append("내 숫자", Object.assign(document.createElement("b"), { textContent: S.my.secret }));
  }

  // 히스토리 2열
  el("opp-hist-title").textContent = mySeat != null ? nickOf(1 - mySeat) + "의 추측" : "상대 추측";
  for (const [boxId, seat] of [["hist-mine", mySeat], ["hist-opp", mySeat != null ? 1 - mySeat : null]]) {
    const box = el(boxId);
    box.innerHTML = "";
    S.guesses
      .filter((x) => x.seat === seat)
      .forEach((x) => {
        const row = document.createElement("div");
        row.className = "row";
        const gspan = document.createElement("span");
        gspan.className = "g";
        gspan.textContent = x.guess;
        const rspan = document.createElement("span");
        const win = x.strikes === r.digits;
        rspan.className = win ? "win" : "";
        if (win) rspan.textContent = "정답!";
        else {
          const s = document.createElement("span");
          s.className = "s";
          s.textContent = x.strikes + "S";
          const b = document.createElement("span");
          b.className = "b";
          b.textContent = " " + x.balls + "B";
          if (x.strikes === 0 && x.balls === 0) {
            rspan.textContent = "OUT";
          } else {
            rspan.append(s, b);
          }
        }
        row.append(gspan, rspan);
        box.appendChild(row);
      });
    box.scrollTop = box.scrollHeight;
  }

  // 판 종료 오버레이 (매치는 계속)
  const roundOver = r.status === "finished" && g.status === "playing";
  el("round-end").classList.toggle("hidden", !roundOver);
  if (roundOver) {
    const iWon = r.winnerSeat === mySeat;
    el("round-end-title").textContent = iWon ? "이겼습니다!" : `${nickOf(r.winnerSeat)} 승리`;
    const body = el("round-end-body");
    body.innerHTML = "";
    if (S.revealed) {
      for (const seat of [0, 1]) {
        const line = document.createElement("p");
        const rv = document.createElement("span");
        rv.className = "reveal";
        rv.textContent = S.revealed[seat] || "?";
        line.append(nickOf(seat) + "의 숫자: ", rv);
        body.appendChild(line);
      }
    }
    const score = document.createElement("p");
    score.textContent = `${g.scoreA} : ${g.scoreB} (${g.target}선승)`;
    body.appendChild(score);
    const voted = S.game.rematchSeats.includes(mySeat);
    el("btn-next-round").classList.toggle("hidden", voted);
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
    const raw = await rpc("get_bb_state", { p_game: S.game.id });
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
  S.game.target = g.target_score ?? 3;
  S.game.rematchSeats = g.rematch_seats || [];
  const r = raw.round || {};
  S.round = {
    id: r.id,
    status: r.status,
    digits: r.digits ?? 4,
    turnSeat: r.turn_seat,
    winnerSeat: r.winner_seat,
    secretsSet: r.secrets_set || [],
  };
  S.players = raw.players || [];
  S.guesses = raw.guesses || [];
  S.my.secret = raw.my_secret || null;
  S.revealed = raw.revealed || null;
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

// ---------- 방/로비 ----------
async function loadRoomSettings() {
  const { data } = await sb.from("rooms").select("target_score, settings, created_by").eq("id", S.room.id).single();
  if (data) {
    S.room.target = data.target_score;
    S.room.digits = (data.settings && data.settings.digits) || 4;
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
      if (settings.digits) S.room.digits = settings.digits;
      draw();
    }
  );
}

el("btn-create").addEventListener("click", async () => {
  try {
    const res = await rpc("create_room", { p_game_type: "baseball", p_settings: { digits: 4 } });
    S.room.id = res.room_id;
    S.room.code = res.code;
    S.my.seat = 0;
    S.room.isOwner = true;
    S.room.target = 3;
    S.room.digits = 4;
    await rpc("update_room_settings", { p_room: S.room.id, p_target: 3 });
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

// 설정 변경(방장) — 서버 반영 + 같은 방에 브로드캐스트
async function pushSettings() {
  try {
    const target = Number(el("set-target").value);
    const digits = Number(el("set-digits").value);
    await rpc("update_room_settings", { p_room: S.room.id, p_target: target, p_settings: { digits } });
    S.room.target = target;
    S.room.digits = digits;
    if (roomChannel) await announceSettings(roomChannel, { target, digits });
  } catch (err) {
    setError(err);
    draw();
  }
}
el("set-target").addEventListener("change", pushSettings);
el("set-digits").addEventListener("change", pushSettings);

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
  if (!resumeTarget || resumeTarget.gameType !== "baseball") {
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

// ---------- 게임 조작 ----------
el("btn-secret").addEventListener("click", async () => {
  const val = el("secret-input").value.trim();
  try {
    await rpc("set_secret", { p_round: S.round.id, p_secret: val });
    S.my.secret = val;
    el("secret-input").value = "";
    await refreshGameState();
  } catch (err) {
    setError(err);
  }
});

el("secret-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") el("btn-secret").click();
});

el("btn-guess").addEventListener("click", async () => {
  const val = el("guess-input").value.trim();
  if (!val) return;
  try {
    await rpc("bb_guess", { p_round: S.round.id, p_guess: val });
    el("guess-input").value = "";
    await refreshGameState();
  } catch (err) {
    setError(err);
  }
});

el("guess-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") el("btn-guess").click();
});

el("btn-next-round").addEventListener("click", async () => {
  try {
    await rpc("bb_next_round", { p_game: S.game.id });
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
  S.room = { id: null, code: null, online: {}, target: 3, digits: 4, isOwner: false };
  S.game = { id: null, version: 0, status: null, scoreA: 0, scoreB: 0, roundNo: 0, winnerTeam: null, target: 3, rematchSeats: [] };
  S.round = { id: null, status: null, digits: 4, turnSeat: null, winnerSeat: null, secretsSet: [] };
  S.players = [];
  S.guesses = [];
  S.my.secret = null;
  S.screen = "connect";
  draw();
  checkResume();
});

// ---------- 부팅 ----------
mountChrome({ filename: "주간실적_요약.xlsx - Excel" });
initPrefsUI({
  themeBtn: el("btn-theme"),
  stealthBtn: el("btn-stealth"),
  stealthTitle: "주간실적_요약.xlsx - Excel",
  normalTitle: "숫자야구",
  onChange: () => draw(),
});
startVersionWatch();

async function boot() {
  const { session, profile } = await requireAuth();
  S.session = session;
  S.profile = { nickname: profile.nickname };
  S.screen = "connect";
  draw();
  checkResume();
}
boot();
