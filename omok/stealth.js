// 오목 월루모드 — 가짜 엑셀 시트 렌더러.
// 위장 원칙: 구조(크롬/그리드/조건부서식 색)로만 위장, 시트 안 텍스트는 게임 용어.
// 오목판 = 15x15 데이터 블록(돌 = 배경색 + 수순 숫자), 클릭 착수는 app.js의
// 문서 레벨 리스너가 data-r/c로 받는다. 오버레이(다음 판/새 게임)는 엑셀 다이얼로그 톤(stealth.css).
import { SIZE, BLACK, isForbidden } from "./rules.js";
import { setNameBox, setFormula } from "/assets/js/chrome.js";

const el = (id) => document.getElementById(id);

const BOARD_COL = 1; // 0열은 행 라벨
const BOARD_ROW = 3; // 0~2행: 제목/판·점수/안내

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

function nickOf(S, seat) {
  const p = S.players.find((p) => p.seat === seat);
  return p ? p.nickname : "?";
}

function statusText(S) {
  const b = S.board;
  if (S.game.status === "finished") return "게임 종료";
  if (b.status === "finished") {
    const why = b.winReason === "timeout" ? " (시간 초과)" : "";
    return `${nickOf(S, b.winnerSeat)} 승리${why} · 다음 판을 기다립니다`;
  }
  if (b.status === "playing") {
    const my = S.my.seat === b.blackSeat ? "흑" : "백";
    return b.turnSeat === S.my.seat ? `내 차례입니다! (${my})` : `${nickOf(S, b.turnSeat)}의 차례입니다... (나: ${my})`;
  }
  return "";
}

export function renderStealthGame(S) {
  const grid = el("sheet-grid");
  if (!grid) return;

  const ROW_H = 25, ROWNUM_W = 32, LABEL_W = 70, BOARD_W = 34, CELL_W = 90;

  const fillerCols = Math.max(4, Math.ceil((window.innerWidth - ROWNUM_W - LABEL_W - SIZE * BOARD_W) / CELL_W) + 1);
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
  grid.innerHTML = html;
  el("sheet").style.width = ROWNUM_W + LABEL_W + SIZE * BOARD_W + fillerCols * CELL_W + "px";

  const rows = Array.from(grid.rows).slice(1);
  const cell = (r, c) => rows[r].cells[1 + c];

  // 제목/판 정보/점수
  cell(0, 0).textContent = "오목";
  cell(0, 0).className = "xl-title-cell";
  cell(1, 0).textContent = `판 ${S.board.boardNo} · ${S.game.target}선승`;
  cell(1, 0).className = "xl-note";
  // 레전드는 각각 2칸 병합 (이름+점수가 한 칸 폭보다 길다)
  const isBlack0 = S.board.blackSeat === 0;
  const a = cell(1, SIZE + 1);
  a.textContent = `${nickOf(S, 0)}(${isBlack0 ? "흑" : "백"}) ${S.game.scoreA}`;
  a.className = S.my.seat === 0 ? "xl-legend-me" : "xl-legend-op";
  a.colSpan = 2;
  const b = cell(1, SIZE + 2);
  b.textContent = `${nickOf(S, 1)}(${isBlack0 ? "백" : "흑"}) ${S.game.scoreB}`;
  b.className = S.my.seat === 1 ? "xl-legend-me" : "xl-legend-op";
  b.colSpan = 2;
  rows[1].cells[1 + SIZE + 4].remove();
  rows[1].cells[1 + SIZE + 3].remove();

  // 안내
  cell(2, 0).textContent = "안내";
  cell(2, 0).className = "xl-label";
  const st = cell(2, 1);
  st.textContent = statusText(S);
  st.className = "xl-status-cell";
  st.colSpan = 8;
  for (let i = 0; i < 7; i++) rows[2].cells[3].remove();

  // 오목판 (행 라벨 = 행 번호)
  const bd = S.board;
  const last = S.moves.length ? S.moves[S.moves.length - 1] : null;
  const winKey = new Set(bd.winLine || []);
  const showForbid =
    bd.status === "playing" && bd.turnSeat === S.my.seat && S.my.seat === bd.blackSeat;
  const moveNum = {};
  S.moves.forEach((m) => (moveNum[m.r + "," + m.c] = m.seq));
  const myStone = S.my.seat === bd.blackSeat ? 1 : 2;

  for (let r = 0; r < SIZE; r++) {
    cell(BOARD_ROW + r, 0).textContent = String(r + 1);
    cell(BOARD_ROW + r, 0).className = "xl-note";
    for (let c = 0; c < SIZE; c++) {
      const td = cell(BOARD_ROW + r, BOARD_COL + c);
      td.className = "xl-board-cell";
      td.dataset.r = r;
      td.dataset.c = c;
      const v = bd.cells[r] ? bd.cells[r][c] : 0;
      if (v) {
        td.classList.add(v === myStone ? "xf-me" : "xf-op");
        td.textContent = moveNum[r + "," + c] || "";
        if (last && last.r === r && last.c === c) td.classList.add("xl-sel");
        if (winKey.has(r * SIZE + c + 1)) td.classList.add("xl-range");
      } else if (showForbid && isForbidden(bd.cells, r, c)) {
        td.classList.add("xl-forbid");
        td.textContent = "·";
      }
    }
  }

  // 이름 상자/수식 줄 = 마지막 수의 셀 주소/수순
  if (last) {
    setNameBox(colLetter(BOARD_COL + last.c) + (BOARD_ROW + last.r + 1));
    setFormula(String(last.seq));
  } else {
    setNameBox("A1");
    setFormula("");
  }
}
