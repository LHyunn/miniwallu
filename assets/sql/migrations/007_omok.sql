-- ============================================================================
-- 007: 오목(Omok) — 서버 권위 판정 + 기보 + 렌주룰 금수 판정 plpgsql 포팅
--
-- 실행 방법: 이 파일 전체를 (005까지 적용된) 프로젝트의 SQL Editor에 한 번에 붙여넣어
-- 1회 실행한다. schema.sql / 002~005는 건드리지 않는다.
--
-- 원본 대응: omok/rules.js (= 구 omok/app.js:111-269에서 추출한 렌주 판정 순수 함수).
-- 아래 _ob_* 함수들은 그 파일의 함수와 1:1 대응하며, **일부러 같은 근사 규칙을 쓴다**.
-- isForbidden은 열린3의 완성점에 대해 장목/사사만 검사하는 근사 판정이다 — 서버는 JS와
-- "같게 틀려야" 한다(목표는 정확성이 아니라 동치성). 패리티 검증은
-- assets/sql/tests/omok_rules_tests.sql (A=고전 케이스, B=자가대국 생성 벡터).
--
-- 포팅 규약:
--  ① 보드는 smallint[225] 1차원 배열, idx = r*15 + c + 1 (1-based) — _ob_idx로 가둔다.
--  ② JS는 bd를 임시 mutate 후 복원하지만 plpgsql 배열은 값 타입이라 복원이 불필요하다
--     (지역 변수에 복사해 쓰면 호출자의 배열은 그대로다).
--  ③ openThreeKeys의 "완성점을 0으로 되돌린 뒤 isForbiddenBasic 검사" 순서는 그대로 지킨다
--     — 즉 basic 검사에는 완성점이 **비어 있는** 보드(=인자로 받은 p_cells)를 넘긴다.
--  ④ 키 문자열: JS는 "r,c" 문자열을 sort해서 잇지만 여기서는 1-based 인덱스를 숫자 정렬해
--     잇는다. 키는 "돌 집합의 동일성" 판별에만 쓰이므로(집합이 같으면 같은 키, 다르면 다른 키)
--     두 표현은 동치다.
--
-- 전체를 한 트랜잭션으로 묶는다(005 관례).
-- ============================================================================
begin;


-- ============================================================================
-- 1. 테이블 + RLS + Realtime
-- ============================================================================

-- ---------------------------------------------------------------------------
-- omok_boards: 한 "판"(세트 1국). 한 게임(games) 안에서 board_no가 1,2,3... 늘어난다.
-- 2인 매핑 규약(005): team 0 = seat 0, team 1 = seat 1, score_a/score_b = 판 승수.
-- ---------------------------------------------------------------------------
create table omok_boards (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  board_no int not null,
  status text not null default 'playing' check (status in ('playing', 'finished')),
  black_seat smallint not null check (black_seat in (0, 1)),
  turn_seat smallint check (turn_seat in (0, 1)),
  move_count int not null default 0,
  cells smallint[] not null check (array_length(cells, 1) = 225),
  winner_seat smallint check (winner_seat in (0, 1)),
  win_reason text check (win_reason in ('five', 'timeout')),
  win_line int[],
  turn_deadline timestamptz,
  created_at timestamptz not null default now(),
  unique (game_id, board_no)
);

-- ---------------------------------------------------------------------------
-- omok_moves: 기보. cells가 이미 현재 국면의 스냅샷이므로 재생/복기 전용이다.
-- ---------------------------------------------------------------------------
create table omok_moves (
  board_id uuid not null references omok_boards(id) on delete cascade,
  seq int not null,
  seat smallint not null check (seat in (0, 1)),
  color smallint not null check (color in (1, 2)),
  r int not null check (r between 0 and 14),
  c int not null check (c between 0 and 14),
  created_at timestamptz not null default now(),
  primary key (board_id, seq)
);

-- RLS: 방 멤버만 SELECT. 쓰기 정책은 두지 않는다 — 모든 변경은 SECURITY DEFINER RPC로만.
alter table omok_boards enable row level security;
create policy omok_boards_select on omok_boards for select to authenticated using (
  game_id in (select id from games where is_room_member(room_id))
);

alter table omok_moves enable row level security;
create policy omok_moves_select on omok_moves for select to authenticated using (
  board_id in (select id from omok_boards where game_id in (select id from games where is_room_member(room_id)))
);

-- realtime: omok_boards만 추가한다. 클라이언트는 이 행의 version/cells 변화를 트리거로
-- get_omok_state 스냅샷을 다시 받으므로 omok_moves 브로드캐스트는 불필요하다.
alter publication supabase_realtime add table omok_boards;


-- ============================================================================
-- 2. 렌주룰 판정 함수 (전부 internal — public에서 EXECUTE 회수, grant 없음)
--    omok/rules.js와 1:1 대응. 순수 함수이므로 immutable.
-- ============================================================================

-- rules.js: (r,c) → 1-based 평면 인덱스. 모든 좌표 변환은 이 함수를 통한다.
create or replace function _ob_idx(p_r int, p_c int)
returns int
language sql
immutable
as $$ select p_r * 15 + p_c + 1 $$;
revoke all on function _ob_idx(int, int) from public;

-- rules.js: inBoard(r, c)
create or replace function _ob_in(p_r int, p_c int)
returns boolean
language sql
immutable
as $$ select p_r >= 0 and p_r < 15 and p_c >= 0 and p_c < 15 $$;
revoke all on function _ob_in(int, int) from public;

-- rules.js: runCells(bd, r, c, dr, dc)
-- (r,c)를 포함해 방향으로 이어진 같은 색 연속 셀의 인덱스 배열.
-- JS는 [move, +방향, -방향] 순으로 담지만 여기서는 **방향 벡터 기준 오름차순**으로 담는다
-- (JS가 isOpenFour에서 하는 sort와 같은 순서 → head=arr[1], tail=arr[n]).
-- 길이/포함 여부/집합만 쓰이므로 나머지 호출부에서도 동치다.
create or replace function _ob_run_cells(p_cells smallint[], p_r int, p_c int, p_dr int, p_dc int)
returns int[]
language plpgsql
immutable
as $$
declare
  v_color smallint := p_cells[_ob_idx(p_r, p_c)];
  v_back int[] := '{}';
  v_fwd int[] := '{}';
  rr int;
  cc int;
begin
  rr := p_r - p_dr; cc := p_c - p_dc;
  while _ob_in(rr, cc) and p_cells[_ob_idx(rr, cc)] = v_color loop
    v_back := array[_ob_idx(rr, cc)] || v_back;  -- 앞쪽에 붙여 오름차순 유지
    rr := rr - p_dr; cc := cc - p_dc;
  end loop;

  rr := p_r + p_dr; cc := p_c + p_dc;
  while _ob_in(rr, cc) and p_cells[_ob_idx(rr, cc)] = v_color loop
    v_fwd := v_fwd || _ob_idx(rr, cc);
    rr := rr + p_dr; cc := cc + p_dc;
  end loop;

  return v_back || _ob_idx(p_r, p_c) || v_fwd;
end;
$$;
revoke all on function _ob_run_cells(smallint[], int, int, int, int) from public;

-- rules.js: checkWin(bd, r, c) — 흑(1)은 정확히 5, 백(2)은 5 이상.
-- 승리 라인의 인덱스 배열 또는 null.
create or replace function _ob_check_win(p_cells smallint[], p_r int, p_c int)
returns int[]
language plpgsql
immutable
as $$
declare
  v_dirs int[] := array[[0, 1], [1, 0], [1, 1], [1, -1]];
  v_color smallint := p_cells[_ob_idx(p_r, p_c)];
  v_run int[];
  v_len int;
  d int;
begin
  for d in 1..4 loop
    v_run := _ob_run_cells(p_cells, p_r, p_c, v_dirs[d][1], v_dirs[d][2]);
    v_len := coalesce(array_length(v_run, 1), 0);
    if v_color = 2 and v_len >= 5 then return v_run; end if;
    if v_color = 1 and v_len = 5 then return v_run; end if;
  end loop;
  return null;
end;
$$;
revoke all on function _ob_check_win(smallint[], int, int) from public;

-- rules.js: fourKeysAt(bd, r, c)
-- 흑이 (r,c)에 둔 상태(p_cells에 이미 1이 놓여 있어야 함)에서 만들어지는 "사"의 키 목록.
-- 완성점 e가 둘이어도 같은 4돌이면 키가 같아 하나로 합쳐진다.
create or replace function _ob_four_keys(p_cells smallint[], p_r int, p_c int)
returns text[]
language plpgsql
immutable
as $$
declare
  v_dirs int[] := array[[0, 1], [1, 0], [1, 1], [1, -1]];
  v_keys text[] := '{}';
  v_move int := _ob_idx(p_r, p_c);
  v_tmp smallint[];
  v_run int[];
  v_stones int[];
  v_key text;
  v_e int;
  v_er int;
  v_ec int;
  v_dr int;
  v_dc int;
  d int;
  v_off int;
begin
  for d in 1..4 loop
    v_dr := v_dirs[d][1];
    v_dc := v_dirs[d][2];
    for v_off in -4 .. 4 loop
      if v_off = 0 then continue; end if;
      v_er := p_r + v_dr * v_off;
      v_ec := p_c + v_dc * v_off;
      if not _ob_in(v_er, v_ec) then continue; end if;
      v_e := _ob_idx(v_er, v_ec);
      if p_cells[v_e] <> 0 then continue; end if;

      v_tmp := p_cells;          -- 값 복사 — JS의 임시 mutate + 복원과 동일한 효과
      v_tmp[v_e] := 1;
      v_run := _ob_run_cells(v_tmp, v_er, v_ec, v_dr, v_dc);

      if coalesce(array_length(v_run, 1), 0) = 5 and v_move = any(v_run) then
        -- 완성점 e를 뺀 4개 돌이 "사"의 정체
        select coalesce(array_agg(x order by x), '{}'::int[]) into v_stones
        from unnest(v_run) x where x <> v_e;
        v_key := format('%s_%s:%s', v_dr, v_dc, array_to_string(v_stones, '|'));
        if not (v_key = any(v_keys)) then v_keys := v_keys || v_key; end if;
      end if;
    end loop;
  end loop;
  return v_keys;
end;
$$;
revoke all on function _ob_four_keys(smallint[], int, int) from public;

-- rules.js: isOpenFour(bd, r, c, dr, dc)
-- (r,c)를 포함한 방향의 연속이 정확히 4이고, 양끝 모두 "정확한 5"로 완성 가능한지.
create or replace function _ob_is_open_four(p_cells smallint[], p_r int, p_c int, p_dr int, p_dc int)
returns boolean
language plpgsql
immutable
as $$
declare
  v_run int[];
  v_len int;
  v_end int;
  v_sign int;
  v_er int;
  v_ec int;
  v_fr int;
  v_fc int;
  v_br int;
  v_bc int;
  i int;
begin
  v_run := _ob_run_cells(p_cells, p_r, p_c, p_dr, p_dc);
  v_len := coalesce(array_length(v_run, 1), 0);
  if v_len <> 4 then return false; end if;

  -- v_run은 방향 오름차순이므로 run[1]=head(JS sorted[0]), run[len]=tail(JS sorted[last]).
  for i in 1..2 loop
    if i = 1 then
      v_end := v_run[1]; v_sign := -1;
    else
      v_end := v_run[v_len]; v_sign := 1;
    end if;

    v_er := (v_end - 1) / 15;   -- 인덱스 → 행(정수 나눗셈)
    v_ec := (v_end - 1) % 15;   -- 인덱스 → 열

    v_fr := v_er + p_dr * v_sign;
    v_fc := v_ec + p_dc * v_sign;
    if not _ob_in(v_fr, v_fc) or p_cells[_ob_idx(v_fr, v_fc)] <> 0 then
      return false;  -- 끝이 막힘
    end if;

    v_br := v_fr + p_dr * v_sign;
    v_bc := v_fc + p_dc * v_sign;
    if _ob_in(v_br, v_bc) and p_cells[_ob_idx(v_br, v_bc)] = 1 then
      return false;  -- 완성 시 장목
    end if;
  end loop;

  return true;
end;
$$;
revoke all on function _ob_is_open_four(smallint[], int, int, int, int) from public;

-- rules.js: isForbiddenBasic(bd, r, c) — 장목/사사만 보는 얕은 금수 판정(열린3 완성점 검증용).
-- 대상 칸은 비어 있어야 한다(아니면 false).
create or replace function _ob_forbidden_basic(p_cells smallint[], p_r int, p_c int)
returns boolean
language plpgsql
immutable
as $$
declare
  v_dirs int[] := array[[0, 1], [1, 0], [1, 1], [1, -1]];
  v_tmp smallint[];
  v_idx int := _ob_idx(p_r, p_c);
  v_result boolean := false;
  d int;
begin
  if p_cells[v_idx] <> 0 then return false; end if;

  v_tmp := p_cells;
  v_tmp[v_idx] := 1;

  if _ob_check_win(v_tmp, p_r, p_c) is null then
    for d in 1..4 loop
      if coalesce(array_length(_ob_run_cells(v_tmp, p_r, p_c, v_dirs[d][1], v_dirs[d][2]), 1), 0) >= 6 then
        v_result := true;  -- 장목
      end if;
    end loop;
    if not v_result and coalesce(array_length(_ob_four_keys(v_tmp, p_r, p_c), 1), 0) >= 2 then
      v_result := true;    -- 사사
    end if;
  end if;

  return v_result;
end;
$$;
revoke all on function _ob_forbidden_basic(smallint[], int, int) from public;

-- rules.js: openThreeKeysAt(bd, r, c)
-- 흑이 (r,c)에 둔 상태(p_cells에 이미 1이 놓여 있어야 함)에서 만들어지는 "열린 3"의 키 목록.
-- 열린 3 = 한 수 더 두면 열린 4가 되는 3. 단 그 완성점이 기본 금수면 발전 불가로 보고 제외한다.
create or replace function _ob_open_three_keys(p_cells smallint[], p_r int, p_c int)
returns text[]
language plpgsql
immutable
as $$
declare
  v_dirs int[] := array[[0, 1], [1, 0], [1, 1], [1, -1]];
  v_keys text[] := '{}';
  v_move int := _ob_idx(p_r, p_c);
  v_tmp smallint[];
  v_run int[];
  v_stones int[];
  v_key text;
  v_e int;
  v_er int;
  v_ec int;
  v_dr int;
  v_dc int;
  d int;
  v_off int;
begin
  for d in 1..4 loop
    v_dr := v_dirs[d][1];
    v_dc := v_dirs[d][2];
    for v_off in -4 .. 4 loop
      if v_off = 0 then continue; end if;
      v_er := p_r + v_dr * v_off;
      v_ec := p_c + v_dc * v_off;
      if not _ob_in(v_er, v_ec) then continue; end if;
      v_e := _ob_idx(v_er, v_ec);
      if p_cells[v_e] <> 0 then continue; end if;

      v_tmp := p_cells;
      v_tmp[v_e] := 1;

      if _ob_is_open_four(v_tmp, v_er, v_ec, v_dr, v_dc) then
        v_run := _ob_run_cells(v_tmp, v_er, v_ec, v_dr, v_dc);
        if v_move = any(v_run) then
          -- JS는 여기서 bd[e]를 0으로 되돌린 뒤 isForbiddenBasic을 부른다(대상 칸이 비어 있어야
          -- 판정이 성립). plpgsql에서는 e를 놓지 않은 원본 p_cells를 그대로 넘기면 동일하다.
          if not _ob_forbidden_basic(p_cells, v_er, v_ec) then
            select coalesce(array_agg(x order by x), '{}'::int[]) into v_stones
            from unnest(v_run) x where x <> v_e;
            v_key := format('%s_%s:%s', v_dr, v_dc, array_to_string(v_stones, '|'));
            if not (v_key = any(v_keys)) then v_keys := v_keys || v_key; end if;
          end if;
        end if;
      end if;
    end loop;
  end loop;
  return v_keys;
end;
$$;
revoke all on function _ob_open_three_keys(smallint[], int, int) from public;

-- rules.js: isForbidden(bd, r, c) — 흑 전용 금수 판정.
-- 반환: 'overline'(장목) | 'double-four'(사사) | 'double-three'(삼삼) | null.
-- 그 수로 정확한 5가 완성되면 금수보다 승리가 우선이라 null이다(JS와 동일한 순서).
create or replace function _ob_forbidden(p_cells smallint[], p_r int, p_c int)
returns text
language plpgsql
immutable
as $$
declare
  v_dirs int[] := array[[0, 1], [1, 0], [1, 1], [1, -1]];
  v_tmp smallint[];
  v_idx int := _ob_idx(p_r, p_c);
  v_result text := null;
  d int;
begin
  if p_cells[v_idx] <> 0 then return null; end if;

  v_tmp := p_cells;
  v_tmp[v_idx] := 1;

  if _ob_check_win(v_tmp, p_r, p_c) is not null then
    return null;  -- 오목 완성이 우선
  end if;

  for d in 1..4 loop
    if coalesce(array_length(_ob_run_cells(v_tmp, p_r, p_c, v_dirs[d][1], v_dirs[d][2]), 1), 0) >= 6 then
      v_result := 'overline';
    end if;
  end loop;

  if v_result is null and coalesce(array_length(_ob_four_keys(v_tmp, p_r, p_c), 1), 0) >= 2 then
    v_result := 'double-four';
  end if;

  if v_result is null and coalesce(array_length(_ob_open_three_keys(v_tmp, p_r, p_c), 1), 0) >= 2 then
    v_result := 'double-three';
  end if;

  return v_result;
end;
$$;
revoke all on function _ob_forbidden(smallint[], int, int) from public;


-- ============================================================================
-- 3. 오목 내부 헬퍼 (판 생성 / 데드라인 / 판·매치 종료)
-- ============================================================================

-- 002의 _touch_deadline(p_round)과 같은 규칙을 omok_boards에 적용한 판. 턴이 바뀌는
-- 모든 지점에서 호출한다. games.turn_seconds(=start_game에서 rooms.turn_seconds 복사본)가
-- 0이면 무제한(null).
create or replace function _ob_touch_deadline(p_board uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn_seconds int;
begin
  select g.turn_seconds into v_turn_seconds
  from omok_boards b join games g on g.id = b.game_id
  where b.id = p_board;

  if v_turn_seconds is null or v_turn_seconds = 0 then
    update omok_boards set turn_deadline = null where id = p_board;
  else
    update omok_boards set turn_deadline = now() + make_interval(secs => v_turn_seconds) where id = p_board;
  end if;
end;
$$;
revoke all on function _ob_touch_deadline(uuid) from public;

-- 새 판 시작. board_no=1이면 흑(선공)을 무작위로, 이후 판은 직전 판의 흑을 반전한다.
create or replace function _ob_new_board(p_game uuid, p_board_no int)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_black smallint;
  v_prev smallint;
  v_board uuid;
begin
  if p_board_no = 1 then
    v_black := (floor(random() * 2))::smallint;  -- 0 또는 1
  else
    select black_seat into v_prev from omok_boards
    where game_id = p_game and board_no = p_board_no - 1;
    if v_prev is null then raise exception '직전 판을 찾을 수 없습니다'; end if;
    v_black := (1 - v_prev)::smallint;
  end if;

  insert into omok_boards (game_id, board_no, status, black_seat, turn_seat, move_count, cells)
  values (p_game, p_board_no, 'playing', v_black, v_black, 0, array_fill(0::smallint, array[225]))
  returning id into v_board;

  perform _ob_touch_deadline(v_board);

  -- games.round_no를 판 번호로 유지(티츄 _deal_round와 같은 관례 — 클라이언트 표시용).
  update games set round_no = p_board_no where id = p_game;

  perform _emit(p_game, 'board', jsonb_build_object(
    'board_id', v_board, 'board_no', p_board_no, 'black_seat', v_black
  ));

  return v_board;
end;
$$;
revoke all on function _ob_new_board(uuid, int) from public;

-- 매치(games) 종료 + 전적 기록. 티츄 _score_round의 종료 블록과 같은 방식으로 처리한다.
-- ※ rooms.status는 티츄와 동일하게 'finished'로 둔다(schema.sql:687 / 004:137).
--    current_game_id는 그대로 유지 — 클라이언트가 종료 화면에서 마지막 게임을 계속 읽는다.
create or replace function _ob_finish_match(p_game uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_score_a int;
  v_score_b int;
  v_winner_team smallint;
  v_rounds_played int;
  v_match_id uuid;
begin
  select room_id, score_a, score_b into v_room_id, v_score_a, v_score_b
  from games where id = p_game;

  v_winner_team := case when v_score_a > v_score_b then 0 else 1 end;

  update games set status = 'finished', winner_team = v_winner_team, finished_at = now() where id = p_game;
  update rooms set status = 'finished' where id = v_room_id;

  select coalesce(max(board_no), 0) into v_rounds_played from omok_boards where game_id = p_game;

  insert into matches (room_id, game_type, score_a, score_b, winner_team, rounds_played)
  values (v_room_id, 'omok', v_score_a, v_score_b, v_winner_team, v_rounds_played)
  returning id into v_match_id;

  -- 2인 매핑(005): team = seat. 티츄 전용 카운터(tichu_calls 등)는 default 0으로 둔다.
  insert into match_players (match_id, user_id, seat, team, won)
  select v_match_id, rs.user_id, rs.seat, rs.seat, (rs.seat = v_winner_team)
  from room_seats rs
  where rs.room_id = v_room_id and rs.seat in (0, 1);
end;
$$;
revoke all on function _ob_finish_match(uuid) from public;

-- 한 판 종료 처리(승리/시간초과 공통): 판 상태 확정 → 세트 스코어 +1 → 목표 도달 시 매치 종료.
-- place_stone과 omok_timeout이 같은 블록을 쓰므로 헬퍼로 뽑았다.
create or replace function _ob_finish_board(p_board uuid, p_winner_seat smallint, p_reason text, p_win_line int[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game_id uuid;
  v_score_a int;
  v_score_b int;
  v_target int;
begin
  update omok_boards
  set status = 'finished',
      winner_seat = p_winner_seat,
      win_reason = p_reason,
      win_line = p_win_line,
      turn_seat = null,
      turn_deadline = null
  where id = p_board
  returning game_id into v_game_id;

  update games
  set score_a = score_a + (case when p_winner_seat = 0 then 1 else 0 end),
      score_b = score_b + (case when p_winner_seat = 1 then 1 else 0 end)
  where id = v_game_id
  returning score_a, score_b, target_score into v_score_a, v_score_b, v_target;

  if greatest(v_score_a, v_score_b) >= v_target then
    perform _ob_finish_match(v_game_id);
  end if;
end;
$$;
revoke all on function _ob_finish_board(uuid, smallint, text, int[]) from public;


-- ============================================================================
-- 4. 공개 RPC (전부 SECURITY DEFINER, authenticated에만 EXECUTE 부여)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- place_stone(p_board, p_r, p_c) → {version, win}   (win = 승리 라인 인덱스 배열 또는 null)
-- 좌석/턴/상태/빈칸 검증 → (흑이면) 금수 검사 → 착수 → 승리 판정 또는 턴 교대.
-- 금수는 **거부**(예외)라서 턴이 소모되지 않는다.
-- ---------------------------------------------------------------------------
create or replace function place_stone(p_board uuid, p_r int, p_c int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game_id uuid;
  v_status text;
  v_black smallint;
  v_turn smallint;
  v_move_count int;
  v_cells smallint[];
  v_room_id uuid;
  v_game_status text;
  v_seat smallint;
  v_color smallint;
  v_idx int;
  v_new_cells smallint[];
  v_win int[];
  v_forb text;
  v_forb_label text;
begin
  select game_id, status, black_seat, turn_seat, move_count, cells
  into v_game_id, v_status, v_black, v_turn, v_move_count, v_cells
  from omok_boards where id = p_board for update;
  if v_game_id is null then raise exception '판을 찾을 수 없습니다'; end if;

  select room_id, status into v_room_id, v_game_status from games where id = v_game_id;
  select seat into v_seat from room_seats where room_id = v_room_id and user_id = auth.uid();
  if v_seat is null then raise exception '이 게임의 멤버가 아닙니다'; end if;

  if v_game_status <> 'playing' then raise exception '이미 끝난 게임입니다'; end if;
  if v_status <> 'playing' then raise exception '이미 끝난 판입니다'; end if;
  if v_turn is null or v_turn <> v_seat then raise exception '차례가 아닙니다'; end if;
  if not _ob_in(p_r, p_c) then raise exception '판 밖입니다'; end if;

  v_idx := _ob_idx(p_r, p_c);
  if v_cells[v_idx] <> 0 then raise exception '이미 돌이 있는 자리입니다'; end if;

  v_color := case when v_seat = v_black then 1 else 2 end;
  v_new_cells := v_cells;
  v_new_cells[v_idx] := v_color;

  v_win := _ob_check_win(v_new_cells, p_r, p_c);

  -- 흑만 금수. 5가 먼저 성립하면 금수를 무시한다(_ob_forbidden 내부도 같은 순서라
  -- 이 가드가 없어도 결과는 같지만, 의도를 드러내고 불필요한 계산을 건너뛴다).
  if v_color = 1 and v_win is null then
    v_forb := _ob_forbidden(v_cells, p_r, p_c);
    if v_forb is not null then
      -- 사용자에게 보이는 문구는 한글로(클라이언트는 이 메시지를 그대로 띄운다).
      v_forb_label := case v_forb
        when 'overline' then '장목'
        when 'double-four' then '사사'
        else '삼삼'
      end;
      raise exception '금수(%)', v_forb_label;
    end if;
  end if;

  update omok_boards set cells = v_new_cells, move_count = v_move_count + 1 where id = p_board;

  insert into omok_moves (board_id, seq, seat, color, r, c)
  values (p_board, v_move_count + 1, v_seat, v_color, p_r, p_c);

  if v_win is not null then
    perform _ob_finish_board(p_board, v_seat, 'five', v_win);
  else
    update omok_boards set turn_seat = (1 - v_seat)::smallint where id = p_board;
    perform _ob_touch_deadline(p_board);
  end if;

  return jsonb_build_object(
    'version', _emit(v_game_id, 'stone', jsonb_build_object(
      'seat', v_seat, 'color', v_color, 'r', p_r, 'c', p_c, 'win', v_win is not null
    )),
    'win', v_win
  );
end;
$$;
revoke all on function place_stone(uuid, int, int) from public;
grant execute on function place_stone(uuid, int, int) to authenticated;

-- ---------------------------------------------------------------------------
-- omok_next_board(p_game) → {version, ready, seats}
-- 재대국 투표. games.rematch_seats에 좌석을 넣고, 2명이 모이면 다음 판을 연다.
-- FOR UPDATE로 games 행을 잡아 두 명이 동시에 눌러도 판이 하나만 열리게 직렬화한다.
-- ---------------------------------------------------------------------------
create or replace function omok_next_board(p_game uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_status text;
  v_seats smallint[];
  v_seat smallint;
  v_board_no int;
  v_board_status text;
  v_ready boolean := false;
begin
  select room_id, status, rematch_seats into v_room_id, v_status, v_seats
  from games where id = p_game for update;
  if v_room_id is null then raise exception '게임을 찾을 수 없습니다'; end if;

  select seat into v_seat from room_seats where room_id = v_room_id and user_id = auth.uid();
  if v_seat is null then raise exception '이 게임의 멤버가 아닙니다'; end if;
  if v_status <> 'playing' then raise exception '이미 끝난 게임입니다'; end if;

  select board_no, status into v_board_no, v_board_status
  from omok_boards where game_id = p_game order by board_no desc limit 1;
  if v_board_no is null then raise exception '판을 찾을 수 없습니다'; end if;
  if v_board_status <> 'finished' then raise exception '아직 진행 중인 판이 있습니다'; end if;

  if not (v_seat = any(v_seats)) then
    v_seats := v_seats || v_seat;
    update games set rematch_seats = v_seats where id = p_game;
  end if;

  if coalesce(array_length(v_seats, 1), 0) >= 2 then
    update games set rematch_seats = '{}' where id = p_game;
    perform _ob_new_board(p_game, v_board_no + 1);
    v_ready := true;
  end if;

  return jsonb_build_object(
    'ready', v_ready,
    'seats', v_seats,
    'version', _emit(p_game, 'rematch', jsonb_build_object('seat', v_seat, 'ready', v_ready))
  );
end;
$$;
revoke all on function omok_next_board(uuid) from public;
grant execute on function omok_next_board(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- omok_timeout(p_board) → {version, winner_seat}
-- 멤버 누구나 호출 가능. turn_deadline이 실제로 지났을 때만 동작하며, 그 턴의 플레이어가
-- 패한다(002 force_timeout과 같은 "서버가 시계의 진실"이라는 전제).
-- ---------------------------------------------------------------------------
create or replace function omok_timeout(p_board uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game_id uuid;
  v_status text;
  v_turn smallint;
  v_deadline timestamptz;
  v_room_id uuid;
  v_game_status text;
  v_seat smallint;
  v_winner smallint;
begin
  select game_id, status, turn_seat, turn_deadline
  into v_game_id, v_status, v_turn, v_deadline
  from omok_boards where id = p_board for update;
  if v_game_id is null then raise exception '판을 찾을 수 없습니다'; end if;

  select room_id, status into v_room_id, v_game_status from games where id = v_game_id;
  select seat into v_seat from room_seats where room_id = v_room_id and user_id = auth.uid();
  if v_seat is null then raise exception '이 게임의 멤버가 아닙니다'; end if;

  if v_game_status <> 'playing' then raise exception '이미 끝난 게임입니다'; end if;
  if v_status <> 'playing' then raise exception '이미 끝난 판입니다'; end if;
  if v_deadline is null or now() <= v_deadline then
    raise exception '아직 시간이 초과되지 않았습니다';
  end if;

  v_winner := (1 - v_turn)::smallint;
  perform _ob_finish_board(p_board, v_winner, 'timeout', null::int[]);

  return jsonb_build_object(
    'winner_seat', v_winner,
    'version', _emit(v_game_id, 'timeout', jsonb_build_object('seat', v_turn, 'winner', v_winner))
  );
end;
$$;
revoke all on function omok_timeout(uuid) from public;
grant execute on function omok_timeout(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_omok_state(p_game) → jsonb 스냅샷
-- {game, board, players, moves, settings}. 티츄 get_game_state와 같은 역할(버전갭 복구용).
-- ---------------------------------------------------------------------------
create or replace function get_omok_state(p_game uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_board_id uuid;
begin
  select room_id into v_room_id from games where id = p_game;
  if v_room_id is null then raise exception '게임을 찾을 수 없습니다'; end if;
  if not exists(select 1 from room_seats where room_id = v_room_id and user_id = auth.uid()) then
    raise exception '이 게임의 멤버가 아닙니다';
  end if;

  select id into v_board_id from omok_boards where game_id = p_game order by board_no desc limit 1;

  return jsonb_build_object(
    'game', (
      select jsonb_build_object(
        'id', g.id, 'room_id', g.room_id, 'status', g.status, 'game_type', g.game_type,
        'score_a', g.score_a, 'score_b', g.score_b, 'round_no', g.round_no,
        'version', g.version, 'winner_team', g.winner_team, 'rematch_seats', g.rematch_seats
      )
      from games g where g.id = p_game
    ),
    'board', (
      select jsonb_build_object(
        'id', b.id, 'board_no', b.board_no, 'status', b.status,
        'black_seat', b.black_seat, 'turn_seat', b.turn_seat, 'move_count', b.move_count,
        'cells', b.cells, 'winner_seat', b.winner_seat, 'win_reason', b.win_reason,
        'win_line', b.win_line, 'turn_deadline', b.turn_deadline
      )
      from omok_boards b where b.id = v_board_id
    ),
    'players', (
      select jsonb_agg(jsonb_build_object(
        'seat', rs.seat, 'user_id', rs.user_id, 'nickname', p.nickname
      ) order by rs.seat)
      from room_seats rs join profiles p on p.user_id = rs.user_id
      where rs.room_id = v_room_id
    ),
    'moves', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'seq', m.seq, 'seat', m.seat, 'color', m.color, 'r', m.r, 'c', m.c
      ) order by m.seq), '[]'::jsonb)
      from omok_moves m where m.board_id = v_board_id
    ),
    -- 설정은 games의 복사본을 쓴다(게임 시작 시점의 값이 그 게임의 진실 — rooms는 이후 바뀔 수 있다).
    'settings', (
      select jsonb_build_object('target_score', g.target_score, 'turn_seconds', g.turn_seconds)
      from games g where g.id = p_game
    )
  );
end;
$$;
revoke all on function get_omok_state(uuid) from public;
grant execute on function get_omok_state(uuid) to authenticated;


-- ============================================================================
-- 5. start_game 교체 — 005판을 그대로 복사하고 'omok' 분기만 연결한다.
-- ============================================================================

create or replace function start_game(p_room uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_capacity smallint;
  v_game_type text;
  v_seat_count int;
  v_game_id uuid;
begin
  select status, capacity, game_type into v_status, v_capacity, v_game_type
  from rooms where id = p_room for update;
  if v_status is null then raise exception '방을 찾을 수 없습니다'; end if;
  if v_status <> 'lobby' then raise exception '이미 시작된 방입니다'; end if;
  if not exists(select 1 from room_seats where room_id = p_room and user_id = auth.uid()) then
    raise exception '이 방의 멤버가 아닙니다';
  end if;

  select count(*) into v_seat_count from room_seats where room_id = p_room;
  if v_seat_count <> v_capacity then
    raise exception '%명이 모여야 시작할 수 있습니다', v_capacity;
  end if;

  insert into games (room_id, target_score, turn_seconds, game_type)
  select p_room, target_score, turn_seconds, game_type from rooms where id = p_room
  returning id into v_game_id;

  update rooms set status = 'playing', current_game_id = v_game_id where id = p_room;

  if v_game_type = 'tichu' then
    perform _deal_round(v_game_id, 1);
  elsif v_game_type = 'baseball' then
    perform _bb_new_round(v_game_id, 1);  -- 006 분기 유지 (007이 함수를 통째로 교체하므로 병합)
  elsif v_game_type = 'omok' then
    perform _ob_new_board(v_game_id, 1);  -- 차이(005 대비): omok 분기 연결
  else
    raise exception '아직 준비 중인 게임입니다: %', v_game_type;
  end if;

  return v_game_id;
end;
$$;
revoke all on function start_game(uuid) from public;
grant execute on function start_game(uuid) to authenticated;

commit;

notify pgrst, 'reload schema';

select 'migration 007 applied' as result;
