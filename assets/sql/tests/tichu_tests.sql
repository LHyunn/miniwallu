-- ============================================================================
-- 티츄(Tichu) 서버 규칙 함수 패리티 테스트
--
-- 주의(중요): 이 파일이 검증하는 _classify/_beats/_card_points는 schema.sql에서
-- `revoke all on function ... from public;` 처리되어 authenticated/anon 등 일반 롤에는
-- 실행 권한이 없다. Postgres는 "소유자는 GRANT/REVOKE와 무관하게 자기 함수를 항상 실행할 수
-- 있다"는 규칙이 있으므로, 이 스크립트는 **Supabase 대시보드의 SQL Editor(postgres 롤, 즉
-- schema.sql을 최초 실행해 이 함수들을 만든 소유자 권한)에서만** 실행 가능하다. 애플리케이션
-- 코드(anon/authenticated 클라이언트)에서는 절대 호출할 수 없다.
--
-- 실행 방법: 이 파일 전체를 Supabase SQL Editor에 붙여넣고 실행한다. 재실행 전제 없음(임시
-- 헬퍼 함수를 만들고 끝에 정리한다) — 몇 번을 다시 실행해도 안전하다.
--
-- 검증 대상 문서: ../tests.js(rules.js 테스트 벡터, 기대값의 1차 출처) / ../docs/rules-spec.md
-- (규칙 서술) / ../sql/schema.sql (검증 대상 SQL 구현, 절대 수정하지 않음).
--
-- 구성: A=정형 조합 8종, B=무효 조합, C=봉황 결합, D=폭탄 사다리(_beats), E=_beats 일반 규칙,
-- F=카드점수(_card_points). 각 assert는 실패 시 raise exception으로 어느 케이스가, 무엇을
-- 기대했고 실제로 무엇이 나왔는지 출력한다. 전부 통과하면 마지막에 raise notice로 총 건수를
-- 출력한다.
-- ============================================================================

-- 카드 생성 헬퍼(suit 0..3, rank 2..14) → smallint. tests.js의 card(suit, rank)와 동일 공식
-- (suit*13+(rank-2)). 테스트 전용 임시 함수 — 파일 끝에서 drop한다.
create or replace function _test_card(s int, r int) returns smallint
language sql immutable as $$ select (s * 13 + (r - 2))::smallint $$;

-- 조건이 참(true)이 아니면(false든 null이든) 실패로 간주해 예외를 던지는 assert 헬퍼.
-- `is not true`를 쓰는 이유: `if not p_cond`는 p_cond가 null일 때 plpgsql에서 조용히
-- 넘어가 버그를 숨긴다(널을 성공으로 오인) — 이 함수는 그 함정을 피한다. 테스트 전용 임시
-- 함수 — 파일 끝에서 drop한다.
create or replace function _t_assert(p_cond boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FAIL: %', p_label;
  end if;
end;
$$;

do $$
declare
  MAHJONG constant smallint := 52;
  DOG constant smallint := 53;
  PHOENIX constant smallint := 54;
  DRAGON constant smallint := 55;

  v_ctype text; v_power int; v_len int;           -- classify 결과 1 (play / 첫 번째 조합)
  v_ctype2 text; v_power2 int; v_len2 int;         -- classify 결과 2 (top / 두 번째 조합, _beats용)
  v_pts int;                                       -- _card_points 결과
  v_count int := 0;
begin

  -- ==========================================================================
  -- A. _classify — 정형 조합 8종
  -- ==========================================================================

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,7)]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'single' and v_power = 14 and v_len = 1,
    format('A1 single 일반(power=rank*2): expected single/14/1, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[MAHJONG]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'single' and v_power = 2 and v_len = 1,
    format('A2 single 마작(power=2): expected single/2/1, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[DRAGON]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'single' and v_power = 40 and v_len = 1,
    format('A3 single 용(power=40 고정): expected single/40/1, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,9), _test_card(1,9)]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'pair' and v_power = 18 and v_len = 2,
    format('A4 pair(power=rank*2): expected pair/18/2, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,6), _test_card(1,6), _test_card(2,6)]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'triple' and v_power = 12 and v_len = 3,
    format('A5 triple(power=rank*2): expected triple/12/3, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,3), _test_card(1,4), _test_card(2,5), _test_card(3,6), _test_card(0,7)]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'straight' and v_power = 14 and v_len = 5,
    format('A6 straight 5장(서로 다른 suit, bombsf 아님): expected straight/14/5, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[MAHJONG, _test_card(0,2), _test_card(1,3), _test_card(2,4), _test_card(3,5)]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'straight' and v_power = 10 and v_len = 5,
    format('A7 straight 마작 최하단(1-2-3-4-5): expected straight/10/5, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,5), _test_card(1,5), _test_card(0,6), _test_card(1,6)]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'ladder' and v_power = 12 and v_len = 4,
    format('A8 ladder 2쌍: expected ladder/12/4, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,5), _test_card(1,5), _test_card(0,6), _test_card(1,6), _test_card(0,7), _test_card(1,7)]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'ladder' and v_power = 14 and v_len = 6,
    format('A9 ladder 3쌍: expected ladder/14/6, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,5), _test_card(1,5), _test_card(2,5), _test_card(0,6), _test_card(1,6)]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'fullhouse' and v_power = 10 and v_len = 5,
    format('A10 fullhouse(power=triple_rank*2): expected fullhouse/10/5, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,9), _test_card(1,9), _test_card(2,9), _test_card(3,9)]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'bomb4' and v_power = 109 and v_len = 4,
    format('A11 bomb4(power=100+rank): expected bomb4/109/4, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,3), _test_card(0,4), _test_card(0,5), _test_card(0,6), _test_card(0,7)]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'bombsf' and v_power = 5007 and v_len = 5,
    format('A12 bombsf(같은 suit 5연속, power=1000*len+rank): expected bombsf/5007/5, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  -- ==========================================================================
  -- B. _classify — 무효 조합(0행 = null)
  -- ==========================================================================

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,3), _test_card(1,4), _test_card(2,5), _test_card(3,6)]::smallint[]) limit 1;
  perform _t_assert(v_ctype is null,
    format('B1 4장짜리 "straight"(길이<5)는 무효: expected null, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[DOG, _test_card(0,5)]::smallint[]) limit 1;
  perform _t_assert(v_ctype is null,
    format('B2 개가 섞인 조합은 무효: expected null, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[DOG]::smallint[]) limit 1;
  perform _t_assert(v_ctype is null,
    format('B3 개 단독도 무효(표준 타입 아님): expected null, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,3), _test_card(1,4), MAHJONG, _test_card(2,6), _test_card(3,7)]::smallint[]) limit 1;
  perform _t_assert(v_ctype is null,
    format('B4 마작이 스트레이트 중간에 끼면 무효: expected null, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,3), _test_card(1,5), _test_card(2,9), _test_card(3,12)]::smallint[]) limit 1;
  perform _t_assert(v_ctype is null,
    format('B5 연속 아닌 랭크 4장 묶음은 무효: expected null, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[DRAGON, _test_card(0,5)]::smallint[]) limit 1;
  perform _t_assert(v_ctype is null,
    format('B6 용 + 다른 카드는 무효(용은 항상 단독): expected null, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[PHOENIX, PHOENIX]::smallint[]) limit 1;
  perform _t_assert(v_ctype is null,
    format('B7 봉황 2장(비정상 입력) 방어적으로 무효: expected null, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  -- ==========================================================================
  -- C. _classify — 봉황(Phoenix) 결합
  -- ==========================================================================

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,7), PHOENIX]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'pair' and v_power = 14 and v_len = 2,
    format('C1 pair+봉황(대체값 power, +1 없음): expected pair/14/2, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,7), _test_card(1,7), PHOENIX]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'triple' and v_power = 14 and v_len = 3,
    format('C2 triple+봉황: expected triple/14/3, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,5), _test_card(1,5), _test_card(2,5), _test_card(0,6), PHOENIX]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'fullhouse' and v_power = 10 and v_len = 5,
    format('C3 fullhouse: 자연 트리플(5)+봉황(페어쪽), 모호함 없음: expected fullhouse/10/5, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,5), _test_card(1,5), _test_card(0,6), _test_card(1,6), PHOENIX]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'fullhouse' and v_power = 12 and v_len = 5,
    format('C4 fullhouse: 페어(5)+페어(6)+봉황 → 반드시 높은 쪽(6)이 트리플: expected fullhouse/12/5, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,4), _test_card(1,5), _test_card(2,6), _test_card(3,7), PHOENIX]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'straight' and v_power = 16 and v_len = 5,
    format('C5 straight: 봉황은 top 최대화(4,5,6,7,+P → top=8): expected straight/16/5, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,11), _test_card(1,12), _test_card(2,13), _test_card(3,14), PHOENIX]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'straight' and v_power = 28 and v_len = 5,
    format('C6 straight: 최댓값이 이미 A면 봉황은 하단만(J,Q,K,A,+P → top=A): expected straight/28/5, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,5), _test_card(1,5), _test_card(0,6), _test_card(0,7), _test_card(1,7), PHOENIX]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'ladder' and v_power = 14 and v_len = 6,
    format('C7 ladder: 봉황이 중간 랭크(6)의 짝을 완성: expected ladder/14/6, got %s/%s/%s', v_ctype, v_power, v_len));
  v_count := v_count + 1;

  -- ==========================================================================
  -- D. _classify + _beats — 폭탄 사다리(길이/타입 무관 비교)
  -- ==========================================================================

  -- D1: 임의 스트레이트플러시(5장, top=6)는 임의 4장 폭탄(A)을 항상 이긴다.
  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,2), _test_card(0,3), _test_card(0,4), _test_card(0,5), _test_card(0,6)]::smallint[]) limit 1;
  select ctype, power, len into v_ctype2, v_power2, v_len2
  from _classify(array[_test_card(0,14), _test_card(1,14), _test_card(2,14), _test_card(3,14)]::smallint[]) limit 1;
  perform _t_assert(v_ctype = 'bombsf' and v_ctype2 = 'bomb4',
    format('D0 사전조건: D1의 두 조합이 각각 bombsf/bomb4로 분류되어야 함, got %s/%s', v_ctype, v_ctype2));
  v_count := v_count + 1;
  perform _t_assert(_beats(v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2) is true,
    format('D1 임의 SF(top=6,len5)는 임의 bomb4(A)를 이김: beats=%s (sf=%s/%s/%s, b4=%s/%s/%s)',
      _beats(v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2), v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2));
  v_count := v_count + 1;

  -- D2: 6장 스트레이트플러시(top=7)는 랭크가 더 높아도 5장짜리 스트레이트플러시(top=A)를 이긴다(길이 우선).
  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,2), _test_card(0,3), _test_card(0,4), _test_card(0,5), _test_card(0,6), _test_card(0,7)]::smallint[]) limit 1;
  select ctype, power, len into v_ctype2, v_power2, v_len2
  from _classify(array[_test_card(1,10), _test_card(1,11), _test_card(1,12), _test_card(1,13), _test_card(1,14)]::smallint[]) limit 1;
  perform _t_assert(_beats(v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2) is true,
    format('D2 bombsf(6장,top7)는 bombsf(5장,top A)를 이김(길이가 랭크보다 우선): beats=%s (sf6=%s/%s/%s, sf5=%s/%s/%s)',
      _beats(v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2), v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2));
  v_count := v_count + 1;

  -- D3/D4: bomb4끼리는 rank 비교.
  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,9), _test_card(1,9), _test_card(2,9), _test_card(3,9)]::smallint[]) limit 1;
  select ctype, power, len into v_ctype2, v_power2, v_len2
  from _classify(array[_test_card(0,5), _test_card(1,5), _test_card(2,5), _test_card(3,5)]::smallint[]) limit 1;
  perform _t_assert(_beats(v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2) is true,
    format('D3 bomb4(9)는 bomb4(5)를 이김: beats=%s', _beats(v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2)));
  v_count := v_count + 1;
  perform _t_assert(_beats(v_ctype2, v_power2, v_len2, v_ctype, v_power, v_len) is false,
    format('D4 bomb4(5)는 bomb4(9)를 못 이김: beats=%s', _beats(v_ctype2, v_power2, v_len2, v_ctype, v_power, v_len)));
  v_count := v_count + 1;

  -- ==========================================================================
  -- E. _beats — 일반 규칙(같은 타입/길이 + power, 타입불일치, 길이불일치, 폭탄 우선순위)
  -- ==========================================================================

  -- E1: 같은 타입/길이면 power 큰 쪽이 이김.
  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,9), _test_card(1,9)]::smallint[]) limit 1; -- pair 18
  select ctype, power, len into v_ctype2, v_power2, v_len2
  from _classify(array[_test_card(0,7), _test_card(1,7)]::smallint[]) limit 1; -- pair 14
  perform _t_assert(_beats(v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2) is true,
    format('E1 pair(18)은 pair(14)를 이김: beats=%s', _beats(v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2)));
  v_count := v_count + 1;

  -- E2: 타입이 다르면 power가 더 커도 못 이김(pair 18 vs triple 10).
  select ctype, power, len into v_ctype2, v_power2, v_len2
  from _classify(array[_test_card(0,5), _test_card(1,5), _test_card(2,5)]::smallint[]) limit 1; -- triple 10
  perform _t_assert(_beats(v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2) is false,
    format('E2 타입 불일치(pair vs triple)는 power 무관 항상 패배: beats=%s', _beats(v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2)));
  v_count := v_count + 1;

  -- E3/E4: 폭탄은 비-폭탄을 항상 이기고, 비-폭탄은 폭탄을 절대 못 이김.
  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,9), _test_card(1,9), _test_card(2,9), _test_card(3,9)]::smallint[]) limit 1; -- bomb4
  select ctype, power, len into v_ctype2, v_power2, v_len2
  from _classify(array[_test_card(0,3), _test_card(1,4), _test_card(2,5), _test_card(3,6), _test_card(0,7)]::smallint[]) limit 1; -- straight
  perform _t_assert(_beats(v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2) is true,
    format('E3 폭탄은 비-폭탄을 항상 이김: beats=%s', _beats(v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2)));
  v_count := v_count + 1;
  perform _t_assert(_beats(v_ctype2, v_power2, v_len2, v_ctype, v_power, v_len) is false,
    format('E4 비-폭탄은 폭탄을 절대 못 이김: beats=%s', _beats(v_ctype2, v_power2, v_len2, v_ctype, v_power, v_len)));
  v_count := v_count + 1;

  -- E5: 같은 타입이라도 길이가 다르면 power와 무관하게 못 이김(straight len6/power16 vs len5/power14).
  -- v_ctype2/v_power2/v_len2는 E3/E4에서 이미 구해둔 straight(top7,power14,len5)를 그대로 재사용한다(의도적).
  select ctype, power, len into v_ctype, v_power, v_len
  from _classify(array[_test_card(0,3), _test_card(1,4), _test_card(2,5), _test_card(3,6), _test_card(0,7), _test_card(1,8)]::smallint[]) limit 1; -- straight len6
  perform _t_assert(_beats(v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2) is false,
    format('E5 길이 불일치(straight len6/power16 vs len5/power14)는 power 무관 패배: beats=%s (%s/%s/%s vs %s/%s/%s)',
      _beats(v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2), v_ctype, v_power, v_len, v_ctype2, v_power2, v_len2));
  v_count := v_count + 1;

  -- ==========================================================================
  -- F. _card_points — 카드점수(합계 100)
  -- ==========================================================================

  select _card_points(array[_test_card(0,5)]::smallint[]) into v_pts;
  perform _t_assert(v_pts = 5, format('F1 5는 5점: expected 5, got %s', v_pts));
  v_count := v_count + 1;

  select _card_points(array[_test_card(0,10)]::smallint[]) into v_pts;
  perform _t_assert(v_pts = 10, format('F2 10은 10점: expected 10, got %s', v_pts));
  v_count := v_count + 1;

  select _card_points(array[_test_card(0,13)]::smallint[]) into v_pts;
  perform _t_assert(v_pts = 10, format('F3 K는 10점: expected 10, got %s', v_pts));
  v_count := v_count + 1;

  select _card_points(array[DRAGON]::smallint[]) into v_pts;
  perform _t_assert(v_pts = 25, format('F4 용은 +25점: expected 25, got %s', v_pts));
  v_count := v_count + 1;

  select _card_points(array[PHOENIX]::smallint[]) into v_pts;
  perform _t_assert(v_pts = -25, format('F5 봉황은 -25점: expected -25, got %s', v_pts));
  v_count := v_count + 1;

  select _card_points(array[_test_card(0,2)]::smallint[]) into v_pts;
  perform _t_assert(v_pts = 0, format('F6 그 외 랭크(2)는 0점: expected 0, got %s', v_pts));
  v_count := v_count + 1;

  select _card_points(
    array(select (s * 13 + (r - 2))::smallint from generate_series(0,3) s, generate_series(2,14) r)
    || array[MAHJONG, DOG, PHOENIX, DRAGON]
  ) into v_pts;
  perform _t_assert(v_pts = 100, format('F7 전체 56장 카드점수 합계=100: expected 100, got %s', v_pts));
  v_count := v_count + 1;

  raise notice '모든 패리티 테스트 통과 (%건)', v_count;
end $$;

-- 임시 헬퍼 정리(운영 스키마에 잔존시키지 않음).
drop function if exists _test_card(int, int);
drop function if exists _t_assert(boolean, text);
