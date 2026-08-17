-- ============================================================================
-- 오목(Omok) 서버 규칙 함수 패리티 테스트
--
-- 주의(중요): 이 파일이 검증하는 _ob_* 함수는 007_omok.sql에서
-- `revoke all on function ... from public;` 처리되어 authenticated/anon 등 일반 롤에는
-- 실행 권한이 없다. Postgres는 "소유자는 GRANT/REVOKE와 무관하게 자기 함수를 항상 실행할 수
-- 있다"는 규칙이 있으므로, 이 스크립트는 **Supabase 대시보드의 SQL Editor(postgres 롤, 즉
-- 007을 실행해 이 함수들을 만든 소유자 권한)에서만** 실행 가능하다.
--
-- 실행 방법: 이 파일 전체를 Supabase SQL Editor에 붙여넣고 실행한다. 재실행 전제 없음(임시
-- 헬퍼/임시 테이블을 만들고 끝에 정리한다) — 몇 번을 다시 실행해도 안전하다.
--
-- 검증 대상 문서: ../../../omok/tests.js (기대값의 1차 출처 — A파트는 그 파일의 케이스와
-- 이름까지 1:1로 대응한다) / ../migrations/007_omok.sql (검증 대상 SQL 구현, 절대 수정하지 않음).
--
-- 목적은 "정확성"이 아니라 **JS와의 동치성**이다. isForbidden은 근사 렌주룰이므로 SQL도
-- 같은 방식으로 틀려야 한다.
--
-- 구성:
--   A파트 = 고전 케이스 36건(JS tests.js와 동일한 보드/기대값)
--   B파트 = gen-omok-vectors.html이 랜덤 자가대국으로 뽑은 벡터 대량 검증(데이터는 비어 있음)
-- ============================================================================

-- 좌표 목록으로 보드(smallint[225])를 만드는 테스트 헬퍼. 인덱스는 _ob_idx(r,c)로 준다
-- (tests.js의 mk([[r,c],...], [[r,c],...])와 같은 표기). 파일 끝에서 drop한다.
create or replace function _t_board(p_black int[], p_white int[]) returns smallint[]
language plpgsql immutable as $$
declare
  v_cells smallint[] := array_fill(0::smallint, array[225]);
  i int;
begin
  foreach i in array coalesce(p_black, '{}'::int[]) loop v_cells[i] := 1; end loop;
  foreach i in array coalesce(p_white, '{}'::int[]) loop v_cells[i] := 2; end loop;
  return v_cells;
end;
$$;

-- 승리 라인 비교용 정규화(오름차순). null은 null 그대로. 파일 끝에서 drop한다.
create or replace function _t_sort(p_arr int[]) returns int[]
language sql immutable as $$
  select case when p_arr is null then null
    else (select coalesce(array_agg(x order by x), '{}'::int[]) from unnest(p_arr) x) end
$$;

-- 조건이 참(true)이 아니면(false든 null이든) 실패로 간주해 예외를 던지는 assert 헬퍼.
-- `is not true`를 쓰는 이유: `if not p_cond`는 p_cond가 null일 때 plpgsql에서 조용히
-- 넘어가 버그를 숨긴다(널을 성공으로 오인). 파일 끝에서 drop한다.
create or replace function _t_assert(p_cond boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FAIL: %', p_label;
  end if;
end;
$$;


-- ============================================================================
-- A파트 — 고전 케이스 (omok/tests.js와 1:1)
-- ============================================================================

do $$
declare
  v_cells smallint[];
  v_count int := 0;
begin

  -- --------------------------------------------------------------------------
  -- A. _ob_check_win — 승리 판정 (흑=정확히 5, 백=5 이상)
  -- --------------------------------------------------------------------------

  v_cells := _t_board(array[_ob_idx(7,3), _ob_idx(7,4), _ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7)], '{}');
  perform _t_assert(_t_sort(_ob_check_win(v_cells, 7, 7)) = array[109,110,111,112,113],
    format('A1 가로 5목(흑) 승리: got %s', _t_sort(_ob_check_win(v_cells, 7, 7))));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(3,7), _ob_idx(4,7), _ob_idx(5,7), _ob_idx(6,7), _ob_idx(7,7)], '{}');
  perform _t_assert(_t_sort(_ob_check_win(v_cells, 5, 7)) = array[53,68,83,98,113],
    format('A2 세로 5목(흑) 승리: got %s', _t_sort(_ob_check_win(v_cells, 5, 7))));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(3,3), _ob_idx(4,4), _ob_idx(5,5), _ob_idx(6,6), _ob_idx(7,7)], '{}');
  perform _t_assert(_t_sort(_ob_check_win(v_cells, 5, 5)) = array[49,65,81,97,113],
    format('A3 대각(↘) 5목(흑) 승리: got %s', _t_sort(_ob_check_win(v_cells, 5, 5))));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(3,7), _ob_idx(4,6), _ob_idx(5,5), _ob_idx(6,4), _ob_idx(7,3)], '{}');
  perform _t_assert(_t_sort(_ob_check_win(v_cells, 5, 5)) = array[53,67,81,95,109],
    format('A4 대각(↗) 5목(흑) 승리: got %s', _t_sort(_ob_check_win(v_cells, 5, 5))));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,2), _ob_idx(7,3), _ob_idx(7,4), _ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7)], '{}');
  perform _t_assert(_ob_check_win(v_cells, 7, 5) is null,
    format('A5 흑 6목은 승리 아님: got %s', _ob_check_win(v_cells, 7, 5)));
  v_count := v_count + 1;

  v_cells := _t_board('{}', array[_ob_idx(7,2), _ob_idx(7,3), _ob_idx(7,4), _ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7)]);
  perform _t_assert(_t_sort(_ob_check_win(v_cells, 7, 5)) = array[108,109,110,111,112,113],
    format('A6 백 6목은 승리(백은 5 이상): got %s', _t_sort(_ob_check_win(v_cells, 7, 5))));
  v_count := v_count + 1;

  v_cells := _t_board('{}', array[_ob_idx(7,3), _ob_idx(7,4), _ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7)]);
  perform _t_assert(_t_sort(_ob_check_win(v_cells, 7, 7)) = array[109,110,111,112,113],
    format('A7 백 5목 승리: got %s', _t_sort(_ob_check_win(v_cells, 7, 7))));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,4), _ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7)], '{}');
  perform _t_assert(_ob_check_win(v_cells, 7, 7) is null,
    format('A8 4목은 승리 아님: got %s', _ob_check_win(v_cells, 7, 7)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(0,0), _ob_idx(0,1), _ob_idx(0,2), _ob_idx(0,3), _ob_idx(0,4)], '{}');
  perform _t_assert(_t_sort(_ob_check_win(v_cells, 0, 0)) = array[1,2,3,4,5],
    format('A9 가장자리(0행) 5목 승리: got %s', _t_sort(_ob_check_win(v_cells, 0, 0))));
  v_count := v_count + 1;

  -- --------------------------------------------------------------------------
  -- B. _ob_forbidden — 흑 금수 (overline=장목 / double-four=사사 / double-three=삼삼)
  --    JS isForbidden의 '장목'/'사사'/'삼삼'과 각각 대응한다.
  -- --------------------------------------------------------------------------

  v_cells := _t_board(array[_ob_idx(7,5), _ob_idx(7,6), _ob_idx(5,7), _ob_idx(6,7)], '{}');
  perform _t_assert(_ob_forbidden(v_cells, 7, 7) = 'double-three',
    format('B1 삼삼 금수(가로 열린3 + 세로 열린3): expected double-three, got %s', _ob_forbidden(v_cells, 7, 7)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,3), _ob_idx(7,4), _ob_idx(7,5), _ob_idx(4,6), _ob_idx(5,6), _ob_idx(6,6)], '{}');
  perform _t_assert(_ob_forbidden(v_cells, 7, 6) = 'double-four',
    format('B2 사사 금수(가로 사 + 세로 사): expected double-four, got %s', _ob_forbidden(v_cells, 7, 6)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,2), _ob_idx(7,3), _ob_idx(7,4), _ob_idx(7,6), _ob_idx(7,7)], '{}');
  perform _t_assert(_ob_forbidden(v_cells, 7, 5) = 'overline',
    format('B3 장목 금수(6목): expected overline, got %s', _ob_forbidden(v_cells, 7, 5)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,3), _ob_idx(7,4), _ob_idx(7,5), _ob_idx(5,6), _ob_idx(6,6)], '{}');
  perform _t_assert(_ob_forbidden(v_cells, 7, 6) is null,
    format('B4 사삼은 허용: expected null, got %s', _ob_forbidden(v_cells, 7, 6)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,3), _ob_idx(7,4), _ob_idx(7,6), _ob_idx(7,7),
                            _ob_idx(2,5), _ob_idx(3,5), _ob_idx(4,5), _ob_idx(5,5), _ob_idx(6,5)], '{}');
  perform _t_assert(_ob_forbidden(v_cells, 7, 5) is null,
    format('B5 5완성이 장목보다 우선: expected null, got %s', _ob_forbidden(v_cells, 7, 5)));
  v_count := v_count + 1;
  -- 같은 국면에서 실제로 5가 완성되는지도 확인(가로 라인이 승리 라인)
  v_cells := _t_board(array[_ob_idx(7,3), _ob_idx(7,4), _ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7),
                            _ob_idx(2,5), _ob_idx(3,5), _ob_idx(4,5), _ob_idx(5,5), _ob_idx(6,5)], '{}');
  perform _t_assert(_t_sort(_ob_check_win(v_cells, 7, 5)) = array[109,110,111,112,113],
    format('B5b 5완성 국면의 승리 라인은 가로: got %s', _t_sort(_ob_check_win(v_cells, 7, 5))));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,3), _ob_idx(7,4), _ob_idx(7,6), _ob_idx(7,7),
                            _ob_idx(5,5), _ob_idx(6,5), _ob_idx(5,3), _ob_idx(6,4)], '{}');
  perform _t_assert(_ob_forbidden(v_cells, 7, 5) is null,
    format('B6 5완성이 삼삼보다 우선: expected null, got %s', _ob_forbidden(v_cells, 7, 5)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,7)], '{}');
  perform _t_assert(_ob_forbidden(v_cells, 7, 7) is null,
    format('B7 이미 돌이 있는 자리는 판정 대상 아님: expected null, got %s', _ob_forbidden(v_cells, 7, 7)));
  v_count := v_count + 1;

  v_cells := _t_board('{}', '{}');
  perform _t_assert(_ob_forbidden(v_cells, 0, 0) is null,
    format('B8 빈 판 모서리(0,0)는 금수 아님: expected null, got %s', _ob_forbidden(v_cells, 0, 0)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(0,5), _ob_idx(0,6), _ob_idx(1,7), _ob_idx(2,7)], '{}');
  perform _t_assert(_ob_forbidden(v_cells, 0, 7) is null,
    format('B9 벽에 붙은 3은 열린3이 아니므로 삼삼 아님: expected null, got %s', _ob_forbidden(v_cells, 0, 7)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,5), _ob_idx(7,6), _ob_idx(5,7), _ob_idx(6,7)], array[_ob_idx(7,4)]);
  perform _t_assert(_ob_forbidden(v_cells, 7, 7) is null,
    format('B10 상대 돌로 한쪽이 막힌 3은 열린3 아님 → 삼삼 아님: expected null, got %s', _ob_forbidden(v_cells, 7, 7)));
  v_count := v_count + 1;

  -- 가로 3의 유일한 열린4 완성점 (7,8)이 사사 지점이라 발전 불가 → 세로 3만 남아 1개
  v_cells := _t_board(array[_ob_idx(7,5), _ob_idx(7,6), _ob_idx(5,7), _ob_idx(6,7),
                            _ob_idx(4,8), _ob_idx(5,8), _ob_idx(6,8)], array[_ob_idx(7,3)]);
  perform _t_assert(_ob_forbidden(v_cells, 7, 7) is null,
    format('B11 완성점이 기본 금수(사사)면 그 3은 안 침 → 삼삼 아님: expected null, got %s', _ob_forbidden(v_cells, 7, 7)));
  v_count := v_count + 1;

  v_cells := _t_board('{}', array[_ob_idx(7,5), _ob_idx(7,6), _ob_idx(5,7), _ob_idx(6,7)]);
  perform _t_assert(_ob_forbidden(v_cells, 7, 7) is null,
    format('B12 백 돌로 이뤄진 삼삼 모양은 흑 금수가 아님: expected null, got %s', _ob_forbidden(v_cells, 7, 7)));
  v_count := v_count + 1;

  -- (tests.js B13 "보드 원복"은 JS 전용 케이스다 — plpgsql 배열은 값 타입이라 해당 없음.)

  -- --------------------------------------------------------------------------
  -- C. _ob_four_keys / _ob_is_open_four / _ob_open_three_keys / _ob_forbidden_basic
  --    (fourKeys/openThreeKeys는 "돌을 이미 놓은" 보드를 받는다 — JS와 동일)
  -- --------------------------------------------------------------------------

  v_cells := _t_board(array[_ob_idx(7,4), _ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7)], '{}');
  perform _t_assert(coalesce(array_length(_ob_four_keys(v_cells, 7, 7), 1), 0) = 1,
    format('C1 fourKeys: 열린 사는 완성점이 둘이어도 키 1개: got %s',
      coalesce(array_length(_ob_four_keys(v_cells, 7, 7), 1), 0)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,3), _ob_idx(7,4), _ob_idx(7,5), _ob_idx(7,6),
                            _ob_idx(4,6), _ob_idx(5,6), _ob_idx(6,6)], '{}');
  perform _t_assert(coalesce(array_length(_ob_four_keys(v_cells, 7, 6), 1), 0) = 2,
    format('C2 fourKeys: 사사면 키 2개: got %s',
      coalesce(array_length(_ob_four_keys(v_cells, 7, 6), 1), 0)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7)], '{}');
  perform _t_assert(coalesce(array_length(_ob_four_keys(v_cells, 7, 7), 1), 0) = 0,
    format('C3 fourKeys: 3돌뿐이면 키 0개: got %s',
      coalesce(array_length(_ob_four_keys(v_cells, 7, 7), 1), 0)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,4), _ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7)], '{}');
  perform _t_assert(_ob_is_open_four(v_cells, 7, 7, 0, 1) is true,
    format('C4 isOpenFour: 양끝이 열린 4는 true: got %s', _ob_is_open_four(v_cells, 7, 7, 0, 1)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,4), _ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7)], array[_ob_idx(7,3)]);
  perform _t_assert(_ob_is_open_four(v_cells, 7, 7, 0, 1) is false,
    format('C5 isOpenFour: 한쪽이 상대 돌로 막히면 false: got %s', _ob_is_open_four(v_cells, 7, 7, 0, 1)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,2), _ob_idx(7,4), _ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7)], '{}');
  perform _t_assert(_ob_is_open_four(v_cells, 7, 7, 0, 1) is false,
    format('C6 isOpenFour: 완성 시 장목이 되는 쪽이 있으면 false: got %s', _ob_is_open_four(v_cells, 7, 7, 0, 1)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7)], '{}');
  perform _t_assert(coalesce(array_length(_ob_open_three_keys(v_cells, 7, 7), 1), 0) = 1,
    format('C7 openThreeKeys: 단순 열린 3은 키 1개: got %s',
      coalesce(array_length(_ob_open_three_keys(v_cells, 7, 7), 1), 0)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7)], array[_ob_idx(7,4), _ob_idx(7,8)]);
  perform _t_assert(coalesce(array_length(_ob_open_three_keys(v_cells, 7, 7), 1), 0) = 0,
    format('C8 openThreeKeys: 양쪽이 상대 돌로 막힌 3은 키 0개: got %s',
      coalesce(array_length(_ob_open_three_keys(v_cells, 7, 7), 1), 0)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7)], array[_ob_idx(7,3)]);
  perform _t_assert(coalesce(array_length(_ob_open_three_keys(v_cells, 7, 7), 1), 0) = 1,
    format('C9 openThreeKeys: 한쪽만 막혀도 반대쪽 완성점이 살아있으면 키 1개: got %s',
      coalesce(array_length(_ob_open_three_keys(v_cells, 7, 7), 1), 0)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,5), _ob_idx(7,6), _ob_idx(7,7),
                            _ob_idx(4,8), _ob_idx(5,8), _ob_idx(6,8)], array[_ob_idx(7,3)]);
  perform _t_assert(coalesce(array_length(_ob_open_three_keys(v_cells, 7, 7), 1), 0) = 0,
    format('C10 openThreeKeys: 유일한 완성점이 기본 금수(사사)면 키 0개: got %s',
      coalesce(array_length(_ob_open_three_keys(v_cells, 7, 7), 1), 0)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,2), _ob_idx(7,3), _ob_idx(7,4), _ob_idx(7,6), _ob_idx(7,7)], '{}');
  perform _t_assert(_ob_forbidden_basic(v_cells, 7, 5) is true,
    format('C11 forbiddenBasic: 장목은 true: got %s', _ob_forbidden_basic(v_cells, 7, 5)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,3), _ob_idx(7,4), _ob_idx(7,5), _ob_idx(4,6), _ob_idx(5,6), _ob_idx(6,6)], '{}');
  perform _t_assert(_ob_forbidden_basic(v_cells, 7, 6) is true,
    format('C12 forbiddenBasic: 사사는 true: got %s', _ob_forbidden_basic(v_cells, 7, 6)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(7,5), _ob_idx(7,6), _ob_idx(5,7), _ob_idx(6,7)], '{}');
  perform _t_assert(_ob_forbidden_basic(v_cells, 7, 7) is false,
    format('C13 forbiddenBasic: 삼삼은 false(기본 금수는 장목/사사만): got %s', _ob_forbidden_basic(v_cells, 7, 7)));
  v_count := v_count + 1;

  v_cells := _t_board(array[_ob_idx(0,0), _ob_idx(0,1), _ob_idx(0,2)], '{}');
  perform _t_assert(array_length(_ob_run_cells(v_cells, 0, 0, 0, 1), 1) = 3
                and array_length(_ob_run_cells(v_cells, 0, 0, 1, 0), 1) = 1
                and _ob_in(-1, 0) is false and _ob_in(0, 15) is false and _ob_in(14, 14) is true,
    'C14 runCells/inBoard: 경계에서 판 밖으로 나가지 않는다');
  v_count := v_count + 1;

  perform _t_assert(_ob_idx(0, 0) = 1 and _ob_idx(14, 14) = 225 and _ob_idx(7, 7) = 113,
    'C15 인덱스 규약 idx = r*15 + c + 1');
  v_count := v_count + 1;

  raise notice 'A파트(고전 케이스) 통과 (%건)', v_count;
end $$;


-- ============================================================================
-- B파트 — 랜덤 자가대국 벡터 패리티
--
-- 벡터 의미(모든 행은 "흑이 (r,c)에 둔다"는 전제다):
--   cells             : 착수 **전** 국면(흑=1/백=2/빈=0, 길이 225). (r,c)는 반드시 빈 칸.
--   r, c              : 판정 대상 좌표
--   expect_win        : JS checkWin(흑 착수 후) 이 null이 아니었는가
--   expect_forbidden  : JS isForbidden(착수 전 보드) 결과를 SQL 코드로 매핑한 값
--                       ('장목'→'overline', '사사'→'double-four', '삼삼'→'double-three', null→null)
-- 백의 "5 이상 승리" 규칙은 A6/A7이 담당한다(벡터는 흑 관점 고정).
--
-- B파트: gen-omok-vectors.html로 생성한 벡터를 여기 붙여넣어 실행
--        생성기 출력은 용량 절약을 위해 위에서 만든 _t_board(array[흑], array[백]) 헬퍼를 쓰므로
--        반드시 이 파일 안(헬퍼 생성 이후 ~ drop 이전)에 붙여넣어야 한다.
--        (SQL Editor 입력 한도에 걸리면 INSERT 덩어리를 2~3개로 쪼개 순서대로 붙여넣는다 —
--         임시 테이블은 세션이 유지되는 동안 남아 있다.)
-- ============================================================================

create temp table _t_omok_vectors (
  cells smallint[],
  r int,
  c int,
  expect_win boolean,
  expect_forbidden text
);

-- ↓↓↓ 여기에 gen-omok-vectors.html의 출력(insert into _t_omok_vectors ... ;)을 붙여넣는다 ↓↓↓

-- ↑↑↑ 붙여넣기 끝 ↑↑↑

do $$
declare
  v record;
  v_cells smallint[];
  v_win boolean;
  v_forb text;
  v_total int := 0;
  v_fail int := 0;
begin
  for v in select * from _t_omok_vectors loop
    v_total := v_total + 1;

    v_cells := v.cells;
    v_cells[_ob_idx(v.r, v.c)] := 1;             -- 흑 착수
    v_win := _ob_check_win(v_cells, v.r, v.c) is not null;
    v_forb := _ob_forbidden(v.cells, v.r, v.c);  -- 금수 판정은 착수 전 보드로

    if v_win is distinct from v.expect_win or v_forb is distinct from v.expect_forbidden then
      v_fail := v_fail + 1;
      if v_fail <= 20 then
        raise warning 'MISMATCH #% (r=%, c=%): win %/% forbidden %/%',
          v_total, v.r, v.c, v_win, v.expect_win, v_forb, v.expect_forbidden;
      end if;
    end if;
  end loop;

  if v_total = 0 then
    raise notice 'B파트 건너뜀 — 벡터가 비어 있다(gen-omok-vectors.html 출력을 붙여넣을 것)';
  elsif v_fail > 0 then
    raise exception 'B파트 패리티 실패: %건 / 총 %건 (앞의 warning 참고)', v_fail, v_total;
  else
    raise notice 'B파트 패리티 통과 (%건)', v_total;
  end if;
end $$;


-- 임시 헬퍼/테이블 정리(운영 스키마에 잔존시키지 않음).
drop table if exists _t_omok_vectors;
drop function if exists _t_board(int[], int[]);
drop function if exists _t_sort(int[]);
drop function if exists _t_assert(boolean, text);
