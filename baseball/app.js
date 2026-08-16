const ROOM_PREFIX = "numball-";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 헷갈리는 0/O, 1/I 제외

// TURN 중계 서버: P2P 직결이 막힌 네트워크(NAT/방화벽)에서 폴백으로 사용.
// Metered 무료 계정에서 발급한 크리덴셜을 시작 시 받아옴.
const TURN_API =
  "https://dns05018.metered.live/api/v1/turn/credentials?apiKey=57ac38990142177dfe01dc9cb9534b68a2da";

let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const iceReady = fetch(TURN_API)
  .then((r) => r.json())
  .then((list) => {
    if (Array.isArray(list) && list.length) iceServers = list;
  })
  .catch(() => {}); // 크리덴셜 조회 실패 시 STUN만으로 진행

function peerOpts() {
  return { config: { iceServers } };
}

const el = (id) => document.getElementById(id);

const screens = {
  connect: el("screen-connect"),
  secret: el("screen-secret"),
  game: el("screen-game"),
  end: el("screen-end"),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
  document.body.classList.toggle("in-sheet", name === "game");
}

// ---------- 테마 ----------
function setTheme(theme) {
  document.body.dataset.theme = theme;
  el("btn-theme").textContent = theme === "dark" ? "☀️" : "🌙";
  localStorage.setItem("numball-theme", theme);
}

setTheme(localStorage.getItem("numball-theme") === "dark" ? "dark" : "light");

el("btn-theme").addEventListener("click", () => {
  setTheme(document.body.dataset.theme === "dark" ? "light" : "dark");
});

// ---------- 월루모드 ----------
function setStealth(on) {
  document.body.classList.toggle("stealth", on);
  document.title = on ? "월간집계.xlsx - Excel" : "숫자야구";
  el("xl-filename").textContent = on ? "월간집계.xlsx - Excel" : "숫자야구.xlsx - Excel";
  el("btn-stealth").textContent = on ? "📊" : "👔";
  el("btn-stealth").title = on ? "월루모드 끄기" : "월루모드 켜기";
  el("btn-guess").textContent = on ? "계산" : "추측!";
  localStorage.setItem("numball-stealth", on ? "1" : "0");
  // 게임 중 토글하면 해당 모드 레이아웃으로 다시 구성
  if (gameStarted && !gameOver && !screens.game.classList.contains("hidden")) {
    setupGameScreen();
    updateTurnUI();
  }
}

el("btn-stealth").addEventListener("click", () => {
  setStealth(!document.body.classList.contains("stealth"));
});

let peer = null;
let conn = null;
let isHost = false;
let digits = 4;
let mySecret = "";
let opponentSecret = "";
let localReady = false;
let remoteReady = false;
let gameStarted = false;
let gameOver = false;
let myTurn = false;
let lastIWon = null; // 다음 판 선공 결정용: 진 사람이 먼저 시작
let roundStarter = null; // 이번 판에서 각 회차를 여는 쪽: "me" | "opponent"
let roundCount = 0;
let historyLog = []; // 리사이즈 시 시트를 다시 그리기 위한 기록
let sheetRows = []; // 생성된 그리드의 데이터 행(tr) 목록
let gameCol = 0; // 게임 데이터가 시작되는 열 인덱스 (0-based)
const HISTORY_BASE = 3; // 게임 데이터 기준 히스토리 첫 행 (0:라벨, 1:입력, 2:헤더)

function genCode() {
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function isValidNumber(str) {
  return new RegExp(`^\\d{${digits}}$`).test(str) && new Set(str).size === digits;
}

function evaluate(secret, guess) {
  let strikes = 0;
  let balls = 0;
  for (let i = 0; i < secret.length; i++) {
    if (guess[i] === secret[i]) strikes++;
    else if (secret.includes(guess[i])) balls++;
  }
  return { strikes, balls };
}

// ---------- 가짜 엑셀 시트 생성 ----------
function colLetter(n) {
  let s = "";
  n++;
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function buildSheet() {
  const CELL_W = 90, ROW_H = 25, ROWNUM_W = 32;
  const stealth = document.body.classList.contains("stealth");
  let totalCols, totalRows;
  if (stealth) {
    // 전체 화면 채우기: 오른쪽/아래 잘린 셀 = 진짜 엑셀 가장자리 느낌
    const visibleCols = Math.max(7, Math.floor((window.innerWidth - ROWNUM_W) / CELL_W));
    totalCols = visibleCols + 3;
    totalRows = Math.ceil(window.innerHeight / ROW_H) + 2;
  } else {
    // 컴팩트 시트: 게임에 필요한 5열 x 3행만 (히스토리 행은 진행되며 추가)
    totalCols = 5;
    totalRows = 3;
  }
  gameCol = 0; // 게임 데이터는 A1(좌측 상단)부터
  // 게임 5열의 너비: 텍스트가 생략되지 않게 (상태 메시지는 D:E 병합 셀에 표시)
  const GAME_W = [80, 110, 90, 130, 130];

  let html = '<tr class="xl-letters"><th class="xl-corner"></th>';
  for (let c = 0; c < totalCols; c++) {
    const w = c < GAME_W.length ? ` style="width:${GAME_W[c]}px"` : "";
    html += `<th${w}>${colLetter(c)}</th>`;
  }
  html += "</tr>";
  for (let r = 1; r <= totalRows; r++) {
    html += `<tr><td class="xl-rownum">${r}</td>${"<td></td>".repeat(totalCols)}</tr>`;
  }
  // 입력창/버튼이 이전 그리드 안에 있으면 innerHTML 교체 때 파괴되므로 먼저 대피
  const stash = el("sheet-stash");
  stash.appendChild(el("guess-input"));
  stash.appendChild(el("btn-guess"));

  const grid = el("sheet-grid");
  grid.innerHTML = html;
  // 명시적 너비가 없으면 table-layout: fixed가 무시되어 내용에 따라 열이 흔들림
  const tableW =
    ROWNUM_W + GAME_W.reduce((a, b) => a + b, 0) + (totalCols - GAME_W.length) * CELL_W;
  el("sheet").style.width = tableW + "px";
  sheetRows = Array.from(grid.rows).slice(1);

  const base = 1 + gameCol; // +1: 행 번호 칸
  const r1 = sheetRows[0].cells;
  r1[base].textContent = "내 숫자";
  r1[base].className = "xl-label";
  r1[base + 1].id = "my-secret-display";
  r1[base + 2].textContent = "상태";
  r1[base + 2].className = "xl-label";
  const msg = r1[base + 3];
  msg.id = "turn-indicator";
  msg.colSpan = 2;
  r1[base + 4].remove();

  const r2 = sheetRows[1].cells;
  r2[base].textContent = "입력";
  r2[base].className = "xl-label";
  r2[base + 1].className = "xl-input-cell";
  r2[base + 1].appendChild(el("guess-input"));
  r2[base + 2].className = "xl-btn-cell";
  r2[base + 2].appendChild(el("btn-guess"));

  const headers = ["회차", "내 추측", "결과", "상대 추측", "결과"];
  const r3 = sheetRows[2].cells;
  headers.forEach((h, i) => {
    r3[base + i].textContent = h;
    r3[base + i].className = "xl-header-cell";
  });

  el("xl-namebox").textContent = colLetter(gameCol + 1) + "2";

  // 기록 다시 그리기 (리사이즈/재시작 대응)
  roundCount = 0;
  historyLog.forEach(fillHistoryCells);
}

function badgesHtml(strikes, balls) {
  return (
    `<span class="badge strike">${strikes}S</span>` +
    `<span class="badge ball">${balls}B</span>` +
    (strikes === 0 && balls === 0 ? `<span class="badge out">OUT</span>` : "")
  );
}

// 두 레이아웃(일반/월루)에 같은 텍스트를 쓰기 위한 헬퍼
function setSecretText(t) {
  const cell = el("my-secret-display");
  if (cell) cell.textContent = t;
  el("my-secret-normal").textContent = t;
}

function setTurnText(t) {
  const cell = el("turn-indicator");
  if (cell) cell.textContent = t;
  el("turn-indicator-normal").textContent = t;
}

function renderNormalHistory() {
  const tbody = el("history-body");
  tbody.innerHTML = "";
  let rc = 0;
  let row = null;
  historyLog.forEach((e) => {
    if (e.who === roundStarter || !row) {
      rc++;
      row = document.createElement("tr");
      row.innerHTML = `<td>${rc}</td><td></td><td></td><td></td><td></td>`;
      tbody.appendChild(row);
    }
    const c = row.children;
    if (e.who === "me") {
      c[1].textContent = e.number;
      c[2].innerHTML = badgesHtml(e.strikes, e.balls);
    } else {
      c[3].textContent = e.number;
      c[4].innerHTML = badgesHtml(e.strikes, e.balls);
    }
  });
}

// 현재 모드에 맞게 게임 화면 구성 (입력창/버튼 배치 포함)
function setupGameScreen() {
  if (document.body.classList.contains("stealth")) {
    buildSheet();
  } else {
    el("guess-area").appendChild(el("guess-input"));
    el("guess-area").appendChild(el("btn-guess"));
    renderNormalHistory();
  }
  setSecretText(mySecret);
}

function fillHistoryCells(entry) {
  const badges = badgesHtml(entry.strikes, entry.balls);
  if (entry.who === roundStarter || roundCount === 0) roundCount++;
  let row = sheetRows[HISTORY_BASE + roundCount - 1];
  if (!row) {
    row = document.createElement("tr");
    const dataCols = sheetRows[1].cells.length - 1; // 입력 행 기준 (행 번호 칸 제외)
    row.innerHTML = `<td class="xl-rownum">${sheetRows.length + 1}</td>${"<td></td>".repeat(dataCols)}`;
    el("sheet-grid").appendChild(row);
    sheetRows.push(row);
  }
  const c = row.cells;
  const base = 1 + gameCol;
  c[base].textContent = roundCount;
  if (entry.who === "me") {
    c[base + 1].textContent = entry.number;
    c[base + 2].innerHTML = badges;
  } else {
    c[base + 3].textContent = entry.number;
    c[base + 4].innerHTML = badges;
  }
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    // 전체 화면 엑셀(월루모드)일 때만 시트를 창 크기에 맞춰 다시 그림
    if (
      document.body.classList.contains("stealth") &&
      gameStarted && !gameOver &&
      !screens.game.classList.contains("hidden")
    ) {
      buildSheet();
      setSecretText(mySecret);
      updateTurnUI();
    }
  }, 150);
});

function applyDigits(n) {
  digits = n;
  el("secret-input").maxLength = n;
  el("guess-input").maxLength = n;
  el("secret-input").placeholder = `${n}자리 숫자`;
  el("guess-input").placeholder = `${n}자리 숫자`;
  el("secret-hint").textContent = `0~9 중 서로 다른 숫자 ${n}개를 정하세요.`;
}

// ---------- 방 만들기 ----------
el("btn-create").addEventListener("click", () => {
  el("btn-create").disabled = true;
  el("btn-join").disabled = true;
  el("connect-status").textContent = "방을 만드는 중...";
  iceReady.then(() => tryCreateHost(0));
});

function tryCreateHost(attempt) {
  if (attempt >= 5) {
    el("connect-status").textContent = "방 생성에 실패했습니다. 새로고침 후 다시 시도해주세요.";
    el("btn-create").disabled = false;
    el("btn-join").disabled = false;
    return;
  }
  const code = genCode();
  const p = new Peer(ROOM_PREFIX + code, peerOpts());

  p.on("open", () => {
    peer = p;
    isHost = true;
    el("create-result").classList.remove("hidden");
    el("room-code").textContent = code;
    el("connect-status").textContent = "친구가 입장하기를 기다리는 중...";
  });

  p.on("connection", (c) => {
    // 이미 상대가 있으면 추가 접속 거부 (게임 중 난입 방지)
    if (conn) {
      c.on("open", () => c.close());
      return;
    }
    conn = c;
    setupConnection();
    conn.on("open", () => {
      el("connect-status").textContent = "친구가 입장했습니다!";
      applyDigits(parseInt(el("digit-select").value, 10));
      conn.send({ type: "config", digits });
      goToSecretScreen();
    });
  });

  p.on("error", (err) => {
    if (err.type === "unavailable-id") {
      p.destroy();
      tryCreateHost(attempt + 1);
    } else {
      el("connect-status").textContent = "오류가 발생했습니다: " + err.type;
      el("btn-create").disabled = false;
      el("btn-join").disabled = false;
    }
  });
}

// ---------- 입장하기 ----------
el("join-code").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

el("join-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") el("btn-join").click();
});

el("btn-join").addEventListener("click", () => {
  const code = el("join-code").value.trim();
  if (code.length !== 4) {
    el("connect-status").textContent = "코드 4자리를 입력해주세요.";
    return;
  }
  el("btn-join").disabled = true;
  el("btn-create").disabled = true;
  el("connect-status").textContent = "연결하는 중...";

  iceReady.then(() => joinRoom(code));
});

function joinRoom(code) {
  const p = new Peer(peerOpts());

  p.on("open", () => {
    peer = p;
    isHost = false;
    const c = p.connect(ROOM_PREFIX + code, { reliable: true });
    conn = c;
    setupConnection();
    // P2P 연결이 일정 시간 내에 안 되면 실패로 안내 (NAT/방화벽 문제 등)
    const connectTimeout = setTimeout(() => {
      if (!c.open) {
        el("connect-status").textContent =
          "연결에 실패했습니다. 새로고침 후 다시 시도해주세요. (네트워크 환경에 따라 연결이 어려울 수 있어요)";
        p.destroy();
        peer = null;
        conn = null;
        el("btn-join").disabled = false;
        el("btn-create").disabled = false;
      }
    }, 20000);
    conn.on("open", () => {
      clearTimeout(connectTimeout);
      // 방장이 보내는 config를 받은 뒤에 숫자 정하기 화면으로 넘어감
      el("connect-status").textContent = "연결되었습니다!";
    });
  });

  p.on("error", (err) => {
    if (conn && conn.open) return; // 게임 중 일시 오류는 무시 (끊김은 conn "close"에서 처리)
    if (err.type === "peer-unavailable") {
      el("connect-status").textContent = "해당 코드의 방을 찾을 수 없습니다.";
    } else {
      el("connect-status").textContent = "오류가 발생했습니다: " + err.type;
    }
    p.destroy();
    peer = null;
    conn = null;
    el("btn-join").disabled = false;
    el("btn-create").disabled = false;
  });
}

// ---------- 연결 공통 처리 ----------
function setupConnection() {
  conn.on("data", handleData);
  conn.on("error", (err) => {
    console.error("connection error:", err);
    el("connect-status").textContent = "연결 오류가 발생했습니다. 새로고침 후 다시 시도해주세요.";
  });
  conn.on("close", () => {
    alert("상대방과의 연결이 끊어졌습니다. 새로고침 후 다시 시도해주세요.");
  });
}

function handleData(msg) {
  if (msg.type === "config") {
    applyDigits(msg.digits);
    goToSecretScreen();
  } else if (msg.type === "ready") {
    remoteReady = true;
    tryStartGame();
  } else if (msg.type === "guess") {
    if (!gameStarted || gameOver || !mySecret) return;
    const { strikes, balls } = evaluate(mySecret, msg.number);
    addHistoryRow("opponent", msg.number, strikes, balls);
    conn.send({ type: "result", number: msg.number, strikes, balls });
    if (strikes === digits) {
      endGame(false);
    } else {
      myTurn = true;
      updateTurnUI();
    }
  } else if (msg.type === "result") {
    addHistoryRow("me", msg.number, msg.strikes, msg.balls);
    if (msg.strikes === digits) {
      endGame(true);
    } else {
      myTurn = false;
      updateTurnUI();
    }
  } else if (msg.type === "reveal") {
    // 종료 화면일 때만 반영 (이미 다시하기를 눌렀으면 지난 판 정보이므로 무시)
    if (!gameOver) return;
    opponentSecret = msg.secret;
    updateEndSecrets();
  } else if (msg.type === "rematch") {
    // 내가 이미 다시하기를 눌러 리셋된 상태면 무시 (동시 클릭 레이스 방지)
    if (!gameOver) return;
    resetGame();
    goToSecretScreen();
  }
}

// ---------- 숫자 정하기 ----------
function goToSecretScreen() {
  showScreen("secret");
}

el("secret-input").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/[^0-9]/g, "");
});

el("secret-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") el("btn-ready").click();
});

el("btn-ready").addEventListener("click", () => {
  const value = el("secret-input").value;
  if (!isValidNumber(value)) {
    el("secret-status").textContent = `서로 다른 숫자 ${digits}개를 입력해주세요.`;
    return;
  }
  mySecret = value;
  localReady = true;
  el("secret-input").disabled = true;
  el("btn-ready").disabled = true;
  el("secret-status").textContent = "상대방을 기다리는 중...";
  conn.send({ type: "ready" });
  tryStartGame();
});

function tryStartGame() {
  if (localReady && remoteReady && !gameStarted) {
    gameStarted = true;
    // 첫 판은 방장 선공, 이후에는 진 사람이 선공
    myTurn = lastIWon === null ? isHost : !lastIWon;
    roundStarter = myTurn ? "me" : "opponent";
    roundCount = 0;
    setupGameScreen();
    showScreen("game");
    updateTurnUI();
  }
}

// ---------- 게임 ----------
el("guess-input").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/[^0-9]/g, "");
});

el("guess-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") el("btn-guess").click();
});

el("btn-guess").addEventListener("click", () => {
  if (!myTurn || gameOver) return;
  const value = el("guess-input").value;
  if (!isValidNumber(value)) {
    setTurnText(`서로 다른 숫자 ${digits}개를 입력해주세요.`);
    return;
  }
  conn.send({ type: "guess", number: value });
  el("guess-input").value = "";
  myTurn = false;
  updateTurnUI();
  setTurnText("결과를 기다리는 중...");
}, false);

function updateTurnUI() {
  if (gameOver) return;
  el("guess-input").disabled = !myTurn;
  el("btn-guess").disabled = !myTurn;
  setTurnText(myTurn ? "내 차례입니다! 숫자를 입력하세요." : "상대방의 차례입니다...");
}

function addHistoryRow(who, number, strikes, balls) {
  const entry = { who, number, strikes, balls };
  historyLog.push(entry);
  if (document.body.classList.contains("stealth") && sheetRows.length) {
    fillHistoryCells(entry);
  }
  renderNormalHistory();
}

// ---------- 종료 / 재시작 ----------
function endGame(iWon) {
  gameOver = true;
  lastIWon = iWon;
  el("guess-input").disabled = true;
  el("btn-guess").disabled = true;
  showScreen("end");
  el("end-message").textContent = iWon ? "🎉 승리했습니다!" : "😢 패배했습니다";
  conn.send({ type: "reveal", secret: mySecret });
  updateEndSecrets();
}

function updateEndSecrets() {
  el("end-secrets").textContent =
    `내 숫자: ${mySecret} · 상대 숫자: ${opponentSecret || "확인 중..."}`;
}

el("btn-rematch").addEventListener("click", () => {
  conn.send({ type: "rematch" });
  resetGame();
  goToSecretScreen();
});

function resetGame() {
  mySecret = "";
  opponentSecret = "";
  localReady = false;
  remoteReady = false;
  gameStarted = false;
  gameOver = false;
  myTurn = false;
  el("secret-input").value = "";
  el("secret-input").disabled = false;
  el("btn-ready").disabled = false;
  el("secret-status").textContent = "";
  el("guess-input").value = "";
  el("end-secrets").textContent = "";
  roundStarter = null;
  roundCount = 0;
  historyLog = [];
}

// 게임 상태 변수 선언 이후에 실행해야 함 (setStealth가 gameStarted를 참조)
// 명시적으로 끈 적이 없으면 월루모드가 기본
setStealth(localStorage.getItem("numball-stealth") !== "0");

// ---------- 새 버전 감지 ----------
// 배포 시 APP_VERSION, version.json(version/updated), index.html의 ?v= 를 같이 올릴 것
const APP_VERSION = 4;

function reloadForUpdate() {
  location.replace(location.pathname + "?u=" + Date.now());
}

function checkForUpdate() {
  fetch("version.json?ts=" + Date.now(), { cache: "no-store" })
    .then((r) => r.json())
    .then((v) => {
      if (v.updated) el("build-info").textContent = "마지막 업데이트: " + v.updated;
      if (v.version === APP_VERSION) return;
      const idle = !peer && !screens.connect.classList.contains("hidden");
      const alreadyTried = sessionStorage.getItem("numball-reloaded") === String(v.version);
      if (idle && !alreadyTried) {
        // 아직 게임 전이면 자동 새로고침 (버전당 1회만 시도해 무한 루프 방지)
        sessionStorage.setItem("numball-reloaded", String(v.version));
        reloadForUpdate();
      } else {
        el("update-notice").classList.remove("hidden");
      }
    })
    .catch(() => {}); // 오프라인 등은 무시
}

el("btn-update").addEventListener("click", reloadForUpdate);
checkForUpdate();
setInterval(checkForUpdate, 5 * 60 * 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) checkForUpdate();
});
