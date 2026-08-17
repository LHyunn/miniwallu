// rules.js 테스트 벡터 + 실행기. 브라우저(tests.html)와 Node(`node tests.js`) 양쪽에서 실행 가능.
//
// 이 파일의 케이스는 assets/sql/tests/omok_rules_tests.sql의 A파트와 1:1로 대응한다
// (같은 이름/같은 보드/같은 기대값). SQL 포팅본이 JS와 "같게 틀리는지"를 확인하는 것이 목적이므로,
// 여기 기대값을 고칠 때는 SQL 쪽 A파트도 함께 고쳐야 한다.
import {
  SIZE, BLACK, WHITE, DIRS,
  inBoard, runCells, checkWin, fourKeysAt, isOpenFour, openThreeKeysAt, isForbiddenBasic, isForbidden,
} from './rules.js';

// 보드 생성 헬퍼: 흑/백 좌표 목록 → 15x15 2차원 배열.
// SQL 테스트의 _t_board(array[_ob_idx(r,c), ...], ...)와 같은 표기를 의도했다.
function mk(blacks = [], whites = []) {
  const bd = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
  for (const [r, c] of blacks) bd[r][c] = BLACK;
  for (const [r, c] of whites) bd[r][c] = WHITE;
  return bd;
}

// checkWin의 좌표 배열 → 1-based 평면 인덱스(오름차순). SQL _ob_check_win의 반환(win_line)과
// 같은 형태로 비교하기 위한 정규화. idx = r*15 + c + 1.
function idxLine(cells) {
  if (cells === null) return null;
  return cells.map(([r, c]) => r * SIZE + c + 1).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 미니 테스트 프레임워크
// ---------------------------------------------------------------------------

const TESTS = [];
function test(name, fn) {
  TESTS.push({ name, fn });
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg || ''} — expected ${e}, got ${a}`.trim());
  }
}
function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg || '조건이 참이어야 함');
}
function assertFalse(cond, msg) {
  if (cond) throw new Error(msg || '조건이 거짓이어야 함');
}
function assertNull(v, msg) {
  if (v !== null) throw new Error(`${msg || ''} — null이어야 하는데 ${JSON.stringify(v)}`.trim());
}

// ---------------------------------------------------------------------------
// A. checkWin — 승리 판정 (흑=정확히 5, 백=5 이상)
// ---------------------------------------------------------------------------

test('A1 가로 5목(흑) 승리', () => {
  const bd = mk([[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]);
  assertEqual(idxLine(checkWin(bd, 7, 7)), [109, 110, 111, 112, 113]);
});

test('A2 세로 5목(흑) 승리', () => {
  const bd = mk([[3, 7], [4, 7], [5, 7], [6, 7], [7, 7]]);
  assertEqual(idxLine(checkWin(bd, 5, 7)), [53, 68, 83, 98, 113]);
});

test('A3 대각(↘) 5목(흑) 승리', () => {
  const bd = mk([[3, 3], [4, 4], [5, 5], [6, 6], [7, 7]]);
  assertEqual(idxLine(checkWin(bd, 5, 5)), [49, 65, 81, 97, 113]);
});

test('A4 대각(↗) 5목(흑) 승리', () => {
  const bd = mk([[3, 7], [4, 6], [5, 5], [6, 4], [7, 3]]);
  assertEqual(idxLine(checkWin(bd, 5, 5)), [53, 67, 81, 95, 109]);
});

test('A5 흑 6목은 승리 아님(정확히 5만 인정)', () => {
  const bd = mk([[7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]);
  assertNull(checkWin(bd, 7, 5));
});

test('A6 백 6목은 승리(백은 5 이상)', () => {
  const bd = mk([], [[7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]);
  assertEqual(idxLine(checkWin(bd, 7, 5)), [108, 109, 110, 111, 112, 113]);
});

test('A7 백 5목 승리', () => {
  const bd = mk([], [[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]);
  assertEqual(idxLine(checkWin(bd, 7, 7)), [109, 110, 111, 112, 113]);
});

test('A8 4목은 승리 아님', () => {
  const bd = mk([[7, 4], [7, 5], [7, 6], [7, 7]]);
  assertNull(checkWin(bd, 7, 7));
});

test('A9 가장자리(0행) 5목 승리', () => {
  const bd = mk([[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]]);
  assertEqual(idxLine(checkWin(bd, 0, 0)), [1, 2, 3, 4, 5]);
});

// ---------------------------------------------------------------------------
// B. isForbidden — 흑 금수 (장목/사사/삼삼, 5 완성 우선)
// ---------------------------------------------------------------------------

test('B1 삼삼 금수(가로 열린3 + 세로 열린3)', () => {
  const bd = mk([[7, 5], [7, 6], [5, 7], [6, 7]]);
  assertEqual(isForbidden(bd, 7, 7), '삼삼');
});

test('B2 사사 금수(가로 사 + 세로 사)', () => {
  const bd = mk([[7, 3], [7, 4], [7, 5], [4, 6], [5, 6], [6, 6]]);
  assertEqual(isForbidden(bd, 7, 6), '사사');
});

test('B3 장목 금수(6목)', () => {
  const bd = mk([[7, 2], [7, 3], [7, 4], [7, 6], [7, 7]]);
  assertEqual(isForbidden(bd, 7, 5), '장목');
});

test('B4 사삼은 허용(null)', () => {
  const bd = mk([[7, 3], [7, 4], [7, 5], [5, 6], [6, 6]]);
  assertNull(isForbidden(bd, 7, 6));
});

test('B5 5완성이 장목보다 우선(null)', () => {
  const bd = mk([[7, 3], [7, 4], [7, 6], [7, 7], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5]]);
  assertNull(isForbidden(bd, 7, 5));
  // 같은 국면에서 실제로 5가 완성되는지도 확인(가로 라인이 승리 라인)
  const placed = mk([[7, 3], [7, 4], [7, 5], [7, 6], [7, 7], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5]]);
  assertEqual(idxLine(checkWin(placed, 7, 5)), [109, 110, 111, 112, 113]);
});

test('B6 5완성이 삼삼보다 우선(null)', () => {
  const bd = mk([[7, 3], [7, 4], [7, 6], [7, 7], [5, 5], [6, 5], [5, 3], [6, 4]]);
  assertNull(isForbidden(bd, 7, 5));
});

test('B7 이미 돌이 있는 자리는 판정 대상 아님(null)', () => {
  const bd = mk([[7, 7]]);
  assertNull(isForbidden(bd, 7, 7));
});

test('B8 빈 판 모서리(0,0)는 금수 아님(경계 밖 접근 없음)', () => {
  const bd = mk();
  assertNull(isForbidden(bd, 0, 0));
});

test('B9 벽에 붙은 3은 열린3이 아니므로 삼삼 아님(null)', () => {
  const bd = mk([[0, 5], [0, 6], [1, 7], [2, 7]]);
  assertNull(isForbidden(bd, 0, 7));
});

test('B10 상대 돌로 한쪽이 막힌 3은 열린3 아님 → 삼삼 아님(null)', () => {
  const bd = mk([[7, 5], [7, 6], [5, 7], [6, 7]], [[7, 4]]);
  assertNull(isForbidden(bd, 7, 7));
});

test('B11 완성점이 기본 금수(사사)면 그 3은 안 침 → 삼삼 아님(null)', () => {
  // 가로 3의 유일한 열린4 완성점 (7,8)이 사사 지점이라 발전 불가 → 세로 3만 남아 1개
  const bd = mk([[7, 5], [7, 6], [5, 7], [6, 7], [4, 8], [5, 8], [6, 8]], [[7, 3]]);
  assertNull(isForbidden(bd, 7, 7));
});

test('B12 백 돌로 이뤄진 삼삼 모양은 흑 금수가 아님(null)', () => {
  const bd = mk([], [[7, 5], [7, 6], [5, 7], [6, 7]]);
  assertNull(isForbidden(bd, 7, 7));
});

test('B13 isForbidden은 보드를 변경하지 않는다(임시 mutate 원복)', () => {
  const bd = mk([[7, 5], [7, 6], [5, 7], [6, 7]]);
  const before = JSON.stringify(bd);
  isForbidden(bd, 7, 7);
  assertEqual(JSON.stringify(bd), before, '판정 후 보드가 원복되어야 함');
});

// ---------------------------------------------------------------------------
// C. fourKeysAt / isOpenFour / openThreeKeysAt — 하위 판정
// ---------------------------------------------------------------------------

test('C1 fourKeysAt: 열린 사는 완성점이 둘이어도 키 1개(같은 4돌)', () => {
  const bd = mk([[7, 4], [7, 5], [7, 6], [7, 7]]);
  assertEqual(fourKeysAt(bd, 7, 7).size, 1);
});

test('C2 fourKeysAt: 사사면 키 2개', () => {
  const bd = mk([[7, 3], [7, 4], [7, 5], [7, 6], [4, 6], [5, 6], [6, 6]]);
  assertEqual(fourKeysAt(bd, 7, 6).size, 2);
});

test('C3 fourKeysAt: 3돌뿐이면 키 0개', () => {
  const bd = mk([[7, 5], [7, 6], [7, 7]]);
  assertEqual(fourKeysAt(bd, 7, 7).size, 0);
});

test('C4 isOpenFour: 양끝이 열린 4는 true', () => {
  const bd = mk([[7, 4], [7, 5], [7, 6], [7, 7]]);
  assertTrue(isOpenFour(bd, 7, 7, 0, 1));
});

test('C5 isOpenFour: 한쪽이 상대 돌로 막히면 false', () => {
  const bd = mk([[7, 4], [7, 5], [7, 6], [7, 7]], [[7, 3]]);
  assertFalse(isOpenFour(bd, 7, 7, 0, 1));
});

test('C6 isOpenFour: 완성 시 장목이 되는 쪽이 있으면 false', () => {
  const bd = mk([[7, 2], [7, 4], [7, 5], [7, 6], [7, 7]]);
  assertFalse(isOpenFour(bd, 7, 7, 0, 1));
});

test('C7 openThreeKeysAt: 단순 열린 3은 키 1개', () => {
  const bd = mk([[7, 5], [7, 6], [7, 7]]);
  assertEqual(openThreeKeysAt(bd, 7, 7).size, 1);
});

test('C8 openThreeKeysAt: 양쪽이 상대 돌로 막힌 3은 키 0개', () => {
  const bd = mk([[7, 5], [7, 6], [7, 7]], [[7, 4], [7, 8]]);
  assertEqual(openThreeKeysAt(bd, 7, 7).size, 0);
});

test('C9 openThreeKeysAt: 한쪽만 막혀도 반대쪽 완성점이 살아있으면 키 1개', () => {
  const bd = mk([[7, 5], [7, 6], [7, 7]], [[7, 3]]);
  assertEqual(openThreeKeysAt(bd, 7, 7).size, 1);
});

test('C10 openThreeKeysAt: 유일한 완성점이 기본 금수(사사)면 키 0개', () => {
  const bd = mk([[7, 5], [7, 6], [7, 7], [4, 8], [5, 8], [6, 8]], [[7, 3]]);
  assertEqual(openThreeKeysAt(bd, 7, 7).size, 0);
});

test('C11 isForbiddenBasic: 장목은 true', () => {
  const bd = mk([[7, 2], [7, 3], [7, 4], [7, 6], [7, 7]]);
  assertTrue(isForbiddenBasic(bd, 7, 5));
});

test('C12 isForbiddenBasic: 사사는 true', () => {
  const bd = mk([[7, 3], [7, 4], [7, 5], [4, 6], [5, 6], [6, 6]]);
  assertTrue(isForbiddenBasic(bd, 7, 6));
});

test('C13 isForbiddenBasic: 삼삼은 false(기본 금수는 장목/사사만)', () => {
  const bd = mk([[7, 5], [7, 6], [5, 7], [6, 7]]);
  assertFalse(isForbiddenBasic(bd, 7, 7));
});

test('C14 runCells/inBoard: 경계에서 판 밖으로 나가지 않는다', () => {
  const bd = mk([[0, 0], [0, 1], [0, 2]]);
  assertEqual(runCells(bd, 0, 0, 0, 1).length, 3);
  assertEqual(runCells(bd, 0, 0, 1, 0).length, 1);
  assertFalse(inBoard(-1, 0));
  assertFalse(inBoard(0, SIZE));
  assertTrue(inBoard(14, 14));
});

test('C15 상수/DIRS 노출 확인', () => {
  assertEqual([SIZE, BLACK, WHITE], [15, 1, 2]);
  assertEqual(DIRS, [[0, 1], [1, 0], [1, 1], [1, -1]]);
});

// ---------------------------------------------------------------------------
// 실행기
// ---------------------------------------------------------------------------

export function runTests() {
  const results = TESTS.map(({ name, fn }) => {
    try {
      fn();
      return { name, pass: true };
    } catch (e) {
      return { name, pass: false, error: e.message };
    }
  });
  return results;
}

export { TESTS };

if (typeof document === 'undefined') {
  const results = runTests();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} - ${r.name}${r.pass ? '' : ` :: ${r.error}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}
