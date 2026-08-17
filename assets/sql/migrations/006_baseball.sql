-- ============================================================================
-- 006: 숫자야구 — 서버 권위 판정. 비밀숫자는 bb_secrets(RLS on·정책 0개)에만 존재하고
-- 판정은 전부 SECURITY DEFINER RPC가 수행한다(클라이언트 치팅 원천 차단).
-- 동기화는 티츄와 동일한 버전-갭 스냅샷(_emit → games UPDATE 구독 → get_bb_state)이므로
-- bb_* 테이블은 realtime publication에 넣지 않는다(비밀 보호에도 유리).
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. 테이블
-- ---------------------------------------------------------------------------
create table bb_rounds (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  round_no int not null,
  status text not null default 'setting' check (status in ('setting', 'playing', 'finished')),
  digits smallint not null default 4 check (digits between 3 and 5),
  turn_seat smallint,
  winner_seat smallint,
  created_at timestamptz not null default now(),
  unique (game_id, round_no)
);
alter table bb_rounds enable row level security;
create policy bb_rounds_select on bb_rounds for select to authenticated
  using (exists (
    select 1 from games g where g.id = bb_rounds.game_id and is_room_member(g.room_id)
  ));

-- 비밀숫자: round_secrets 패턴 — RLS는 켜되 정책 0개 → 직접 SELECT 불가, RPC 내부 전용
create table bb_secrets (
  round_id uuid not null references bb_rounds(id) on delete cascade,
  seat smallint not null check (seat in (0, 1)),
  user_id uuid not null references auth.users(id),
  secret text not null,
  primary key (round_id, seat)
);
alter table bb_secrets enable row level security;

create table bb_guesses (
  id bigint generated always as identity primary key,
  round_id uuid not null references bb_rounds(id) on delete cascade,
  seq int not null,
  seat smallint not null,
  guess text not null,
  strikes smallint not null,
  balls smallint not null,
  created_at timestamptz not null default now(),
  unique (round_id, seq)
);
alter table bb_guesses enable row level security;
-- 추측+판정은 정보 누출이 없다: 상대의 추측은 내 비밀에 대한 것(내가 이미 앎),
-- 내 추측은 상대가 이미 앎 → 방 멤버 전체 SELECT 허용.
create policy bb_guesses_select on bb_guesses for select to authenticated
  using (exists (
    select 1 from bb_rounds r join games g on g.id = r.game_id
    where r.id = bb_guesses.round_id and is_room_member(g.room_id)
  ));

-- ---------------------------------------------------------------------------
-- 2. 내부 헬퍼 (전부 public 접근 차단)
-- ---------------------------------------------------------------------------
create or replace function _bb_valid_number(p_num text, p_digits int)
returns boolean
language sql
immutable
as $$
  select p_num ~ ('^[0-9]{' || p_digits || '}$')
     and length(p_num) = (select count(distinct c) from unnest(string_to_array(p_num, null)) c);
$$;
revoke all on function _bb_valid_number(text, int) from public;

-- 스트라이크/볼 판정 (원본: baseball/app.js evaluate)
create or replace function _bb_evaluate(p_secret text, p_guess text, out strikes int, out balls int)
language plpgsql
immutable
as $$
declare
  i int;
begin
  strikes := 0;
  balls := 0;
  for i in 1..length(p_guess) loop
    if substr(p_guess, i, 1) = substr(p_secret, i, 1) then
      strikes := strikes + 1;
    elsif position(substr(p_guess, i, 1) in p_secret) > 0 then
      balls := balls + 1;
    end if;
  end loop;
end;
$$;
revoke all on function _bb_evaluate(text, text) from public;

-- 새 라운드(판) 생성. digits는 rooms.settings에서.
create or replace function _bb_new_round(p_game uuid, p_round_no int)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_digits int;
  v_round_id uuid;
begin
  select coalesce((r.settings->>'digits')::int, 4) into v_digits
  from games g join rooms r on r.id = g.room_id
  where g.id = p_game;
  if v_digits not between 3 and 5 then v_digits := 4; end if;

  insert into bb_rounds (game_id, round_no, digits)
  values (p_game, p_round_no, v_digits)
  returning id into v_round_id;

  update games set round_no = p_round_no where id = p_game;
  perform _emit(p_game, 'bb_round', jsonb_build_object('round_no', p_round_no));
  return v_round_id;
end;
$$;
revoke all on function _bb_new_round(uuid, int) from public;

-- 매치 종료 (티츄 _score_round의 종료부와 동일 구조)
create or replace function _bb_finish_match(p_game uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_score_a int;
  v_score_b int;
  v_rounds int;
  v_winner_team smallint;
  v_match_id uuid;
begin
  select room_id, score_a, score_b, round_no into v_room_id, v_score_a, v_score_b, v_rounds
  from games where id = p_game;

  v_winner_team := case when v_score_a > v_score_b then 0 else 1 end;
  update games set status = 'finished', winner_team = v_winner_team, finished_at = now() where id = p_game;
  update rooms set status = 'finished' where id = v_room_id;

  insert into matches (room_id, score_a, score_b, winner_team, rounds_played, game_type)
  values (v_room_id, v_score_a, v_score_b, v_winner_team, v_rounds, 'baseball')
  returning id into v_match_id;

  insert into match_players (match_id, user_id, seat, team, won)
  select v_match_id, rs.user_id, rs.seat, rs.seat, rs.seat = v_winner_team
  from room_seats rs where rs.room_id = v_room_id;
end;
$$;
revoke all on function _bb_finish_match(uuid) from public;

-- ---------------------------------------------------------------------------
-- 3. 공개 RPC
-- ---------------------------------------------------------------------------

-- 방 설정 병합(방장·로비 한정): 목표 승수(rooms.target_score 재사용)와 settings jsonb(digits 등)
create or replace function update_room_settings(p_room uuid, p_target int default null, p_settings jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_creator uuid;
begin
  select status, created_by into v_status, v_creator from rooms where id = p_room for update;
  if v_status is null then raise exception '방을 찾을 수 없습니다'; end if;
  if v_creator <> auth.uid() then raise exception '방장만 설정을 바꿀 수 있습니다'; end if;
  if v_status <> 'lobby' then raise exception '게임 시작 후에는 바꿀 수 없습니다'; end if;

  if p_target is not null then
    if p_target < 1 or p_target > 1000 then raise exception '목표 값이 올바르지 않습니다'; end if;
    update rooms set target_score = p_target where id = p_room;
  end if;
  if p_settings is not null then
    update rooms set settings = settings || p_settings where id = p_room;
  end if;
end;
$$;
revoke all on function update_room_settings(uuid, int, jsonb) from public;
grant execute on function update_room_settings(uuid, int, jsonb) to authenticated;

-- 비밀숫자 설정(라운드 시작 단계). 양측 완료 시 playing 전환 + 선공 결정.
create or replace function set_secret(p_round uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game uuid;
  v_status text;
  v_digits int;
  v_round_no int;
  v_seat smallint;
  v_count int;
  v_prev_winner smallint;
  v_turn smallint;
begin
  select game_id, status, digits, round_no into v_game, v_status, v_digits, v_round_no
  from bb_rounds where id = p_round for update;
  if v_game is null then raise exception '라운드를 찾을 수 없습니다'; end if;
  if v_status <> 'setting' then raise exception '이미 시작된 라운드입니다'; end if;

  select rs.seat into v_seat
  from games g join room_seats rs on rs.room_id = g.room_id and rs.user_id = auth.uid()
  where g.id = v_game;
  if v_seat is null then raise exception '이 게임의 참가자가 아닙니다'; end if;

  if not _bb_valid_number(p_secret, v_digits) then
    raise exception '%자리 서로 다른 숫자여야 합니다', v_digits;
  end if;

  insert into bb_secrets (round_id, seat, user_id, secret)
  values (p_round, v_seat, auth.uid(), p_secret)
  on conflict (round_id, seat) do update set secret = excluded.secret;

  select count(*) into v_count from bb_secrets where round_id = p_round;
  if v_count = 2 then
    -- 선공: 1판은 랜덤, 이후엔 직전 판 패자
    if v_round_no = 1 then
      v_turn := floor(random() * 2)::smallint;
    else
      select winner_seat into v_prev_winner from bb_rounds
      where game_id = v_game and round_no = v_round_no - 1;
      v_turn := coalesce((1 - v_prev_winner)::smallint, floor(random() * 2)::smallint);
    end if;
    update bb_rounds set status = 'playing', turn_seat = v_turn where id = p_round;
  end if;

  perform _emit(v_game, 'bb_secret_set', jsonb_build_object('seat', v_seat, 'ready', v_count = 2));
end;
$$;
revoke all on function set_secret(uuid, text) from public;
grant execute on function set_secret(uuid, text) to authenticated;

-- 추측 — 서버가 상대 비밀을 꺼내 판정한다.
create or replace function bb_guess(p_round uuid, p_guess text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game uuid;
  v_status text;
  v_digits int;
  v_turn smallint;
  v_seat smallint;
  v_secret text;
  v_strikes int;
  v_balls int;
  v_seq int;
  v_score_a int;
  v_score_b int;
  v_target int;
begin
  select game_id, status, digits, turn_seat into v_game, v_status, v_digits, v_turn
  from bb_rounds where id = p_round for update;
  if v_game is null then raise exception '라운드를 찾을 수 없습니다'; end if;
  if v_status <> 'playing' then raise exception '추측할 수 있는 단계가 아닙니다'; end if;

  select rs.seat into v_seat
  from games g join room_seats rs on rs.room_id = g.room_id and rs.user_id = auth.uid()
  where g.id = v_game;
  if v_seat is null then raise exception '이 게임의 참가자가 아닙니다'; end if;
  if v_seat <> v_turn then raise exception '내 차례가 아닙니다'; end if;

  if not _bb_valid_number(p_guess, v_digits) then
    raise exception '%자리 서로 다른 숫자여야 합니다', v_digits;
  end if;

  select secret into v_secret from bb_secrets where round_id = p_round and seat = 1 - v_seat;
  if v_secret is null then raise exception '상대 비밀번호가 없습니다'; end if;

  select e.strikes, e.balls into v_strikes, v_balls from _bb_evaluate(v_secret, p_guess) e;

  select coalesce(max(seq), 0) + 1 into v_seq from bb_guesses where round_id = p_round;
  insert into bb_guesses (round_id, seq, seat, guess, strikes, balls)
  values (p_round, v_seq, v_seat, p_guess, v_strikes, v_balls);

  if v_strikes = v_digits then
    update bb_rounds set status = 'finished', winner_seat = v_seat where id = p_round;
    if v_seat = 0 then
      update games set score_a = score_a + 1 where id = v_game returning score_a, score_b into v_score_a, v_score_b;
    else
      update games set score_b = score_b + 1 where id = v_game returning score_a, score_b into v_score_a, v_score_b;
    end if;
    select target_score into v_target from games where id = v_game;
    if greatest(v_score_a, v_score_b) >= v_target then
      perform _bb_finish_match(v_game);
    end if;
  else
    update bb_rounds set turn_seat = 1 - v_seat where id = p_round;
  end if;

  perform _emit(v_game, 'bb_guess', jsonb_build_object('seat', v_seat, 'strikes', v_strikes, 'balls', v_balls));
  return jsonb_build_object('strikes', v_strikes, 'balls', v_balls);
end;
$$;
revoke all on function bb_guess(uuid, text) from public;
grant execute on function bb_guess(uuid, text) to authenticated;

-- 다음 판 투표(양측 동의 시 새 라운드) — games.rematch_seats 재사용
create or replace function bb_next_round(p_game uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_round_no int;
  v_seat smallint;
  v_votes smallint[];
begin
  select status, round_no, rematch_seats into v_status, v_round_no, v_votes
  from games where id = p_game for update;
  if v_status is null then raise exception '게임을 찾을 수 없습니다'; end if;
  if v_status <> 'playing' then raise exception '이미 종료된 게임입니다'; end if;

  select rs.seat into v_seat
  from games g join room_seats rs on rs.room_id = g.room_id and rs.user_id = auth.uid()
  where g.id = p_game;
  if v_seat is null then raise exception '이 게임의 참가자가 아닙니다'; end if;

  if not exists (select 1 from bb_rounds where game_id = p_game and round_no = v_round_no and status = 'finished') then
    raise exception '진행 중인 판이 아직 안 끝났습니다';
  end if;

  if not (v_seat = any(v_votes)) then
    v_votes := v_votes || v_seat;
  end if;

  if array_length(v_votes, 1) >= 2 then
    update games set rematch_seats = '{}' where id = p_game;
    perform _bb_new_round(p_game, v_round_no + 1);
  else
    update games set rematch_seats = v_votes where id = p_game;
    perform _emit(p_game, 'bb_next_vote', jsonb_build_object('seat', v_seat));
  end if;
end;
$$;
revoke all on function bb_next_round(uuid) from public;
grant execute on function bb_next_round(uuid) to authenticated;

-- 스냅샷 — 비밀은 "내 것만" 포함(상대 비밀은 어떤 경로로도 반환하지 않는다)
create or replace function get_bb_state(p_game uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_round_id uuid;
begin
  select room_id into v_room_id from games where id = p_game;
  if v_room_id is null then raise exception '게임을 찾을 수 없습니다'; end if;
  if not is_room_member(v_room_id) then raise exception '이 게임의 참가자가 아닙니다'; end if;

  select r.id into v_round_id
  from bb_rounds r join games g on g.id = r.game_id and g.round_no = r.round_no
  where r.game_id = p_game;

  return jsonb_build_object(
    'game', (
      select jsonb_build_object(
        'id', g.id, 'status', g.status, 'game_type', g.game_type,
        'score_a', g.score_a, 'score_b', g.score_b, 'round_no', g.round_no,
        'version', g.version, 'winner_team', g.winner_team,
        'target_score', g.target_score, 'rematch_seats', g.rematch_seats
      ) from games g where g.id = p_game
    ),
    'round', (
      select jsonb_build_object(
        'id', r.id, 'round_no', r.round_no, 'status', r.status, 'digits', r.digits,
        'turn_seat', r.turn_seat, 'winner_seat', r.winner_seat,
        'secrets_set', (select coalesce(array_agg(s.seat order by s.seat), '{}') from bb_secrets s where s.round_id = r.id)
      ) from bb_rounds r where r.id = v_round_id
    ),
    'players', (
      select jsonb_agg(jsonb_build_object('seat', rs.seat, 'user_id', rs.user_id, 'nickname', p.nickname) order by rs.seat)
      from room_seats rs join profiles p on p.user_id = rs.user_id
      where rs.room_id = v_room_id
    ),
    'guesses', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'seq', bg.seq, 'seat', bg.seat, 'guess', bg.guess, 'strikes', bg.strikes, 'balls', bg.balls
      ) order by bg.seq), '[]')
      from bb_guesses bg where bg.round_id = v_round_id
    ),
    'my_secret', (
      select s.secret from bb_secrets s where s.round_id = v_round_id and s.user_id = auth.uid()
    ),
    -- 판이 끝난 뒤에만 양측 비밀 공개 (진 쪽이 상대 숫자를 확인하는 용도)
    'revealed', (
      select case when r.status = 'finished'
        then (select jsonb_object_agg(s.seat, s.secret) from bb_secrets s where s.round_id = r.id)
        else null end
      from bb_rounds r where r.id = v_round_id
    )
  );
end;
$$;
revoke all on function get_bb_state(uuid) from public;
grant execute on function get_bb_state(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. start_game 확장 — 005판 복사 + baseball 분기 연결
--    차이(원본 대비): v_game_type = 'baseball'이면 _bb_new_round(v_game_id, 1)
-- ---------------------------------------------------------------------------
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
    perform _bb_new_round(v_game_id, 1);
  else
    raise exception '아직 준비 중인 게임입니다: %', v_game_type;
  end if;

  return v_game_id;
end;
$$;

commit;

notify pgrst, 'reload schema';

select 'migration 006 applied' as result;
