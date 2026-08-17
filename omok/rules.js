// 오목 규칙 엔진 — 순수 함수 모음 (외부 의존 없음, ES module)
//
// 출처: omok/app.js:111-269의 렌주룰 판정부를 **로직 무수정**으로 추출해 export만 붙인 것이다.
// 보드는 15x15 2차원 배열 bd[r][c] (0=빈칸, 1=흑, 2=백)이며, 게임 상태에는 전혀 의존하지 않는다.
//
// 중요(패리티 전제): isForbidden은 "근사" 렌주룰이다 — 열린3의 완성점에 대해 장목/사사(기본
// 금수)만 검사하고 재귀적 삼삼까지는 파고들지 않는다. 서버(assets/sql/migrations/007_omok.sql)의
// _ob_* 함수들은 이 파일과 **같게 틀리는 것**이 목표다(정확성이 아니라 동치성).
//
// mutate 관례: 이 파일의 함수들은 판정 중 bd를 임시로 변경했다가 반드시 원복한다(호출 전후로
// bd는 동일하다). plpgsql 포팅본은 배열이 값 타입이라 원복 자체가 필요 없다.

export const SIZE = 15;
export const BLACK = 1; // 선공
export const WHITE = 2;

// ---------- 오목 규칙 (렌주룰: 흑만 금수) ----------
export const DIRS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

export function inBoard(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

// (r,c)를 포함해 방향으로 이어진 같은 색 연속 셀 목록
export function runCells(bd, r, c, dr, dc) {
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
export function checkWin(bd, r, c) {
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
export function fourKeysAt(bd, r, c) {
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
export function isOpenFour(bd, r, c, dr, dc) {
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
export function openThreeKeysAt(bd, r, c) {
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
export function isForbiddenBasic(bd, r, c) {
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
export function isForbidden(bd, r, c) {
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
