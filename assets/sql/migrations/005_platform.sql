-- ============================================================================
-- 005: 플랫폼 공용화 — 미니월루천국의 3게임(tichu/omok/baseball)이 rooms/games/
-- matches를 공유하도록 확장한다.
-- 모든 변경은 default를 가진 "추가"라서 구 프로토타입(티츄)을 깨지 않는다.
-- 전체를 한 트랜잭션으로 묶어 drop/create 사이의 무함수 창을 없앤다.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. 컬럼 추가
-- ---------------------------------------------------------------------------
alter table rooms
  add column game_type text not null default 'tichu'
    check (game_type in ('tichu', 'omok', 'baseball')),
  add column capacity smallint not null default 4 check (capacity in (2, 4)),
  add column settings jsonb not null default '{}'::jsonb;

alter table games
  add column game_type text not null default 'tichu',
  add column rematch_seats smallint[] not null default '{}';

alter table matches
  add column game_type text not null default 'tichu',
  add column meta jsonb not null default '{}'::jsonb;

-- 2인 게임 매핑 규약(테이블 변경 없음): team 0 = seat 0, team 1 = seat 1,
-- score_a/score_b = 세트 승수, rounds_played = 둔 판 수.

-- ---------------------------------------------------------------------------
-- 2. create_room 재정의 — 시그니처 변경이므로 drop 후 create.
--    전 파라미터에 default가 있어 구 클라이언트의 rpc('create_room', {})도 그대로 동작.
-- ---------------------------------------------------------------------------
drop function create_room();

create function create_room(p_game_type text default 'tichu', p_settings jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- I/O/0/1 제외(오독 방지)
  v_code text;
  v_room_id uuid;
  v_capacity smallint;
  v_attempt int := 0;
begin
  if p_game_type not in ('tichu', 'omok', 'baseball') then
    raise exception '알 수 없는 게임입니다: %', p_game_type;
  end if;
  v_capacity := case p_game_type when 'tichu' then 4 else 2 end;

  loop
    v_attempt := v_attempt + 1;
    select string_agg(substr(v_chars, (floor(random() * length(v_chars)))::int + 1, 1), '')
    into v_code
    from generate_series(1, 4);

    begin
      insert into rooms (code, created_by, game_type, capacity, settings)
      values (v_code, auth.uid(), p_game_type, v_capacity, coalesce(p_settings, '{}'::jsonb))
      returning id into v_room_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 20 then raise exception '방 코드 생성에 실패했습니다. 다시 시도해주세요'; end if;
    end;
  end loop;

  insert into room_seats (room_id, seat, user_id) values (v_room_id, 0, auth.uid());

  return jsonb_build_object('room_id', v_room_id, 'code', v_code, 'game_type', p_game_type);
end;
$$;
revoke all on function create_room(text, jsonb) from public;
grant execute on function create_room(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. join_room — 좌석 탐색을 capacity 기준으로 (차이: generate_series(0, capacity-1))
-- ---------------------------------------------------------------------------
create or replace function join_room(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_status text;
  v_capacity smallint;
  v_existing_seat smallint;
  v_seat smallint;
begin
  select id, status, capacity into v_room_id, v_status, v_capacity
  from rooms where code = upper(p_code) for update;
  if v_room_id is null then raise exception '방을 찾을 수 없습니다'; end if;

  select seat into v_existing_seat from room_seats where room_id = v_room_id and user_id = auth.uid();
  if v_existing_seat is not null then
    return jsonb_build_object('room_id', v_room_id, 'seat', v_existing_seat, 'rejoined', true);
  end if;

  if v_status <> 'lobby' then raise exception '이미 시작된 방입니다'; end if;

  select min(s) into v_seat from generate_series(0, v_capacity - 1) s
  where s not in (select seat from room_seats where room_id = v_room_id);
  if v_seat is null then raise exception '방이 가득 찼습니다'; end if;

  insert into room_seats (room_id, seat, user_id) values (v_room_id, v_seat, auth.uid());

  return jsonb_build_object('room_id', v_room_id, 'seat', v_seat, 'rejoined', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. start_game — 정원 검증을 capacity로, 딜을 게임 타입으로 분기
--    (002 판 대비 차이: v_capacity/v_game_type 조회, 4명 하드코딩 제거, 딜 분기)
--    omok/baseball 분기는 각각 007/006 마이그레이션이 create or replace로 연다.
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
  else
    raise exception '아직 준비 중인 게임입니다: %', v_game_type;
  end if;

  return v_game_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. v_player_stats — 게임별 + 전체('all') 통합 행을 GROUPING SETS로 한 뷰에서 제공
-- ---------------------------------------------------------------------------
drop view v_player_stats;

create view v_player_stats with (security_invoker = true) as
select
  mp.user_id,
  coalesce(m.game_type, 'all') as game_type,
  count(*) as games,
  count(*) filter (where mp.won) as wins,
  round(count(*) filter (where mp.won)::numeric / nullif(count(*), 0), 4) as win_rate,
  sum(mp.tichu_calls) as tichu_calls,
  sum(mp.tichu_wins) as tichu_wins,
  sum(mp.grand_calls) as grand_calls,
  sum(mp.grand_wins) as grand_wins
from match_players mp
join matches m on m.id = mp.match_id
group by grouping sets ((mp.user_id, m.game_type), (mp.user_id));

commit;

notify pgrst, 'reload schema';

select 'migration 005 applied' as result;
