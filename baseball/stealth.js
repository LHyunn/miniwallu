// 숫자야구 월루모드 — 가짜 엑셀 시트 렌더러 (티츄 stealth.js와 같은 기법:
// 상태 → #sheet-grid 전량 재구성, 살아있는 input/버튼은 #sheet-stash로 대피 후 재배치).
// 위장 원칙: 구조(크롬/셀)로만 위장, 텍스트는 일반 게임 용어.

const el = (id) => document.getElementById(id);
const nim = (nick) => (nick || "").replace(/님$/, "") + "님";

const ITEM_COLS = 6; // 라벨 열 + 내용 6열(회|내 추측|판정| |상대 추측|판정) + 필러

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
  if (S.game.status === "finished") return "게임 종료";
  const r = S.round;
  if (r.status === "setting") {
    return S.round.secretsSet.includes(S.my.seat)
      ? "상대가 숫자를 정하는 중..."
      : `서로 다른 숫자 ${r.digits}자리를 정하세요`;
  }
  if (r.status === "playing") {
    return r.turnSeat === S.my.seat ? "내 차례입니다!" : nim(nickOf(S, r.turnSeat)) + "의 차례입니다...";
  }
  if (r.status === "finished") return nickOf(S, r.winnerSeat) + " 승리 · 다음 판을 기다립니다";
  return "";
}

// 일반 모드 렌더 전에 시트에 들어가 있던 컨트롤을 원위치로
export function restoreControls() {
  const secretRow = document.querySelector("#secret-phase .input-row");
  const guessRow = el("guess-row");
  for (const [id, host] of [
    ["secret-input", secretRow],
    ["btn-secret", secretRow],
    ["guess-input", guessRow],
    ["btn-guess", guessRow],
  ]) {
    const node = el(id);
    if (node && host && node.parentNode !== host) host.appendChild(node);
  }
}

export function renderStealthGame(S) {
  const grid = el("sheet-grid");
  if (!grid) return;

  const ROW_H = 25, ROWNUM_W = 32, LABEL_W = 96, ITEM_W = 78, CELL_W = 90;

  // 컨트롤 대피
  const stash = el("sheet-stash");
  ["secret-input", "btn-secret", "guess-input", "btn-guess"].forEach((id) => {
    const node = el(id);
    if (stash && node) stash.appendChild(node);
  });

  const rowsMine = S.guesses.filter((g) => g.seat === S.my.seat);
  const rowsOpp = S.guesses.filter((g) => g.seat === 1 - S.my.seat);
  const histLen = Math.max(rowsMine.length, rowsOpp.length);

  const R_TITLE = 0, R_NOTE = 1, R_STATUS = 2, R_SECRET = 3, R_SEC = 4, R_HEAD = 5, R_HIST = 6;
  const rowInput = R_HIST + histLen;
  const fixedRows = rowInput + 1;

  const fillerCols = Math.max(2, Math.ceil((window.innerWidth - ROWNUM_W - LABEL_W - ITEM_COLS * ITEM_W) / CELL_W) + 1);
  const totalCols = 1 + ITEM_COLS + fillerCols;
  const totalRows = Math.max(fixedRows + 2, Math.ceil(window.innerHeight / ROW_H) + 2);

  let html = '<tr class="xl-letters"><th class="xl-corner"></th>';
  for (let c = 0; c < totalCols; c++) {
    const w = c === 0 ? LABEL_W : c <= ITEM_COLS ? ITEM_W : CELL_W;
    html += `<th style="width:${w}px">${colLetter(c)}</th>`;
  }
  html += "</tr>";
  for (let r = 1; r <= totalRows; r++) {
    html += `<tr><td class="xl-rownum">${r}</td>${"<td></td>".repeat(totalCols)}</tr>`;
  }
  grid.innerHTML = html;
  el("sheet").style.width = ROWNUM_W + LABEL_W + ITEM_COLS * ITEM_W + fillerCols * CELL_W + "px";

  const rows = Array.from(grid.rows).slice(1);
  const cell = (r, c) => rows[r].cells[1 + c];

  // 제목/라운드/점수
  cell(R_TITLE, 0).textContent = "숫자야구";
  cell(R_TITLE, 0).className = "xl-title-cell";
  cell(R_NOTE, 0).textContent = `라운드 ${S.game.roundNo} · ${S.game.target}선승 · ${S.round.digits}자리`;
  cell(R_NOTE, 0).className = "xl-note";
  const a = cell(R_NOTE, 4);
  a.textContent = `${nickOf(S, 0)} ${S.game.scoreA}`;
  a.className = S.my.seat === 0 ? "xl-legend-me" : "xl-legend-op";
  const b = cell(R_NOTE, 5);
  b.textContent = `${nickOf(S, 1)} ${S.game.scoreB}`;
  b.className = S.my.seat === 1 ? "xl-legend-me" : "xl-legend-op";

  // 안내
  cell(R_STATUS, 0).textContent = "안내";
  cell(R_STATUS, 0).className = "xl-label";
  const st = cell(R_STATUS, 1);
  st.textContent = statusText(S);
  st.className = "xl-status-cell";
  st.colSpan = ITEM_COLS;
  for (let i = 0; i < ITEM_COLS - 1; i++) rows[R_STATUS].cells[3].remove();

  // 내 숫자
  cell(R_SECRET, 0).textContent = "내 숫자";
  cell(R_SECRET, 0).className = "xl-label";
  const sec = cell(R_SECRET, 1);
  if (S.my.secret) {
    S.my.secret.split("").forEach((d) => {
      const chip = document.createElement("span");
      chip.className = "xs-chip xs-digit";
      chip.textContent = d;
      sec.appendChild(chip);
    });
    sec.colSpan = ITEM_COLS;
    sec.className = "xs-item-strip";
    for (let i = 0; i < ITEM_COLS - 1; i++) rows[R_SECRET].cells[3].remove();
  } else {
    sec.textContent = "미설정";
    sec.className = "xl-note";
  }

  // 기록
  cell(R_SEC, 0).textContent = "추측 기록";
  cell(R_SEC, 0).className = "xs-section";
  const heads = ["회", "내 추측", "판정", "", nickOf(S, S.my.seat != null ? 1 - S.my.seat : 1), "판정"];
  heads.forEach((h, i) => {
    if (!h) return;
    cell(R_HEAD, i).textContent = h;
    cell(R_HEAD, i).className = "xl-label";
  });
  for (let i = 0; i < histLen; i++) {
    cell(R_HIST + i, 0).textContent = String(i + 1);
    cell(R_HIST + i, 0).className = "xl-note";
    for (const [g, off] of [[rowsMine[i], 1], [rowsOpp[i], 4]]) {
      if (!g) continue;
      const gc = cell(R_HIST + i, off);
      gc.textContent = g.guess;
      gc.className = "xs-guess";
      const rc = cell(R_HIST + i, off + 1);
      const win = g.strikes === S.round.digits;
      rc.textContent = win ? "정답!" : g.strikes === 0 && g.balls === 0 ? "OUT" : `${g.strikes}S ${g.balls}B`;
      rc.className = win ? "xs-win" : "xs-call";
    }
  }

  // 조작 행 (병합 셀에 입력/버튼 재배치)
  cell(rowInput, 0).textContent = "조작";
  cell(rowInput, 0).className = "xl-label";
  const td = cell(rowInput, 1);
  td.colSpan = ITEM_COLS;
  td.className = "xs-item-strip xl-btn-cell";
  for (let i = 0; i < ITEM_COLS - 1; i++) rows[rowInput].cells[3].remove();

  const r = S.round;
  if (r.status === "setting" && !S.round.secretsSet.includes(S.my.seat)) {
    td.appendChild(el("secret-input"));
    td.appendChild(el("btn-secret"));
  } else if (r.status === "playing") {
    td.appendChild(el("guess-input"));
    td.appendChild(el("btn-guess"));
  }
  // 판/매치 종료 시 오버레이(다음 판/새 게임)가 다이얼로그로 뜬다
}
