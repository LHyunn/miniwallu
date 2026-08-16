// rules.js 테스트 벡터 + 실행기. 브라우저(tests.html)와 Node(`node tests.js`) 양쪽에서 실행 가능.
import {
  MAHJONG, DOG, PHOENIX, DRAGON,
  rankOf, suitOf, isSpecial, sortHand, cardPoints,
  classify, phoenixSinglePower, beats, isBomb, findBombs, playableBombSet, comboName,
  legalPlays, wishObliged, scoreRound, dogTarget,
} from './rules.js';

// 카드 생성 헬퍼: suit(0..3) × rank(2..14) → smallint. rules.js의 인코딩과 동일해야 함.
function card(suit, rank) {
  return suit * 13 + (rank - 2);
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
// A. classify — 정형 조합
// ---------------------------------------------------------------------------

test('single 일반 카드: power=rank*2', () => {
  assertEqual(classify([card(0, 7)]), { type: 'single', power: 14, len: 1 });
});

test('single 마작: power=2', () => {
  assertEqual(classify([MAHJONG]), { type: 'single', power: 2, len: 1 });
});

test('single 용: power=40(고정)', () => {
  assertEqual(classify([DRAGON]), { type: 'single', power: 40, len: 1 });
});

test('pair: power=rank*2', () => {
  assertEqual(classify([card(0, 9), card(1, 9)]), { type: 'pair', power: 18, len: 2 });
});

test('triple: power=rank*2', () => {
  assertEqual(classify([card(0, 6), card(1, 6), card(2, 6)]), { type: 'triple', power: 12, len: 3 });
});

test('straight 5장(서로 다른 suit): power=top*2, type=straight(bombsf 아님)', () => {
  const r = classify([card(0, 3), card(1, 4), card(2, 5), card(3, 6), card(0, 7)]);
  assertEqual(r, { type: 'straight', power: 14, len: 5 });
});

test('straight 마작 최하단(1-2-3-4-5)', () => {
  const r = classify([MAHJONG, card(0, 2), card(1, 3), card(2, 4), card(3, 5)]);
  assertEqual(r, { type: 'straight', power: 10, len: 5 });
});

test('ladder 2쌍', () => {
  const r = classify([card(0, 5), card(1, 5), card(0, 6), card(1, 6)]);
  assertEqual(r, { type: 'ladder', power: 12, len: 4 });
});

test('ladder 3쌍', () => {
  const r = classify([card(0, 5), card(1, 5), card(0, 6), card(1, 6), card(0, 7), card(1, 7)]);
  assertEqual(r, { type: 'ladder', power: 14, len: 6 });
});

test('fullhouse: power=triple_rank*2', () => {
  const r = classify([card(0, 5), card(1, 5), card(2, 5), card(0, 6), card(1, 6)]);
  assertEqual(r, { type: 'fullhouse', power: 10, len: 5 });
});

test('bomb4: power=100+rank', () => {
  const r = classify([card(0, 9), card(1, 9), card(2, 9), card(3, 9)]);
  assertEqual(r, { type: 'bomb4', power: 109, len: 4 });
});

test('bombsf(같은 suit 5연속): power=1000*len+rank', () => {
  const r = classify([card(0, 3), card(0, 4), card(0, 5), card(0, 6), card(0, 7)]);
  assertEqual(r, { type: 'bombsf', power: 5007, len: 5 });
});

// ---------------------------------------------------------------------------
// B. classify — 무효 조합
// ---------------------------------------------------------------------------

test('4장짜리 "straight"(길이<5)는 무효', () => {
  assertNull(classify([card(0, 3), card(1, 4), card(2, 5), card(3, 6)]));
});

test('개가 섞인 조합은 무효', () => {
  assertNull(classify([DOG, card(0, 5)]));
});

test('개 단독도 무효(표준 타입 아님)', () => {
  assertNull(classify([DOG]));
});

test('마작이 스트레이트 중간에 끼면 무효', () => {
  assertNull(classify([card(0, 3), card(1, 4), MAHJONG, card(2, 6), card(3, 7)]));
});

test('연속 아닌 랭크 4장 묶음은 무효', () => {
  assertNull(classify([card(0, 3), card(1, 5), card(2, 9), card(3, 12)]));
});

test('용 + 다른 카드는 무효(용은 항상 단독)', () => {
  assertNull(classify([DRAGON, card(0, 5)]));
});

test('봉황 2장(비정상 입력) 방어적으로 무효', () => {
  assertNull(classify([PHOENIX, PHOENIX]));
});

// ---------------------------------------------------------------------------
// C. 봉황 결합
// ---------------------------------------------------------------------------

test('pair + 봉황: 대체값으로 power 계산(+1 없음)', () => {
  assertEqual(classify([card(0, 7), PHOENIX]), { type: 'pair', power: 14, len: 2 });
});

test('triple + 봉황', () => {
  assertEqual(classify([card(0, 7), card(1, 7), PHOENIX]), { type: 'triple', power: 14, len: 3 });
});

test('fullhouse: 자연 트리플 + 봉황(페어쪽) — 모호함 없음', () => {
  const r = classify([card(0, 5), card(1, 5), card(2, 5), card(0, 6), PHOENIX]);
  assertEqual(r, { type: 'fullhouse', power: 10, len: 5 }); // triple=5
});

test('fullhouse: 페어+페어+봉황 — 반드시 높은 쪽이 트리플', () => {
  const r = classify([card(0, 5), card(1, 5), card(0, 6), card(1, 6), PHOENIX]);
  assertEqual(r, { type: 'fullhouse', power: 12, len: 5 }); // triple=6 (더 높은 쪽 강제)
});

test('straight: 봉황은 top을 최대화하는 쪽으로 강제(4,5,6,7,+P → 4-8)', () => {
  const r = classify([card(0, 4), card(1, 5), card(2, 6), card(3, 7), PHOENIX]);
  assertEqual(r, { type: 'straight', power: 16, len: 5 }); // top=8
});

test('straight: 최댓값이 이미 A면 봉황은 하단 채움만 허용(J,Q,K,A,+P → 10-A)', () => {
  const r = classify([card(0, 11), card(1, 12), card(2, 13), card(3, 14), PHOENIX]);
  assertEqual(r, { type: 'straight', power: 28, len: 5 }); // top=A(14)
});

test('ladder: 봉황이 중간 랭크의 짝을 완성', () => {
  const r = classify([card(0, 5), card(1, 5), card(0, 6), card(0, 7), card(1, 7), PHOENIX]);
  assertEqual(r, { type: 'ladder', power: 14, len: 6 }); // 5-5,6-6(봉황),7-7
});

// ---------------------------------------------------------------------------
// D. 봉황 단독 순서
// ---------------------------------------------------------------------------

test('phoenixSinglePower: 리드 시 3', () => {
  assertEqual(phoenixSinglePower(null), 3);
});

test('phoenixSinglePower: K(26) 위 → 27', () => {
  assertEqual(phoenixSinglePower(26), 27);
});

test('phoenixSinglePower: A(28) 위 → 29', () => {
  assertEqual(phoenixSinglePower(28), 29);
});

test('phoenixSinglePower: 용(40) 위 → null(불가)', () => {
  assertEqual(phoenixSinglePower(40), null);
});

test('beats: 봉황 단독이 K 위를 이김', () => {
  assertTrue(beats([PHOENIX], [card(0, 13)]));
});

test('beats: 봉황 단독은 용을 못 이김', () => {
  assertFalse(beats([PHOENIX], [DRAGON]));
});

test('beats: 마작 단독은 어떤 싱글도 못 이김(항상 최저)', () => {
  assertFalse(beats([MAHJONG], [card(0, 2)]));
});

// ---------------------------------------------------------------------------
// E. 폭탄 사다리
// ---------------------------------------------------------------------------

test('bombsf(5장)는 항상 bomb4를 이김(랭크 무관)', () => {
  const sf = [card(0, 2), card(0, 3), card(0, 4), card(0, 5), card(0, 6)]; // top=6
  const b4 = [card(0, 14), card(1, 14), card(2, 14), card(3, 14)]; // A 폭탄
  assertTrue(beats(sf, b4));
});

test('bombsf(6장)는 더 낮은 bombsf(5장, 고랭크)도 이김(길이가 랭크보다 우선)', () => {
  const sf6 = [card(0, 2), card(0, 3), card(0, 4), card(0, 5), card(0, 6), card(0, 7)]; // top=7,len6
  const sf5 = [card(1, 10), card(1, 11), card(1, 12), card(1, 13), card(1, 14)]; // top=A,len5
  assertTrue(beats(sf6, sf5));
});

test('bomb4끼리는 rank 비교', () => {
  const low = [card(0, 5), card(1, 5), card(2, 5), card(3, 5)];
  const high = [card(0, 9), card(1, 9), card(2, 9), card(3, 9)];
  assertTrue(beats(high, low));
  assertFalse(beats(low, high));
});

// ---------------------------------------------------------------------------
// F. 기본 카드 함수
// ---------------------------------------------------------------------------

test('rankOf/suitOf: 일반 카드', () => {
  assertEqual(rankOf(card(2, 9)), 9);
  assertEqual(suitOf(card(2, 9)), 2);
});

test('rankOf: 마작=1, 개/봉황/용=null', () => {
  assertEqual(rankOf(MAHJONG), 1);
  assertEqual(rankOf(DOG), null);
  assertEqual(rankOf(PHOENIX), null);
  assertEqual(rankOf(DRAGON), null);
});

test('isSpecial', () => {
  assertFalse(isSpecial(card(0, 14)));
  assertTrue(isSpecial(MAHJONG));
  assertTrue(isSpecial(DRAGON));
});

test('cardPoints: 5/10/K/용/봉황 및 총합 100', () => {
  assertEqual(cardPoints([card(0, 5)]), 5);
  assertEqual(cardPoints([card(0, 10)]), 10);
  assertEqual(cardPoints([card(0, 13)]), 10);
  assertEqual(cardPoints([DRAGON]), 25);
  assertEqual(cardPoints([PHOENIX]), -25);
  assertEqual(cardPoints([card(0, 2)]), 0);
  const fullDeck = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) fullDeck.push(card(s, r));
  fullDeck.push(MAHJONG, DOG, PHOENIX, DRAGON);
  assertEqual(cardPoints(fullDeck), 100);
});

test('sortHand: 마작→개→2..A(suit순)→봉황→용', () => {
  const shuffled = [DRAGON, card(3, 5), PHOENIX, card(0, 5), DOG, MAHJONG];
  const sorted = sortHand(shuffled);
  assertEqual(sorted, [MAHJONG, DOG, card(0, 5), card(3, 5), PHOENIX, DRAGON]);
});

// ---------------------------------------------------------------------------
// G. wishObliged / legalPlays(소원)
// ---------------------------------------------------------------------------

test('wishObliged: 리드 상황에서 소원 랭크 보유 시 의무 발동', () => {
  const hand = [card(0, 9), card(1, 3)];
  assertTrue(wishObliged(hand, null, 9));
});

test('wishObliged: 소원 랭크를 아예 보유하지 않으면 자유', () => {
  const hand = [card(0, 3), card(1, 4)];
  assertFalse(wishObliged(hand, null, 9));
});

test('wishObliged: 보유해도 현재 낼 수 있는 조합으로 못 만들면 자유', () => {
  const hand = [card(0, 9), card(1, 5)]; // 싱글만 있음, 페어를 못 만듦
  const top = [card(2, 11), card(3, 11)]; // 상대는 J 페어
  assertFalse(wishObliged(hand, top, 9));
});

test('wishObliged: 봉황으로 대체된 카드는 소원을 충족시키지 못함', () => {
  const hand = [PHOENIX, card(0, 3)];
  assertFalse(wishObliged(hand, null, 9));
});

test('legalPlays: 소원 의무 시 충족 플레이 + 폭탄만 남고 나머지는 배제', () => {
  const hand = [
    card(0, 9), // 소원 랭크 싱글
    card(1, 3), card(2, 3), // 페어(소원 무관)
    card(0, 4), card(1, 4), card(2, 4), card(3, 4), // bomb4(소원 무관, 항상 예외)
  ];
  const plays = legalPlays(hand, null, 9);
  const containsWish = (c) => c.some((x) => rankOf(x) === 9);
  assertTrue(plays.every((c) => isBomb(c) || containsWish(c)), '모든 결과가 소원충족 또는 폭탄이어야 함');
  assertTrue(plays.some(containsWish), '소원충족 플레이가 포함되어야 함');
  assertTrue(plays.some(isBomb), '폭탄은 예외로 항상 포함되어야 함');
});

test('legalPlays: 소원 미해당이면 필터 없이 전체 후보 반환', () => {
  const hand = [card(0, 3), card(1, 3), card(0, 4)];
  const plays = legalPlays(hand, null, 9); // 손에 9가 없음
  const unfiltered = legalPlays(hand, null, null);
  assertEqual(plays.length, unfiltered.length);
});

// ---------------------------------------------------------------------------
// H. scoreRound
// ---------------------------------------------------------------------------

test('scoreRound: 일반 종료 — 카드점수 합 100 보존', () => {
  const r = scoreRound({
    outOrder: [0, 1, 2],
    tichu: [0, 0, 0, 0],
    takenPoints: [20, 10, 15, 5],
    loserHandPoints: 50,
  });
  assertEqual(r, { dA: 90, dB: 10 });
  assertEqual(r.dA + r.dB, 100);
});

test('scoreRound: 원투 피니시 — 고정 200/0(카드점수 무시)', () => {
  const r1 = scoreRound({ outOrder: [0, 2], tichu: [0, 0, 0, 0], takenPoints: [0, 0, 0, 0], loserHandPoints: 0 });
  assertEqual(r1, { dA: 200, dB: 0 });
  const r2 = scoreRound({ outOrder: [1, 3], tichu: [0, 0, 0, 0], takenPoints: [0, 0, 0, 0], loserHandPoints: 0 });
  assertEqual(r2, { dA: 0, dB: 200 });
});

test('scoreRound: 원투 아님(1·2등이 서로 다른 팀)이면 일반 정산으로 감', () => {
  const r = scoreRound({
    outOrder: [0, 1, 2],
    tichu: [0, 0, 0, 0],
    takenPoints: [0, 0, 0, 0],
    loserHandPoints: 100,
  });
  // outOrder[0]=0(A) outOrder[1]=1(B) — 파트너 아님 → 원투 아님, 일반 정산 적용됨
  assertEqual(r, { dA: 100, dB: 0 }); // loserSeat=3(B), firstTeam=A → 손패점수는 상대팀(A)행
});

test('scoreRound: 티츄 성공(+100)', () => {
  const r = scoreRound({
    outOrder: [0, 1, 2],
    tichu: [1, 0, 0, 0],
    takenPoints: [0, 0, 0, 0],
    loserHandPoints: 100,
  });
  assertEqual(r, { dA: 200, dB: 0 });
});

test('scoreRound: 티츄 실패(-100)', () => {
  const r = scoreRound({
    outOrder: [0, 1, 2],
    tichu: [0, 1, 0, 0],
    takenPoints: [0, 0, 0, 0],
    loserHandPoints: 100,
  });
  assertEqual(r, { dA: 100, dB: -100 });
});

test('scoreRound: 그랜드 티츄 성공/실패(+200/-200), 더블 티츄 독립 채점', () => {
  const r = scoreRound({
    outOrder: [0, 1, 2],
    tichu: [2, 0, 2, 0], // 세팀 파트너 둘 다 그랜드티츄 호출, 0만 1등
    takenPoints: [0, 0, 0, 0],
    loserHandPoints: 0,
  });
  assertEqual(r, { dA: 0, dB: 0 }); // +200(seat0 성공) -200(seat2 실패) = 0
});

test('scoreRound: 꼴찌의 파트너가 1등인 엣지케이스 — 트릭점수는 1등팀, 손패점수는 상대팀', () => {
  const r = scoreRound({
    outOrder: [1, 0, 2], // 1등=seat1(B팀), 꼴찌=seat3(B팀, seat1의 파트너)
    tichu: [0, 0, 0, 0],
    takenPoints: [10, 20, 5, 15],
    loserHandPoints: 50,
  });
  // firstTeam=B(seat1) → 꼴찌(seat3)가 딴 15점은 B로. oppOfLoser=A → 손패점수 50은 A로.
  assertEqual(r, { dA: 65, dB: 35 });
  assertEqual(r.dA + r.dB, 100);
});

// ---------------------------------------------------------------------------
// I. dogTarget
// ---------------------------------------------------------------------------

test('dogTarget: 파트너 생존 시 파트너에게', () => {
  assertEqual(dogTarget([], 0), 2);
});

test('dogTarget: 파트너 아웃 시 다음 생존자로', () => {
  assertEqual(dogTarget([2], 0), 3);
});

test('dogTarget: 파트너와 그다음 좌석까지 아웃이면 그다음 생존자로(자기 자신 제외)', () => {
  assertEqual(dogTarget([2, 3], 0), 1);
});

// ---------------------------------------------------------------------------
// J. findBombs / playableBombSet
// ---------------------------------------------------------------------------

test('findBombs: 같은 랭크 4장 = bomb4', () => {
  const hand = [card(0, 9), card(1, 9), card(2, 9), card(3, 9), card(0, 2)];
  assertEqual(findBombs(hand), [[card(0, 9), card(1, 9), card(2, 9), card(3, 9)]]);
});

test('findBombs: 같은 수트 5연속 = bombsf(최대 구간), 특수카드는 제외', () => {
  const hand = [card(1, 2), card(1, 3), card(1, 4), card(1, 5), card(1, 6), PHOENIX, DRAGON];
  assertEqual(findBombs(hand), [[card(1, 2), card(1, 3), card(1, 4), card(1, 5), card(1, 6)]]);
});

test('findBombs: 4연속/랭크 3장뿐이면 폭탄 없음', () => {
  const hand = [card(1, 2), card(1, 3), card(1, 4), card(1, 5), card(0, 9), card(2, 9), card(3, 9)];
  assertEqual(findBombs(hand), []);
});

test('playableBombSet: 열린 트릭(ladder)은 차례 밖이어도 폭탄 가능', () => {
  const hand = [card(1, 2), card(1, 3), card(1, 4), card(1, 5), card(1, 6)];
  const top = [card(0, 7), card(1, 7), card(0, 8), card(1, 8), card(0, 9), card(1, 9)];
  assertEqual([...playableBombSet(hand, top, false)].sort((a, b) => a - b), hand);
});

test('playableBombSet: 빈 트릭 + 내 차례 아님 = 불가', () => {
  const hand = [card(1, 2), card(1, 3), card(1, 4), card(1, 5), card(1, 6)];
  assertEqual(playableBombSet(hand, null, false).size, 0);
});

test('playableBombSet: 더 큰 폭탄 톱은 못 이기면 제외', () => {
  const hand = [card(0, 5), card(1, 5), card(2, 5), card(3, 5)]; // bomb4 power 105
  const top = [card(1, 2), card(1, 3), card(1, 4), card(1, 5)].concat([card(1, 6)]); // bombsf
  assertEqual(playableBombSet(hand, top, true).size, 0);
});

// ---------------------------------------------------------------------------
// K. comboName
// ---------------------------------------------------------------------------

test('comboName: 연속 페어는 랭크 범위 병기', () => {
  const cards = [card(0, 7), card(1, 7), card(0, 8), card(1, 8), card(0, 9), card(1, 9)];
  assertEqual(comboName(cards), '연속 페어 (7-9)');
});

test('comboName: 마작 최하단 스트레이트/개/무효', () => {
  assertEqual(comboName([MAHJONG, card(0, 2), card(1, 3), card(2, 4), card(3, 5)]), '스트레이트 (1-5)');
  assertEqual(comboName([DOG]), '개');
  assertEqual(comboName([card(0, 2), card(1, 5)]), null);
});

test('comboName: 스티플 폭탄 범위 / 페어', () => {
  assertEqual(comboName([card(1, 2), card(1, 3), card(1, 4), card(1, 5), card(1, 6)]), '폭탄 (2-6)');
  assertEqual(comboName([card(0, 12), card(3, 12)]), '페어');
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
