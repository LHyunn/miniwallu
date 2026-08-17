// 월루모드 — 가짜 엑셀 렌더러 ("재고 현황" 보고서 위장).
// export function renderStealthGame(S): 호출될 때마다 #sheet-grid를 상태로부터 전량 재구성한다
// (omok/app.js buildSheet()와 동일한 기법: 글자행/행번호/명시적 셀 너비/빈 셀로 뷰포트 채우기).
// 리사이즈 시 재호출은 호출부(render.js/app.js) 책임 — 이 함수는 멱등적으로만 동작한다.
//
// 위장 원칙: 위장은 순수 시각 구조(엑셀 크롬/그리드/셀 톤)가 전담한다. 시트 안 텍스트는
// 게임 라벨 그대로 — 멀리서 봤을 때 일하는 화면으로 보이면 충분하고, 사무 용어 치환은 하지 않는다.
// (창 제목/리본/시트탭 등 엑셀 크롬 자체의 텍스트는 위장 구조의 일부라 유지)
// 카드 셀 표기: 랭크만(2..10/J/Q/K/A), 수트는 셀 색(조건부서식 톤)으로 구분.

import { sortHand, playableBombSet, comboName } from "./rules.js";

const el = (id) => document.getElementById(id);
// '님'으로 끝나는 닉네임(과장님 등)에 호칭이 중복 붙는 것 방지
const nim = (nick) => (nick || "").replace(/님$/, "") + "님";

const RANK_TEXT = { 11: "J", 12: "Q", 13: "K", 14: "A" };
const SPECIAL_TEXT = { 52: "마작", 53: "개", 54: "봉황", 55: "용" };

function rankText(c) {
  if (c >= 52) return SPECIAL_TEXT[c] || "??";
  const rank = (c % 13) + 2;
  return RANK_TEXT[rank] || String(rank);
}

function suitClass(c) {
  return c < 52 ? "xs-su" + Math.floor(c / 13) : "xs-special";
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

function lastNonPass(trick) {
  for (let i = trick.length - 1; i >= 0; i--) {
    if (!trick[i].isPass) return trick[i];
  }
  return null;
}

// 일반 모드(renderTurnIndicator/my-tichu 뱃지)와 같은 문구를 비고 셀 하나에 요약한다.
function statusText(S) {
  if (S.game.status === "finished") return "게임 종료";
  const phase = S.game.round.phase;
  const mySeat = S.my.seat;
  const me = mySeat != null ? S.game.players[mySeat] : null;
  let text;
  if (mySeat != null && S.game.round.pendingDragonSeat === mySeat) {
    text = "용을 상대에게 넘겨주세요.";
  } else if (S.game.round.pendingDragonSeat != null) {
    const p = S.game.players[S.game.round.pendingDragonSeat];
    text = (p ? nim(p.nickname) : "") + "이 용을 넘기는 중...";
  } else if (phase === "grand" && me && !me.grandDecided) {
    text = "라지 티츄를 선언하시겠습니까?";
  } else if (phase === "exchange" && me && !me.exchangeDone) {
    text = "교환할 카드 3장을 골라주세요.";
  } else if (phase === "scored") {
    text = "라운드 결과를 확인하세요.";
  } else {
    const myTurn = S.game.round.turnSeat === mySeat;
    const turnPlayer = S.game.players[S.game.round.turnSeat];
    text = myTurn
      ? "내 차례입니다!"
      : turnPlayer
      ? nim(turnPlayer.nickname) + "의 차례입니다..."
      : "";
  }
  if (phase !== "scored" && S.game.status !== "finished" && me && me.tichu > 0) {
    text += me.tichu === 2 ? " · 라지 티츄 선언 중" : " · 스몰 티츄 선언 중";
  }
  return text;
}

function deadlineSeconds(S) {
  const dl = S.game.round && S.game.round.turnDeadline;
  if (!dl || S.game.round.phase !== "play") return null;
  const ms = new Date(dl).getTime() - Date.now();
  if (!isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 1000));
}

const ITEM_COLS = 14;

// 고정 행 인덱스
const ROW_TITLE = 0;
const ROW_NOTE = 1;
const ROW_STATUS = 2;
const ROW_OPP_SECTION = 3;
const ROW_OPP_HEADER = 4;
const ROW_OPP_START = 5; // 5,6,7 (좌/건너편/우)
const ROW_TRICK_SECTION = 8;
const ROW_TRICK_INFO = 9;
const ROW_TRICK_ITEMS = 10;
const ROW_HAND_SECTION = 11;
const ROW_HAND_INFO = 12;
const ROW_HAND_ITEMS = 13;
const ROW_BTN = 14;

export function renderStealthGame(S) {
  const grid = el("sheet-grid");
  if (!grid) return;

  const ROW_H = 25,
    ROWNUM_W = 32,
    LABEL_W = 96,
    ITEM_W = 64,
    CELL_W = 90;

  // 버튼이 이전 그리드 안에 있으면 innerHTML 교체 때 파괴되므로 먼저 대피
  const stash = el("sheet-stash");
  const btnPlay = el("btn-play");
  const btnPass = el("btn-pass");
  const btnTichu = el("btn-tichu");
  if (stash && btnPlay) stash.appendChild(btnPlay);
  if (stash && btnPass) stash.appendChild(btnPass);
  if (stash && btnTichu) stash.appendChild(btnTichu);

  const hand = sortHand(S.my.hand || []);
  const rowBtn = ROW_BTN;
  const fixedRowsTotal = rowBtn + 1;

  const fillerCols = Math.max(
    2,
    Math.ceil((window.innerWidth - ROWNUM_W - LABEL_W - ITEM_COLS * ITEM_W) / CELL_W) + 1
  );
  const totalCols = 1 + ITEM_COLS + fillerCols;
  const totalRows = Math.max(fixedRowsTotal + 2, Math.ceil(window.innerHeight / ROW_H) + 2);

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

  // 품목코드 행 전용: 품목 열 구간(B..)을 셀 병합해 하나로 만들고, 그 안에
  // 좁은 칩 셀을 그린다 — 다른 행들의 열 폭에 영향을 주지 않기 위한 장치.
  const mergeItemCols = (r) => {
    const td = rows[r].cells[2]; // [0]=행번호, [1]=라벨 열, [2]=첫 품목 열
    td.colSpan = ITEM_COLS;
    td.className = "xs-item-strip";
    for (let i = 0; i < ITEM_COLS - 1; i++) rows[r].cells[3].remove();
    return td;
  };
  const cardChip = (c, clickable) => {
    const s = document.createElement("span");
    s.textContent = rankText(c);
    s.className = "xs-chip xs-item xs-rank-cell " + suitClass(c) + (clickable ? " xs-clickable" : "");
    if (clickable) s.dataset.card = String(c);
    return s;
  };
  // 긴 텍스트용 가로 병합 셀 (조합명 등 — 64px 단일 셀에서 잘리지 않게)
  const wideCell = (r, c, span) => {
    const td = rows[r].cells[1 + c];
    td.colSpan = span;
    td.className = "xs-item-strip";
    for (let i = 0; i < span - 1; i++) rows[r].cells[1 + c + 1].remove();
    return td;
  };

  // ---- 제목/메모 ----
  cell(ROW_TITLE, 0).textContent = "티츄";
  cell(ROW_TITLE, 0).className = "xl-title-cell";

  cell(ROW_NOTE, 0).textContent = "라운드 " + (S.game.roundNo || "-");
  cell(ROW_NOTE, 0).className = "xl-note";

  const myTeam = S.my.seat != null ? S.my.seat % 2 : 0;
  const aCell = cell(ROW_NOTE, 10);
  aCell.textContent = "A팀 " + S.game.scoreA + "점";
  aCell.className = myTeam === 0 ? "xl-legend-me" : "xl-legend-op";
  const bCell = cell(ROW_NOTE, 11);
  bCell.textContent = "B팀 " + S.game.scoreB + "점";
  bCell.className = myTeam === 1 ? "xl-legend-me" : "xl-legend-op";

  // ---- 안내(상태) / 남은 시간 ----
  cell(ROW_STATUS, 0).textContent = "안내";
  cell(ROW_STATUS, 0).className = "xl-label";
  const status = cell(ROW_STATUS, 1);
  const deadlineCellRef = cell(ROW_STATUS, 7); // colSpan으로 인덱스가 밀리기 전에 미리 참조 확보
  status.textContent = statusText(S);
  status.className = "xl-status-cell";
  status.colSpan = 6;
  for (let i = 0; i < 5; i++) rows[ROW_STATUS].cells[1 + 2].remove();

  const deadline = deadlineSeconds(S);
  if (deadline != null) {
    deadlineCellRef.textContent = "남은 시간 " + deadline + "초";
    deadlineCellRef.className = "xl-note";
  }

  // ---- 상대 현황 (상대 3명) ----
  cell(ROW_OPP_SECTION, 0).textContent = "상대 현황";
  cell(ROW_OPP_SECTION, 0).className = "xs-section";

  cell(ROW_OPP_HEADER, 0).textContent = "자리";
  cell(ROW_OPP_HEADER, 0).className = "xl-label";
  cell(ROW_OPP_HEADER, 1).textContent = "닉네임";
  cell(ROW_OPP_HEADER, 1).className = "xl-label";
  cell(ROW_OPP_HEADER, 2).textContent = "장수";
  cell(ROW_OPP_HEADER, 2).className = "xl-label";
  cell(ROW_OPP_HEADER, 3).textContent = "선언";
  cell(ROW_OPP_HEADER, 3).className = "xl-label";

  const mySeat = S.my.seat ?? 0;
  const order = [(mySeat + 3) % 4, (mySeat + 2) % 4, (mySeat + 1) % 4]; // 좌/건너편/우
  const opLabels = ["왼쪽", "파트너", "오른쪽"];
  order.forEach((seat, i) => {
    const p = S.game.players[seat];
    const r = ROW_OPP_START + i;
    cell(r, 0).textContent = opLabels[i];
    cell(r, 0).className = "xl-label";
    cell(r, 1).textContent = p ? p.nickname : "-";
    cell(r, 2).textContent = p ? p.handCount + "장" : "-";
    const st = cell(r, 3);
    st.textContent = p && p.tichu === 2 ? "라지 티츄" : p && p.tichu === 1 ? "스몰 티츄" : "";
    st.className = p && p.tichu ? "xs-urgent" : "";
  });

  // ---- 현재 트릭 (마지막 유효 플레이) ----
  cell(ROW_TRICK_SECTION, 0).textContent = "현재 트릭";
  cell(ROW_TRICK_SECTION, 0).className = "xs-section";

  const top = lastNonPass(S.game.trick || []);
  const fromPlayer = top ? S.game.players[top.seat] : null;
  cell(ROW_TRICK_INFO, 0).textContent = "낸 사람";
  cell(ROW_TRICK_INFO, 0).className = "xl-label";
  cell(ROW_TRICK_INFO, 1).textContent = fromPlayer ? fromPlayer.nickname : "-";
  cell(ROW_TRICK_INFO, 2).textContent = "장수";
  cell(ROW_TRICK_INFO, 2).className = "xl-label";
  cell(ROW_TRICK_INFO, 3).textContent = top ? top.cards.length + "장" : "-";

  cell(ROW_TRICK_ITEMS, 0).textContent = "카드";
  cell(ROW_TRICK_ITEMS, 0).className = "xl-label";
  const trickCombo = top ? comboName(top.cards || []) : null;
  if (trickCombo) wideCell(ROW_TRICK_INFO, 4, 4).textContent = trickCombo;
  const trickTd = mergeItemCols(ROW_TRICK_ITEMS);
  if (top && top.cards && top.cards.length) {
    top.cards.forEach((c) => trickTd.appendChild(cardChip(c, false)));
  } else {
    trickTd.textContent = "낸 카드 없음";
    trickTd.className = "xl-note";
  }

  // ---- 내 손패 (가로 한 줄 — 랭크 표기, 수트는 셀 색) ----
  cell(ROW_HAND_SECTION, 0).textContent = "내 손패";
  cell(ROW_HAND_SECTION, 0).className = "xs-section";

  const selection = new Set(S.my.selection || []);
  const meP = S.my.seat != null ? S.game.players[S.my.seat] : null;
  const inExchange = S.game.round.phase === "exchange" && meP && !meP.exchangeDone;
  // 교환 단계에서는 선택 카운터가 슬롯 채움 수를 가리키게 (그렇지 않으면 항상 0건으로 보임)
  const selCount = inExchange
    ? Object.values(S.my.exchange || {}).filter((v) => v != null).length
    : selection.size;
  cell(ROW_HAND_INFO, 0).textContent = "보유";
  cell(ROW_HAND_INFO, 0).className = "xl-label";
  cell(ROW_HAND_INFO, 1).textContent = hand.length + "장";
  cell(ROW_HAND_INFO, 2).textContent = "선택";
  cell(ROW_HAND_INFO, 2).className = "xl-label";
  cell(ROW_HAND_INFO, 3).textContent = selCount + (inExchange ? "/3장" : "장");
  if (!inExchange && S.game.round.phase === "play" && selection.size > 0) {
    wideCell(ROW_HAND_INFO, 4, 4).textContent = comboName(S.my.selection) || "유효하지 않은 조합";
  }

  cell(ROW_HAND_ITEMS, 0).textContent = "카드";
  cell(ROW_HAND_ITEMS, 0).className = "xl-label";
  const handTd = mergeItemCols(ROW_HAND_ITEMS);
  if (hand.length === 0) {
    handTd.textContent = "남은 카드 없음";
    handTd.className = "xl-note";
  } else {
    const bombSet =
      S.game.round.phase === "play" && S.game.round.pendingDragonSeat == null && S.my.seat != null
        ? playableBombSet(hand, top ? top.cards : null, S.game.round.turnSeat === S.my.seat)
        : new Set();
    hand.forEach((c) => {
      const chip = cardChip(c, true);
      if (selection.has(c)) chip.classList.add("xl-sel");
      if (bombSet.has(c)) chip.classList.add("xs-bomb");
      handTd.appendChild(chip);
    });
  }

  // ---- 조작 버튼 재부모화 (병합 셀 — '스몰 티츄'처럼 긴 라벨이 셀 폭에 잘리지 않게) ----
  cell(rowBtn, 0).textContent = "조작";
  cell(rowBtn, 0).className = "xl-label";
  const btnTd = mergeItemCols(rowBtn);
  btnTd.className = "xs-item-strip xl-btn-cell";
  if (btnPlay) btnTd.appendChild(btnPlay);
  if (btnPass) btnTd.appendChild(btnPass);
  if (btnTichu) btnTd.appendChild(btnTichu);
}

// 손패 셀 클릭 → 선택 토글 이벤트 발행 (app.js가 구독해 S.my.selection을 갱신).
// #sheet-grid는 index.html에 정적으로 존재하므로 모듈 로드 시 1회만 등록하면 된다.
// 크롬(#sheet-grid)은 mountChrome()이 나중에 주입하므로 document에 위임한다.
document.addEventListener("click", (e) => {
  const node = e.target.closest("#sheet-grid [data-card]");
  if (!node) return;
  const card = Number(node.dataset.card);
  window.dispatchEvent(new CustomEvent("stealth-card-toggle", { detail: { card } }));
});
