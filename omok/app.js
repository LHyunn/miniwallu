const ROOM_PREFIX = "omok-";
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
  game: el("screen-game"),
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
  localStorage.setItem("omok-theme", theme);
}

setTheme(localStorage.getItem("omok-theme") === "dark" ? "dark" : "light");

el("btn-theme").addEventListener("click", () => {
  setTheme(document.body.dataset.theme === "dark" ? "light" : "dark");
});

// ---------- 월루모드 ----------
function isStealth() {
  return document.body.classList.contains("stealth");
}

function setStealth(on) {
  document.body.classList.toggle("stealth", on);
  document.title = on ? "월간집계.xlsx - Excel" : "오목";
  el("btn-stealth").textContent = on ? "📊" : "👔";
  el("btn-stealth").title = on ? "월루모드 끄기" : "월루모드 켜기";
  localStorage.setItem("omok-stealth", on ? "1" : "0");
  // 게임 화면이 열려 있으면 해당 모드 레이아웃으로 다시 구성 (종료 후 포함)
  if (gameStarted && !screens.game.classList.contains("hidden")) {
    setupGameScreen();
    renderAll();
  }
}

el("btn-stealth").addEventListener("click", () => {
  setStealth(!isStealth());
});

// ---------- 게임 상태 ----------
const SIZE = 15;
const BLACK = 1; // 선공
const WHITE = 2;

let peer = null;
let conn = null;
let isHost = false;
let board = [];
let moves = []; // [{r, c, color}] — 모든 재렌더의 단일 소스
let myColor = 0;
let myTurn = false;
let gameStarted = false;
let gameOver = false;
let isDraw = false;
let lastIWon = null; // 다음 판 선공(흑) 결정: 진 사람이 흑
let winCells = null; // 승리 라인 좌표 목록

// 렌더 대상 참조
let boardCells = []; // 월루 시트의 오목판 td 15x15
let rematchCell = null; // 월루 시트에서 다시하기 버튼이 들어갈 셀
let normalCells = []; // 일반 모드 판의 div 15x15

function genCode() {
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

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

// ---------- 오목 규칙 (렌주룰: 흑만 금수) ----------
const DIRS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

function inBoard(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

// (r,c)를 포함해 방향으로 이어진 같은 색 연속 셀 목록
function runCells(bd, r, c, dr, dc) {
  const color = bd[r][c];
  const cells = [[r, c]];
  for (const s of [1, -1]) {
    let rr = r + dr * s;
    let cc = c + dc * s;
    while (inBoard(rr, cc) && bd[rr][cc] === color) {
      cells.push([rr, cc]);
      rr += dr * s;
      cc += dc * s;
    }
  }
  return cells;
}

// 방금 (r,c)에 둔 수가 승리인지. 흑은 정확히 5, 백은 5 이상.
// 승리 라인 좌표 배열 또는 null 반환.
function checkWin(bd, r, c) {
  const color = bd[r][c];
  for (const [dr, dc] of DIRS) {
    const cells = runCells(bd, r, c, dr, dc);
    if (color === WHITE && cells.length >= 5) return cells;
    if (color === BLACK && cells.length === 5) return cells;
  }
  return null;
}

// 흑이 (r,c)에 두면 만들어지는 "사"(한 수로 정확한 5가 되는 형태)의
// 돌 집합 키 목록. 열린/닫힌 사 모두 포함, 같은 4개 돌은 하나로 침.
function fourKeysAt(bd, r, c) {
  const keys = new Set();
  for (const [dr, dc] of DIRS) {
    for (let off = -4; off <= 4; off++) {
      if (off === 0) continue;
      const er = r + dr * off;
      const ec = c + dc * off;
      if (!inBoard(er, ec) || bd[er][ec] !== 0) continue;
      bd[er][ec] = BLACK;
      const run = runCells(bd, er, ec, dr, dc);
      const containsMove = run.some(([rr, cc]) => rr === r && cc === c);
      if (run.length === 5 && containsMove) {
        // 완성점 e를 뺀 4개 돌이 "사"의 정체
        const stones = run
          .filter(([rr, cc]) => !(rr === er && cc === ec))
          .map(([rr, cc]) => rr + "," + cc)
          .sort()
          .join("|");
        keys.add(dr + "_" + dc + ":" + stones);
      }
      bd[er][ec] = 0;
    }
  }
  return keys;
}

// (r,c)의 돌을 포함해 방향으로 "열린 4"(양끝 모두 정확한 5로 완성 가능)인지
function isOpenFour(bd, r, c, dr, dc) {
  const run = runCells(bd, r, c, dr, dc);
  if (run.length !== 4) return false;
  // 방향 벡터 기준 정렬된 끝점
  const sorted = run.slice().sort((a, b) => ((a[0] - b[0]) * dr + (a[1] - b[1]) * dc > 0 ? 1 : -1));
  const head = sorted[0];
  const tail = sorted[sorted.length - 1];
  for (const [end, sign] of [
    [head, -1],
    [tail, 1],
  ]) {
    const fr = end[0] + dr * sign;
    const fc = end[1] + dc * sign;
    if (!inBoard(fr, fc) || bd[fr][fc] !== 0) return false; // 끝이 막힘
    const br = fr + dr * sign;
    const bc = fc + dc * sign;
    if (inBoard(br, bc) && bd[br][bc] === BLACK) return false; // 완성 시 장목
  }
  return true;
}

// 흑이 (r,c)에 두면 만들어지는 "열린 3" 집합 키 목록.
// 열린 3 = 한 수 더 두면 열린 4가 되는 3 (그 완성점이 기본 금수면 제외)
function openThreeKeysAt(bd, r, c) {
  const keys = new Set();
  for (const [dr, dc] of DIRS) {
    for (let off = -4; off <= 4; off++) {
      if (off === 0) continue;
      const er = r + dr * off;
      const ec = c + dc * off;
      if (!inBoard(er, ec) || bd[er][ec] !== 0) continue;
      bd[er][ec] = BLACK;
      let qualified = false;
      if (isOpenFour(bd, er, ec, dr, dc)) {
        const run = runCells(bd, er, ec, dr, dc);
        if (run.some(([rr, cc]) => rr === r && cc === c)) {
          // 완성점 자체가 기본 금수(장목/사사)면 이 3은 발전 불가
          // (열린3의 재귀 금수까지는 근사 — 참고 구현들과 동일 수준)
          bd[er][ec] = 0;
          if (!isForbiddenBasic(bd, er, ec)) qualified = true;
          bd[er][ec] = BLACK;
          if (qualified) {
            const stones = run
              .filter(([rr, cc]) => !(rr === er && cc === ec))
              .map(([rr, cc]) => rr + "," + cc)
              .sort()
              .join("|");
            keys.add(dr + "_" + dc + ":" + stones);
          }
        }
      }
      bd[er][ec] = 0;
    }
  }
  return keys;
}

// 장목/사사만 검사하는 얕은 금수 판정 (열린3 완성점 검증용)
function isForbiddenBasic(bd, r, c) {
  if (bd[r][c] !== 0) return false;
  bd[r][c] = BLACK;
  let result = false;
  if (!checkWin(bd, r, c)) {
    for (const [dr, dc] of DIRS) {
      if (runCells(bd, r, c, dr, dc).length >= 6) result = true; // 장목
    }
    if (!result && fourKeysAt(bd, r, c).size >= 2) result = true; // 사사
  }
  bd[r][c] = 0;
  return result;
}

// 흑 전용 금수 판정. "장목" | "사사" | "삼삼" | null
// 단, 그 수로 정확한 5가 완성되면 금수보다 승리가 우선.
function isForbidden(bd, r, c) {
  if (bd[r][c] !== 0) return null;
  bd[r][c] = BLACK;
  let result = null;
  if (checkWin(bd, r, c)) {
    result = null; // 오목 완성이 우선
  } else {
    for (const [dr, dc] of DIRS) {
      if (runCells(bd, r, c, dr, dc).length >= 6) result = "장목";
    }
    if (!result && fourKeysAt(bd, r, c).size >= 2) result = "사사";
    if (!result && openThreeKeysAt(bd, r, c).size >= 2) result = "삼삼";
  }
  bd[r][c] = 0;
  return result;
}

// ---------- 월루모드: 가짜 엑셀 시트 ----------
const CITY_LABELS = [
  "서울", "부산", "인천", "대구", "대전",
  "광주", "울산", "수원", "창원", "성남",
  "청주", "전주", "천안", "포항", "제주",
];
const SUM_ROW = [12, 8, 15, 9, 11, 7, 13, 10, 6, 14, 9, 12, 8, 11, 10];

const BOARD_COL = 1; // 데이터 열 기준 오목판 시작 (0열은 지점명 라벨)
const BOARD_ROW = 4; // 데이터 행 기준 오목판 시작 (0~3행은 제목/범례/상태/헤더)

function buildSheet() {
  const ROW_H = 25, ROWNUM_W = 32, LABEL_W = 70, BOARD_W = 34, CELL_W = 90;

  // 버튼이 이전 그리드 안에 있으면 innerHTML 교체 때 파괴되므로 먼저 대피
  el("sheet-stash").appendChild(el("btn-rematch"));

  const fillerCols = Math.max(
    2,
    Math.ceil((window.innerWidth - ROWNUM_W - LABEL_W - SIZE * BOARD_W) / CELL_W) + 1
  );
  const totalCols = 1 + SIZE + fillerCols;
  const totalRows = Math.max(BOARD_ROW + SIZE + 2, Math.ceil(window.innerHeight / ROW_H) + 2);

  let html = '<tr class="xl-letters"><th class="xl-corner"></th>';
  for (let c = 0; c < totalCols; c++) {
    const w = c === 0 ? LABEL_W : c <= SIZE ? BOARD_W : CELL_W;
    html += `<th style="width:${w}px">${colLetter(c)}</th>`;
  }
  html += "</tr>";
  for (let r = 1; r <= totalRows; r++) {
    html += `<tr><td class="xl-rownum">${r}</td>${"<td></td>".repeat(totalCols)}</tr>`;
  }

  const grid = el("sheet-grid");
  grid.innerHTML = html;
  el("sheet").style.width =
    ROWNUM_W + LABEL_W + SIZE * BOARD_W + fillerCols * CELL_W + "px";

  const rows = Array.from(grid.rows).slice(1);
  const cell = (r, c) => rows[r].cells[1 + c]; // +1: 행 번호 칸

  // 보고서 드레싱
  cell(0, 0).textContent = "월간 판매 집계";
  cell(0, 0).className = "xl-title-cell";
  cell(1, 0).textContent = "기간: 2026-08";
  cell(1, 0).className = "xl-note";
  // 범례 (돌 색의 인게임 설명) — 판 오른쪽 넓은 열에 배치
  cell(1, SIZE + 1).textContent = "자사";
  cell(1, SIZE + 1).className = "xl-legend-me";
  cell(1, SIZE + 2).textContent = "타사";
  cell(1, SIZE + 2).className = "xl-legend-op";
  cell(2, 0).textContent = "비고";
  cell(2, 0).className = "xl-label";
  const status = cell(2, 1);
  status.id = "xl-status-cell";
  status.colSpan = 8;
  status.className = "xl-status-cell";
  for (let i = 0; i < 7; i++) rows[2].cells[1 + 2].remove(); // colspan만큼 셀 정리
  rematchCell = rows[2].cells[rows[2].cells.length - fillerCols]; // 상태 행 오른쪽 셀
  cell(3, 0).textContent = "구분";
  cell(3, 0).className = "xl-label";
  for (let c = 0; c < SIZE; c++) {
    cell(3, BOARD_COL + c).textContent = "W" + String(c + 1).padStart(2, "0");
    cell(3, BOARD_COL + c).className = "xl-label";
  }

  boardCells = [];
  for (let r = 0; r < SIZE; r++) {
    const rowRefs = [];
    cell(BOARD_ROW + r, 0).textContent = CITY_LABELS[r];
    for (let c = 0; c < SIZE; c++) {
      const td = cell(BOARD_ROW + r, BOARD_COL + c);
      td.className = "xl-board-cell";
      td.dataset.r = r;
      td.dataset.c = c;
      rowRefs.push(td);
    }
    boardCells.push(rowRefs);
  }

  const sumRow = BOARD_ROW + SIZE;
  cell(sumRow, 0).textContent = "합계";
  cell(sumRow, 0).className = "xl-label";
  for (let c = 0; c < SIZE; c++) cell(sumRow, BOARD_COL + c).textContent = SUM_ROW[c];
}

// ---------- 일반 모드: 심플 오목판 ----------
function initNormalBoard() {
  const boardEl = el("board");
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

// ---------- 렌더링 (상태에서 전량 재그리기) ----------
function setTurnText(t) {
  const cell = el("xl-status-cell");
  if (cell) cell.textContent = t;
}

function sheetAddr(r, c) {
  return colLetter(BOARD_COL + c) + (BOARD_ROW + r + 1); // 데이터 0행 = 시트 1행
}

function renderAll() {
  const last = moves[moves.length - 1] || null;
  const winKey = new Set((winCells || []).map(([r, c]) => r + "," + c));
  const showForbid = !gameOver && gameStarted && myTurn && myColor === BLACK;

  // 일반 모드 판
  if (normalCells.length) {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const d = normalCells[r][c];
        d.className = "bd-cell";
        if (board[r] && board[r][c]) {
          d.classList.add(board[r][c] === BLACK ? "s1" : "s2");
          if (last && last.r === r && last.c === c) d.classList.add("last");
          if (winKey.has(r + "," + c)) d.classList.add("win");
        } else if (showForbid && isForbidden(board, r, c)) {
          d.classList.add("forbid");
        }
      }
    }
  }

  // 월루모드 시트 판
  if (isStealth() && boardCells.length) {
    const moveNum = {};
    moves.forEach((m, i) => (moveNum[m.r + "," + m.c] = i + 1));
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const td = boardCells[r][c];
        td.className = "xl-board-cell";
        td.textContent = "";
        if (board[r] && board[r][c]) {
          td.classList.add(board[r][c] === myColor ? "xf-me" : "xf-op");
          td.textContent = moveNum[r + "," + c];
          if (last && last.r === r && last.c === c) td.classList.add("xl-sel");
          if (winKey.has(r + "," + c)) td.classList.add("xl-range");
        } else if (showForbid && isForbidden(board, r, c)) {
          td.classList.add("xl-forbid");
          td.textContent = "·";
        }
      }
    }
    el("xl-namebox").textContent = last ? sheetAddr(last.r, last.c) : "A1";
    el("xl-formula").textContent = last ? moveNum[last.r + "," + last.c] : "";
  }

  placeRematch();
  updateTurnUI();
}

function placeRematch() {
  const btn = el("btn-rematch");
  if (!gameOver) {
    el("sheet-stash").appendChild(btn);
    el("end-area").classList.add("hidden");
    return;
  }
  if (isStealth()) {
    if (rematchCell) {
      rematchCell.classList.add("xl-btn-cell");
      rematchCell.appendChild(btn);
    }
    btn.textContent = "재계산";
  } else {
    el("end-area").classList.remove("hidden");
    el("end-area").appendChild(btn);
    btn.textContent = "다시하기";
  }
}

function updateTurnUI() {
  if (gameOver) {
    const msg = isDraw ? "무승부입니다" : lastIWon ? "🎉 승리했습니다!" : "😢 패배했습니다";
    el("end-message").textContent = msg;
    el("turn-indicator-normal").textContent = "게임 종료";
    setTurnText(isDraw ? "월간 집계 완료 (변동 없음)" : "월간 집계 완료 · 재계산 가능");
    return;
  }
  const me = myColor === BLACK ? "⚫ 흑" : "⚪ 백";
  el("turn-indicator-normal").textContent = myTurn
    ? `내 차례입니다! (${me})`
    : `상대방의 차례입니다... (나: ${me})`;
  setTurnText(myTurn ? "검토 필요 항목 1건 · 입력 대기" : "외부 데이터 동기화 중...");
}

// ---------- 게임 진행 ----------
function setupGameScreen() {
  if (isStealth()) buildSheet();
}

function startGame() {
  if (gameStarted) return;
  gameStarted = true;
  gameOver = false;
  isDraw = false;
  winCells = null;
  board = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
  moves = [];
  // 첫 판은 방장이 흑(선공), 이후에는 진 사람이 흑
  myTurn = lastIWon === null ? isHost : !lastIWon;
  myColor = myTurn ? BLACK : WHITE;
  setupGameScreen();
  showScreen("game");
  renderAll();
}

function applyMove(r, c, color) {
  board[r][c] = color;
  moves.push({ r, c, color });
  const win = checkWin(board, r, c);
  if (win) {
    winCells = win;
    gameOver = true;
    lastIWon = color === myColor;
  } else if (moves.length === SIZE * SIZE) {
    gameOver = true;
    isDraw = true; // lastIWon 유지 → 다음 판 선공 규칙 그대로
  } else {
    myTurn = color !== myColor;
  }
  renderAll();
}

function tryPlace(r, c) {
  if (!gameStarted || gameOver || !myTurn) return;
  if (!inBoard(r, c) || board[r][c] !== 0) return;
  if (myColor === BLACK) {
    const forbidden = isForbidden(board, r, c);
    if (forbidden) {
      el("turn-indicator-normal").textContent = `${forbidden} 금수입니다! 다른 곳에 두세요.`;
      setTurnText("입력 불가 항목 · 다른 셀을 선택하세요");
      return;
    }
  }
  conn.send({ type: "move", r, c });
  applyMove(r, c, myColor);
}

// 클릭: 월루 시트 (판 셀은 착수, 그 외 셀은 가짜 선택만)
el("sheet-grid").addEventListener("click", (e) => {
  const td = e.target.closest("td");
  if (!td) return;
  if (td.dataset.r !== undefined) {
    tryPlace(parseInt(td.dataset.r, 10), parseInt(td.dataset.c, 10));
  } else if (!td.classList.contains("xl-rownum")) {
    // 빈 셀 클릭 = 이름 상자만 갱신 (자연스러운 방어)
    const tr = td.parentElement;
    if (tr.rowIndex > 0 && td.cellIndex > 0) {
      el("xl-namebox").textContent = colLetter(td.cellIndex - 1) + tr.rowIndex;
    }
  }
});

// 클릭: 일반 모드 판
el("board").addEventListener("click", (e) => {
  const d = e.target.closest(".bd-cell");
  if (!d) return;
  tryPlace(parseInt(d.dataset.r, 10), parseInt(d.dataset.c, 10));
});

function resetGame() {
  gameStarted = false;
  gameOver = false;
  isDraw = false;
  myTurn = false;
  winCells = null;
}

el("btn-rematch").addEventListener("click", () => {
  if (!gameOver) return;
  conn.send({ type: "rematch" });
  resetGame();
  startGame();
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (isStealth() && gameStarted && !screens.game.classList.contains("hidden")) {
      buildSheet();
      renderAll();
    }
  }, 150);
});

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
      conn.send({ type: "config", rule: "renju" });
      startGame();
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
      // 방장이 보내는 config를 받으면 게임 시작
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
    startGame();
  } else if (msg.type === "move") {
    if (!gameStarted || gameOver || myTurn) return; // 내 차례에 온 수는 무시
    const r = msg.r, c = msg.c;
    if (!inBoard(r, c) || board[r][c] !== 0) return;
    const oppColor = myColor === BLACK ? WHITE : BLACK;
    // 상대가 흑이면 금수 검증 (양쪽 클라이언트 동일 규칙)
    if (oppColor === BLACK && isForbidden(board, r, c)) return;
    applyMove(r, c, oppColor);
  } else if (msg.type === "rematch") {
    // 내가 이미 다시하기를 눌러 리셋된 상태면 무시 (동시 클릭 레이스 방지)
    if (!gameOver) return;
    resetGame();
    startGame();
  }
}

// 게임 상태 변수 선언 이후에 실행해야 함 (setStealth가 gameStarted를 참조)
// 명시적으로 끈 적이 없으면 월루모드가 기본
initNormalBoard();
setStealth(localStorage.getItem("omok-stealth") !== "0");

// ---------- 새 버전 감지 ----------
// 배포 시 APP_VERSION, version.json(version/updated), index.html의 ?v= 를 같이 올릴 것
const APP_VERSION = 1;

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
      const alreadyTried = sessionStorage.getItem("omok-reloaded") === String(v.version);
      if (idle && !alreadyTried) {
        // 아직 게임 전이면 자동 새로고침 (버전당 1회만 시도해 무한 루프 방지)
        sessionStorage.setItem("omok-reloaded", String(v.version));
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
