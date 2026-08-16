// 티츄 규칙 엔진 — 순수 함수 모음 (외부 의존 없음, ES module)
//
// 근거 문서: docs/rules-spec.md (이 파일과 충돌하면 rules-spec.md가 항상 우선).
//
// 카드 인코딩(smallint 0..55): c<52 → suit=floor(c/13)(0옥/1검/2탑/3별), rank=c%13+2(2..14).
// 52=마작(rank=1) 53=개 54=봉황 55=용.
//
// 이 파일의 설계는 하나의 핵심 아이디어에 기대고 있다: classify()가 봉황이 낀 조합에 대해
// "가능한 모든 대체 랭크 중 power가 최대인 해석"을 스스로 고르도록 만들면, rules-spec.md §3.3
// (스트레이트 top 최대화 강제)과 §3.4(풀하우스 높은 쪽 트리플 강제)가 별도의 특수 처리 없이
// power 공식(top_rank*2, triple_rank*2)의 자연스러운 결과로 저절로 성립한다. legalPlays()의
// 모든 생성기는 이 성질에 기대어 "봉황을 어디에 쓸지"를 스스로 강제하지 않고 classify()에 위임한다.
//
// 명시적 가정(문서가 침묵하는 지점):
// 1) sortHand 표시 순서(마작→개→2..A(suit순)→봉황→용)는 순수 표시 관례이며 규칙에 영향 없다.
// 2) legalPlays는 (type,len,power)당 대표 카드 배열 1개만 반환한다(모든 suit 순열을 나열하지
//    않음) — 실제 어느 suit 카드를 낼지는 UI가 classify/beats로 직접 검증하는 몫으로 둔다.
// 3) 연속 페어(사다리)의 봉황 배치는 rules-spec.md §9-5에서 "미확정, 스트레이트와 동일한
//    top-우선을 권장안으로 제안"이라 명시하므로, classify()의 최대-power 브루트포스를 그대로
//    적용한다(스트레이트와 동일 메커니즘이라 별도 코드 불필요).
// 4) beats()에서 top(topCards)이 봉황 단독 싱글([PHOENIX])인 경우, 그 카드만으로는 그것이
//    리드로 냈는지(power=3) 이전 싱글 위에 얹은 것인지(power=P+1) 구분할 수 없다(원시 카드
//    배열에는 그 문맥이 없다). 이 모듈은 순수 함수만 다루고 트릭 히스토리를 별도로 받지 않으므로,
//    이 경우 power=3(리드로 냈다고 가정)으로 처리한다. 실제 게임 엔진이 트릭 상태를 별도로
//    추적한다면 이 케이스는 애초에 발생하지 않아야 한다.
//
// 중요 정정: 이 파일 작성 전 존재했던 구현 계획 초안(rules-spec.md가 아직 없던 시점에 작성됨)은
// §8.3의 "꼴찌가 딴 트릭 점수"와 "꼴찌의 남은 손패 점수"의 귀속 팀을 서로 뒤바꿔 설계했다.
// rules-spec.md §8.3-1/§9-17이 명시적으로 확정한 실제 규칙은: 꼴찌가 딴 트릭 점수는 1등의
// 팀으로, 꼴찌의 남은 손패 점수는 꼴찌의 상대팀으로 간다(둘을 혼동하기 쉽다고 스펙 스스로 경고).
// 이 파일은 rules-spec.md를 그대로 따른다.

export const MAHJONG = 52;
export const DOG = 53;
export const PHOENIX = 54;
export const DRAGON = 55;

// ---------------------------------------------------------------------------
// 1. 기본 카드 함수
// ---------------------------------------------------------------------------

export function suitOf(c) {
  return c < 52 ? Math.floor(c / 13) : null;
}

export function rankOf(c) {
  if (c < 52) return (c % 13) + 2;
  if (c === MAHJONG) return 1;
  return null; // 개/봉황/용은 고정 랭크 없음
}

export function isSpecial(c) {
  return c >= 52;
}

export function sortHand(cards) {
  const key = (c) => {
    if (c === MAHJONG) return -2;
    if (c === DOG) return -1;
    if (c === PHOENIX) return 1000;
    if (c === DRAGON) return 1001;
    return rankOf(c) * 10 + suitOf(c);
  };
  return cards.slice().sort((a, b) => key(a) - key(b));
}

function pointsOfCard(c) {
  if (c === DRAGON) return 25;
  if (c === PHOENIX) return -25;
  if (c === MAHJONG || c === DOG) return 0;
  const r = rankOf(c);
  if (r === 5) return 5;
  if (r === 10 || r === 13) return 10;
  return 0;
}

export function cardPoints(cards) {
  return cards.reduce((sum, c) => sum + pointsOfCard(c), 0);
}

// ---------------------------------------------------------------------------
// 2. classify — 조합 판정
// ---------------------------------------------------------------------------

function decode(c) {
  if (c === MAHJONG) return { rank: 1, suit: null };
  return { rank: rankOf(c), suit: suitOf(c) };
}

// dc: {rank, suit}[] (마작=rank1/suit null, 봉황 대체 카드=suit null로 표시됨).
// phoenixUsed: 이 조합에 봉황이 대체값으로 쓰였는지(폭탄류 배제용).
function classifyConcrete(dc, phoenixUsed) {
  const len = dc.length;
  const ranks = dc.map((c) => c.rank);
  const rankCounts = {};
  for (const r of ranks) rankCounts[r] = (rankCounts[r] || 0) + 1;
  const distinctRanks = Object.keys(rankCounts).map(Number);

  if (len === 1) {
    const r = ranks[0];
    return { type: 'single', power: r === 1 ? 2 : r * 2, len: 1 };
  }

  if (len === 2 && distinctRanks.length === 1 && distinctRanks[0] !== 1) {
    return { type: 'pair', power: distinctRanks[0] * 2, len: 2 };
  }

  if (len === 3 && distinctRanks.length === 1 && distinctRanks[0] !== 1) {
    return { type: 'triple', power: distinctRanks[0] * 2, len: 3 };
  }

  if (len === 4 && distinctRanks.length === 1 && distinctRanks[0] !== 1 && !phoenixUsed) {
    return { type: 'bomb4', power: 100 + distinctRanks[0], len: 4 };
  }

  if (len === 5 && distinctRanks.length === 2 && !distinctRanks.includes(1)) {
    const counts = distinctRanks.map((r) => rankCounts[r]);
    if (counts.includes(3) && counts.includes(2)) {
      const tripleRank = distinctRanks.find((r) => rankCounts[r] === 3);
      return { type: 'fullhouse', power: tripleRank * 2, len: 5 };
    }
  }

  if (
    len % 2 === 0 &&
    len >= 4 &&
    distinctRanks.length === len / 2 &&
    distinctRanks.every((r) => rankCounts[r] === 2) &&
    !distinctRanks.includes(1)
  ) {
    const sorted = distinctRanks.slice().sort((a, b) => a - b);
    const consecutive = sorted.every((r, i) => i === 0 || r === sorted[i - 1] + 1);
    if (consecutive) {
      return { type: 'ladder', power: sorted[sorted.length - 1] * 2, len };
    }
  }

  if (len >= 5 && distinctRanks.length === len && distinctRanks.every((r) => rankCounts[r] === 1)) {
    const sorted = ranks.slice().sort((a, b) => a - b);
    const consecutive = sorted.every((r, i) => i === 0 || r === sorted[i - 1] + 1);
    if (consecutive) {
      const topRank = sorted[sorted.length - 1];
      const suits = dc.map((c) => c.suit);
      const sameSuit = suits.every((s) => s !== null && s === suits[0]);
      if (sameSuit) {
        return { type: 'bombsf', power: 1000 * len + topRank, len };
      }
      return { type: 'straight', power: topRank * 2, len };
    }
  }

  return null;
}

export function classify(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  if (cards.includes(DOG)) return null; // 개는 어떤 표준 조합도 아님
  if (cards.includes(DRAGON)) {
    return cards.length === 1 ? { type: 'single', power: 40, len: 1 } : null;
  }

  const phoenixCount = cards.filter((c) => c === PHOENIX).length;
  if (phoenixCount > 1) return null;

  if (phoenixCount === 0) {
    return classifyConcrete(cards.map(decode), false);
  }

  if (cards.length === 1) {
    return { type: 'single', power: null, len: 1 }; // 봉황 단독: power는 문맥 의존(§phoenixSinglePower)
  }

  const others = cards.filter((c) => c !== PHOENIX).map(decode);
  let best = null;
  for (let r = 2; r <= 14; r++) {
    const trial = others.concat([{ rank: r, suit: null }]);
    const result = classifyConcrete(trial, true);
    if (result && (!best || result.power > best.power)) best = result;
  }
  return best;
}

export function isBomb(cards) {
  const c = classify(cards);
  return !!c && (c.type === 'bomb4' || c.type === 'bombsf');
}

// 손에 있는 폭탄 후보 열거: 같은 랭크 4장 + 같은 수트 5연속 이상(최대 구간).
export function findBombs(hand) {
  const bombs = [];
  const byRank = {};
  const bySuit = [[], [], [], []];
  for (const c of hand) {
    if (c >= 52) continue;
    const r = rankOf(c);
    (byRank[r] || (byRank[r] = [])).push(c);
    bySuit[suitOf(c)].push(c);
  }
  for (const r in byRank) {
    if (byRank[r].length === 4) bombs.push(byRank[r].slice());
  }
  for (const cards of bySuit) {
    const sorted = cards.slice().sort((a, b) => rankOf(a) - rankOf(b));
    let run = [];
    const flush = () => {
      if (run.length >= 5) bombs.push(run);
    };
    for (const c of sorted) {
      if (run.length && rankOf(c) === rankOf(run[run.length - 1]) + 1) {
        run.push(c);
      } else {
        flush();
        run = [c];
      }
    }
    flush();
  }
  return bombs;
}

// 조합의 한국어 표기 (UI용). 스트레이트/연속 페어/스티플 폭탄은 랭크 범위를 병기한다.
const TYPE_NAME = {
  single: '싱글', pair: '페어', triple: '트리플', fullhouse: '풀하우스',
  straight: '스트레이트', ladder: '연속 페어', bomb4: '폭탄', bombsf: '폭탄',
};
const RANK_NAME = { 1: '1', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const rankName = (r) => RANK_NAME[r] || String(r);

export function comboName(cards) {
  if (cards && cards.length === 1 && cards[0] === DOG) return '개';
  const c = classify(cards);
  if (!c) return null;
  const name = TYPE_NAME[c.type] || c.type;
  if (c.type === 'straight' || c.type === 'bombsf') {
    const top = c.type === 'bombsf' ? c.power % 1000 : c.power / 2;
    return `${name} (${rankName(top - c.len + 1)}-${rankName(top)})`;
  }
  if (c.type === 'ladder') {
    const top = c.power / 2;
    return `${name} (${rankName(top - c.len / 2 + 1)}-${rankName(top)})`;
  }
  return name;
}

// 지금 낼 수 있는 폭탄에 속한 카드 집합.
// topCards: 현재 트릭 톱의 카드 배열(트릭이 비었으면 null), myTurn: 내 차례 여부.
// 트릭이 비어 있으면 리드로만(=내 차례일 때만) 폭탄을 낼 수 있고,
// 트릭이 열려 있으면 차례와 무관하게 톱을 이기는 폭탄을 낼 수 있다.
export function playableBombSet(hand, topCards, myTurn) {
  const out = new Set();
  if (!topCards && !myTurn) return out;
  for (const bomb of findBombs(hand)) {
    if (!topCards || beats(bomb, topCards)) {
      for (const c of bomb) out.add(c);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. 봉황 싱글 파워 / beats
// ---------------------------------------------------------------------------

export function phoenixSinglePower(topPower) {
  if (topPower === null || topPower === undefined) return 3; // 리드
  if (topPower === 40) return null; // 용 위로는 못 감
  return topPower + 1;
}

export function beats(playCards, topCards) {
  const p = classify(playCards);
  const t = classify(topCards);
  if (!p || !t) return false;

  const pBomb = p.type === 'bomb4' || p.type === 'bombsf';
  const tBomb = t.type === 'bomb4' || t.type === 'bombsf';
  if (pBomb && !tBomb) return true;
  if (!pBomb && tBomb) return false;
  if (pBomb && tBomb) return p.power > t.power;

  if (p.type !== t.type || p.len !== t.len) return false;

  // top이 봉황 단독(power=null)이면 리드로 낸 것으로 가정(§가정 4).
  const tPower = t.type === 'single' && t.power === null ? 3 : t.power;

  if (p.type === 'single' && p.power === null) {
    const eff = phoenixSinglePower(tPower);
    return eff !== null && eff > tPower;
  }
  return p.power > tPower;
}

// ---------------------------------------------------------------------------
// 4. legalPlays / wishObliged
// ---------------------------------------------------------------------------

function buildRealByRank(hand) {
  const map = {};
  for (const c of hand) {
    if (c < 52) {
      const r = rankOf(c);
      (map[r] || (map[r] = [])).push(c);
    }
  }
  return map;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const c of candidates) {
    let key;
    if (c.length === 1 && c[0] === DOG) {
      key = 'dog';
    } else {
      const cls = classify(c);
      if (!cls) continue;
      key = `${cls.type}:${cls.len}:${cls.power}`;
    }
    if (!seen.has(key)) {
      seen.add(key);
      result.push(c);
    }
  }
  return result;
}

function rawLegalCandidates(hand, top) {
  const hasPhoenix = hand.includes(PHOENIX);
  const hasMahjong = hand.includes(MAHJONG);
  const hasDog = hand.includes(DOG);
  const hasDragon = hand.includes(DRAGON);
  const realByRank = buildRealByRank(hand);

  const candidates = [];

  // 싱글
  for (let r = 2; r <= 14; r++) {
    if (realByRank[r] && realByRank[r].length > 0) candidates.push([realByRank[r][0]]);
  }
  if (hasMahjong) candidates.push([MAHJONG]);
  if (hasDragon) candidates.push([DRAGON]);
  if (hasPhoenix) candidates.push([PHOENIX]);

  // 페어
  for (let r = 2; r <= 14; r++) {
    const reals = realByRank[r] || [];
    if (reals.length >= 2) candidates.push([reals[0], reals[1]]);
    else if (reals.length === 1 && hasPhoenix) candidates.push([reals[0], PHOENIX]);
  }

  // 트리플
  for (let r = 2; r <= 14; r++) {
    const reals = realByRank[r] || [];
    if (reals.length >= 3) candidates.push([reals[0], reals[1], reals[2]]);
    else if (reals.length === 2 && hasPhoenix) candidates.push([reals[0], reals[1], PHOENIX]);
  }

  // 폭탄(4장)
  for (let r = 2; r <= 14; r++) {
    const reals = realByRank[r] || [];
    if (reals.length === 4) candidates.push([...reals]);
  }

  // 스트레이트(마작=rank1 자리는 마작 실물 카드만 채움)
  for (let len = 5; len <= 14; len++) {
    for (let s = 1; s + len - 1 <= 14; s++) {
      const hi = s + len - 1;
      const window = [];
      let missing = 0;
      let ok = true;
      for (let r = s; r <= hi; r++) {
        if (r === 1) {
          if (!hasMahjong) { ok = false; break; }
          window.push(MAHJONG);
        } else {
          const reals = realByRank[r] || [];
          if (reals.length > 0) {
            window.push(reals[0]);
          } else {
            missing++;
            if (missing > 1 || !hasPhoenix) { ok = false; break; }
            window.push(PHOENIX);
          }
        }
      }
      if (ok) candidates.push(window);
    }
  }

  // 폭탄(스트레이트 플러시) — 마작/봉황 참여 불가
  for (let suit = 0; suit <= 3; suit++) {
    for (let len = 5; len <= 14; len++) {
      for (let s = 2; s + len - 1 <= 14; s++) {
        const hi = s + len - 1;
        const window = [];
        let ok = true;
        for (let r = s; r <= hi; r++) {
          const c = suit * 13 + (r - 2);
          if (hand.includes(c)) window.push(c);
          else { ok = false; break; }
        }
        if (ok) candidates.push(window);
      }
    }
  }

  // 연속 페어(사다리, 마작 불가)
  for (let pairCount = 2; pairCount <= 7; pairCount++) {
    for (let s = 2; s + pairCount - 1 <= 14; s++) {
      const hi = s + pairCount - 1;
      const window = [];
      let usedPhoenix = false;
      let ok = true;
      for (let r = s; r <= hi; r++) {
        const reals = realByRank[r] || [];
        if (reals.length >= 2) {
          window.push(reals[0], reals[1]);
        } else if (reals.length === 1 && hasPhoenix && !usedPhoenix) {
          window.push(reals[0], PHOENIX);
          usedPhoenix = true;
        } else {
          ok = false; break;
        }
      }
      if (ok) candidates.push(window);
    }
  }

  // 풀하우스
  for (let tripleRank = 2; tripleRank <= 14; tripleRank++) {
    for (let pairRank = 2; pairRank <= 14; pairRank++) {
      if (tripleRank === pairRank) continue;
      const tReals = realByRank[tripleRank] || [];
      const pReals = realByRank[pairRank] || [];
      let cards = null;
      if (tReals.length >= 3 && pReals.length >= 2) {
        cards = [tReals[0], tReals[1], tReals[2], pReals[0], pReals[1]];
      } else if (tReals.length >= 3 && pReals.length === 1 && hasPhoenix) {
        cards = [tReals[0], tReals[1], tReals[2], pReals[0], PHOENIX];
      } else if (tReals.length === 2 && hasPhoenix && pReals.length >= 2) {
        cards = [tReals[0], tReals[1], PHOENIX, pReals[0], pReals[1]];
      }
      if (cards) candidates.push(cards);
    }
  }

  // 개(리드 전용)
  if (top === null && hasDog) candidates.push([DOG]);

  const valid = [];
  for (const c of candidates) {
    if (c.length === 1 && c[0] === DOG) {
      if (top === null) valid.push(c);
      continue;
    }
    const cls = classify(c);
    if (!cls) continue;
    if (top === null || beats(c, top)) valid.push(c);
  }

  return dedupeCandidates(valid);
}

export function legalPlays(hand, top, wishRank) {
  const candidates = rawLegalCandidates(hand, top);
  if (wishRank === null || wishRank === undefined) return candidates;

  const nonBombSatisfying = candidates.filter(
    (c) => !isBomb(c) && c.some((card) => rankOf(card) === wishRank)
  );
  if (nonBombSatisfying.length > 0) {
    const bombs = candidates.filter(isBomb);
    return [...nonBombSatisfying, ...bombs];
  }
  return candidates;
}

export function wishObliged(hand, top, wishRank) {
  if (wishRank === null || wishRank === undefined) return false;
  const candidates = rawLegalCandidates(hand, top);
  return candidates.some((c) => !isBomb(c) && c.some((card) => rankOf(card) === wishRank));
}

// ---------------------------------------------------------------------------
// 5. 라운드 정산
// ---------------------------------------------------------------------------

const teamOf = (seat) => seat % 2; // 0=A(좌석0,2), 1=B(좌석1,3)

export function scoreRound({ outOrder, tichu, takenPoints, loserHandPoints }) {
  let dA = 0;
  let dB = 0;
  const add = (team, pts) => {
    if (team === 0) dA += pts;
    else dB += pts;
  };

  const isDoubleWin = outOrder.length >= 2 && teamOf(outOrder[0]) === teamOf(outOrder[1]);

  if (isDoubleWin) {
    add(teamOf(outOrder[0]), 200);
  } else {
    const loserSeat = [0, 1, 2, 3].find((s) => !outOrder.includes(s));
    const firstTeam = teamOf(outOrder[0]);
    const oppOfLoserTeam = 1 - teamOf(loserSeat);

    for (let seat = 0; seat < 4; seat++) {
      if (seat === loserSeat) {
        add(firstTeam, takenPoints[seat]); // 꼴찌가 딴 트릭 점수 → 1등 팀
      } else {
        add(teamOf(seat), takenPoints[seat]);
      }
    }
    add(oppOfLoserTeam, loserHandPoints); // 꼴찌의 남은 손패 점수 → 상대팀
  }

  for (let seat = 0; seat < 4; seat++) {
    const t = tichu[seat];
    if (!t) continue;
    const bonus = t === 2 ? 200 : 100;
    const success = outOrder[0] === seat;
    add(teamOf(seat), success ? bonus : -bonus);
  }

  return { dA, dB };
}

export function dogTarget(outOrder, dogSeat) {
  const partner = (dogSeat + 2) % 4;
  if (!outOrder.includes(partner)) return partner;
  // 파트너가 아웃이면 시계방향으로 다음 생존자를 찾는다. dogSeat 자신에게는 리드가 되돌아갈 수
  // 없으므로(자기 자신에게 넘길 수 없음) 후보에서 제외한다.
  for (let i = 1; i <= 3; i++) {
    const candidate = (partner + i) % 4;
    if (candidate !== dogSeat && !outOrder.includes(candidate)) return candidate;
  }
  return null;
}
