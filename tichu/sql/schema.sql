-- ============================================================================
-- 티츄(Tichu) Supabase 스키마 + RPC 전체
--
-- 실행 순서: 이 파일 전체를 새(빈) Supabase 프로젝트의 SQL Editor에 한 번에 붙여넣어 실행한다.
-- 섹션은 P0(테이블/RLS/인덱스) → P1(뷰/realtime) → P2(내부 헬퍼) → P3(공개 RPC) 순으로
-- 위에서 아래로 의존한다. 재실행 전제(IF NOT EXISTS 등)는 없음 — 1회성 초기 적용 스크립트.
--
-- 근거 문서: ../docs/rules-spec.md (카드 인코딩·파워·조합 판정 규칙의 1차 출처).
-- ../rules.js가 동일 로직의 클라이언트(JS) 구현이다 — _classify/_beats는 그 파일의
-- classify()/beats()와 1:1 대응하도록 작성했다(교차검증: ../tests.js의 벡터를 참고해서 짰다).
--
-- 아키텍처: 모든 게임 상태 변경은 SECURITY DEFINER RPC로만 이뤄진다. 각 테이블에는 클라이언트가
-- 직접 쓸 수 있는 INSERT/UPDATE/DELETE 정책이 없다(SELECT 정책만 존재) — 이 함수들은 테이블
-- 소유자(정의자) 권한으로 실행되어 RLS를 우회하므로 그것만으로 충분하다. profiles 테이블만
-- 예외적으로 본인 UPDATE를 직접 허용한다(닉네임 변경용, RPC를 안 거침).
-- ============================================================================


-- ============================================================================
-- P0. 확장 + 테이블 + RLS + 인덱스
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- profiles: 공개 닉네임. INSERT는 ensure_profile(RPC)로만, UPDATE는 본인 직접 가능.
-- ---------------------------------------------------------------------------
create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 12),
  created_at timestamptz not null default now()
);
alter table profiles enable row level security;
create policy profiles_select on profiles for select to authenticated using (true);
create policy profiles_update_self on profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- rooms / room_seats
-- ---------------------------------------------------------------------------
create table rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'lobby' check (status in ('lobby','playing','finished','abandoned')),
  current_game_id uuid,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table room_seats (
  room_id uuid not null references rooms(id) on delete cascade,
  seat smallint not null check (seat between 0 and 3),
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, seat),
  unique (room_id, user_id)
);
create index idx_room_seats_user on room_seats (user_id, room_id);

-- ---------------------------------------------------------------------------
-- games
-- ---------------------------------------------------------------------------
create table games (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  status text not null default 'playing' check (status in ('playing','finished','abandoned')),
  score_a int not null default 0,
  score_b int not null default 0,
  target_score int not null default 1000,
  round_no int not null default 0,
  version bigint not null default 0,
  winner_team smallint,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table rooms add constraint rooms_current_game_fk foreign key (current_game_id) references games(id);

-- ---------------------------------------------------------------------------
-- rounds / round_players / hands / exchanges / plays / round_secrets
-- ---------------------------------------------------------------------------
create table rounds (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  round_no int not null,
  phase text not null check (phase in ('grand','exchange','play','scored')),
  turn_seat smallint,
  lead_seat smallint,
  trick_no int not null default 0,
  wish_rank smallint,
  pending_dragon_seat smallint,
  out_order smallint[] not null default '{}',
  score_delta_a int,
  score_delta_b int,
  created_at timestamptz not null default now(),
  unique (game_id, round_no)
);

create table round_players (
  round_id uuid not null references rounds(id) on delete cascade,
  seat smallint not null check (seat between 0 and 3),
  user_id uuid not null references auth.users(id),
  hand_count smallint not null default 8,
  tichu smallint not null default 0 check (tichu in (0,100,200)),
  grand_decided boolean not null default false,
  exchange_done boolean not null default false,
  taken_points int not null default 0,
  primary key (round_id, seat)
);

-- 손패 비밀 보장의 핵심: SELECT 정책이 본인 것만 허용.
create table hands (
  round_id uuid not null references rounds(id) on delete cascade,
  seat smallint not null check (seat between 0 and 3),
  user_id uuid not null references auth.users(id),
  cards smallint[] not null default '{}',
  hidden6 smallint[] not null default '{}',
  received smallint[] not null default '{}',
  primary key (round_id, seat)
);
alter table hands enable row level security;
create policy hands_select_self on hands for select to authenticated using (user_id = auth.uid());

create table exchanges (
  round_id uuid not null references rounds(id) on delete cascade,
  from_seat smallint not null,
  from_user uuid not null references auth.users(id),
  to_seat smallint not null,
  card smallint not null,
  primary key (round_id, from_seat, to_seat)
);
alter table exchanges enable row level security;
create policy exchanges_select_self on exchanges for select to authenticated using (from_user = auth.uid());

create table plays (
  id bigint generated always as identity primary key,
  round_id uuid not null references rounds(id) on delete cascade,
  trick_no int not null,
  seq smallint not null,
  seat smallint not null,
  cards smallint[] not null,
  ctype text not null,
  power int,
  is_pass boolean not null default false,
  created_at timestamptz not null default now()
);
create index idx_plays_round_trick on plays (round_id, trick_no);

-- 셔플된 원본 덱. 정책 0개 — 아무도 직접 SELECT 불가(SECURITY DEFINER 함수 내부에서만 접근).
create table round_secrets (
  round_id uuid primary key references rounds(id) on delete cascade,
  deck smallint[] not null
);
alter table round_secrets enable row level security;

create table game_events (
  id bigint generated always as identity primary key,
  game_id uuid not null references games(id) on delete cascade,
  version bigint not null,
  round_no int,
  seat smallint,
  type text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index idx_game_events_game on game_events (game_id, id);

-- ---------------------------------------------------------------------------
-- matches / match_players (전적)
-- ---------------------------------------------------------------------------
create table matches (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  finished_at timestamptz not null default now(),
  score_a int not null,
  score_b int not null,
  winner_team smallint not null,
  rounds_played int not null
);
alter table matches enable row level security;
create policy matches_select on matches for select to authenticated using (true);

create table match_players (
  match_id uuid not null references matches(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  seat smallint not null,
  team smallint not null,
  won boolean not null,
  tichu_calls smallint not null default 0,
  tichu_wins smallint not null default 0,
  grand_calls smallint not null default 0,
  grand_wins smallint not null default 0,
  primary key (match_id, user_id)
);
alter table match_players enable row level security;
create policy match_players_select on match_players for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 멤버십 체크 헬퍼(재귀 회피용 SECURITY DEFINER) + 나머지 테이블 RLS
-- ---------------------------------------------------------------------------
create or replace function is_room_member(p_room uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists(select 1 from room_seats where room_id = p_room and user_id = auth.uid());
$$;
-- 주의: 아래 나머지 내부 함수들과 달리 이 함수는 revoke하지 않는다 — RLS의 USING절이 호출자
-- 자신의 권한으로 평가되므로, authenticated가 이 함수를 직접 실행할 수 있어야 rooms/games 등을
-- SELECT할 때 정책이 통과한다(기본적으로 PUBLIC에 EXECUTE가 부여되므로 별도 grant 불필요).

alter table rooms enable row level security;
create policy rooms_select on rooms for select to authenticated using (is_room_member(id));

alter table room_seats enable row level security;
create policy room_seats_select on room_seats for select to authenticated using (is_room_member(room_id));

alter table games enable row level security;
create policy games_select on games for select to authenticated using (is_room_member(room_id));

alter table rounds enable row level security;
create policy rounds_select on rounds for select to authenticated using (
  game_id in (select id from games where is_room_member(room_id))
);

alter table round_players enable row level security;
create policy round_players_select on round_players for select to authenticated using (
  round_id in (select id from rounds where game_id in (select id from games where is_room_member(room_id)))
);

alter table plays enable row level security;
create policy plays_select on plays for select to authenticated using (
  round_id in (select id from rounds where game_id in (select id from games where is_room_member(room_id)))
);

alter table game_events enable row level security;
create policy game_events_select on game_events for select to authenticated using (
  game_id in (select id from games where is_room_member(room_id))
);


-- ============================================================================
-- P1. 뷰 + Realtime
-- ============================================================================

create view v_player_stats with (security_invoker=true) as
select
  user_id,
  count(*) as games,
  count(*) filter (where won) as wins,
  round(count(*) filter (where won)::numeric / nullif(count(*),0), 4) as win_rate,
  sum(tichu_calls) as tichu_calls,
  sum(tichu_wins) as tichu_wins,
  sum(grand_calls) as grand_calls,
  sum(grand_wins) as grand_wins
from match_players
group by user_id;

alter publication supabase_realtime add table games, rounds, round_players, game_events, hands;
-- 주의: hands는 기본 REPLICA IDENTITY(DEFAULT)를 반드시 유지할 것(FULL로 바꾸지 말 것).
-- RLS가 "user_id = auth.uid()" 정책으로 각자 자기 hands 행만 브로드캐스트되게 하는 전제가 깨진다.
-- 라이브 라운드 중 hands 행을 DELETE하지 말 것(DELETE 이벤트는 RLS 미적용으로 PK가 그대로
-- 브로드캐스트됨) — 손패 정리는 항상 cards='{}' UPDATE로 한다.


-- ============================================================================
-- P2. 내부 함수 (grant 없음 — public/authenticated에 EXECUTE 부여하지 않음)
-- ============================================================================

-- 배열에서 여러 원소를 한 번에 제거(표준 배열엔 '-' 연산자가 없어서 직접 구현).
create or replace function _array_remove_many(p_arr smallint[], p_remove smallint[])
returns smallint[]
language sql
immutable
as $$
  select coalesce(array_agg(x order by x), '{}'::smallint[])
  from unnest(p_arr) x
  where not (x = any(p_remove));
$$;
revoke all on function _array_remove_many(smallint[], smallint[]) from public;

-- 카드 점수(트릭/손패 정산용). rules.js의 pointsOfCard()와 1:1 대응.
create or replace function _card_points(p_cards smallint[])
returns int
language sql
immutable
as $$
  select coalesce(sum(
    case
      when c = 55 then 25            -- 용
      when c = 54 then -25           -- 봉황
      when c = 52 or c = 53 then 0   -- 마작/개
      when (c % 13) + 2 = 5 then 5
      when (c % 13) + 2 in (10, 13) then 10  -- 10, K
      else 0
    end
  ), 0)
  from unnest(p_cards) c;
$$;
revoke all on function _card_points(smallint[]) from public;

-- rank/suit 배열(마작=rank1/suit null, 봉황 대체값=suit null)에 대한 순수 조합 판정.
-- rules.js의 classifyConcrete(dc, phoenixUsed)와 1:1 대응.
create or replace function _classify_concrete_arrays(p_ranks int[], p_suits int[], p_phoenix_used boolean)
returns table(ctype text, power int, len int)
language plpgsql
immutable
as $$
declare
  v_len int := coalesce(array_length(p_ranks, 1), 0);
  v_distinct int[];
  v_c1 int;
  v_c2 int;
  v_triple_rank int;
  v_sorted int[];
  v_consecutive boolean;
  v_top int;
  v_same_suit boolean;
  i int;
begin
  if v_len = 0 then return; end if;

  if v_len = 1 then
    ctype := 'single';
    power := case when p_ranks[1] = 1 then 2 else p_ranks[1] * 2 end;
    len := 1;
    return next;
    return;
  end if;

  select array_agg(distinct x order by x) into v_distinct from unnest(p_ranks) x;

  if v_len = 2 and array_length(v_distinct, 1) = 1 and v_distinct[1] <> 1 then
    ctype := 'pair'; power := v_distinct[1] * 2; len := 2; return next; return;
  end if;

  if v_len = 3 and array_length(v_distinct, 1) = 1 and v_distinct[1] <> 1 then
    ctype := 'triple'; power := v_distinct[1] * 2; len := 3; return next; return;
  end if;

  if v_len = 4 and array_length(v_distinct, 1) = 1 and v_distinct[1] <> 1 and not p_phoenix_used then
    ctype := 'bomb4'; power := 100 + v_distinct[1]; len := 4; return next; return;
  end if;

  -- 풀하우스: 5장, 서로 다른 랭크 2개, 카운트가 3+2
  if v_len = 5 and array_length(v_distinct, 1) = 2 and not (1 = any(v_distinct)) then
    select count(*) into v_c1 from unnest(p_ranks) x where x = v_distinct[1];
    select count(*) into v_c2 from unnest(p_ranks) x where x = v_distinct[2];
    if (v_c1 = 3 and v_c2 = 2) or (v_c1 = 2 and v_c2 = 3) then
      v_triple_rank := case when v_c1 = 3 then v_distinct[1] else v_distinct[2] end;
      ctype := 'fullhouse'; power := v_triple_rank * 2; len := 5;
      return next; return;
    end if;
  end if;

  -- 연속 페어(사다리): 짝수 길이, 각 랭크가 정확히 2장씩, 랭크가 연속
  if v_len % 2 = 0 and v_len >= 4 and array_length(v_distinct, 1) = v_len / 2
     and not (1 = any(v_distinct))
  then
    if (select bool_and(cnt = 2) from (select count(*) cnt from unnest(p_ranks) x group by x) s) then
      v_consecutive := true;
      for i in 2..array_length(v_distinct, 1) loop
        if v_distinct[i] <> v_distinct[i - 1] + 1 then v_consecutive := false; end if;
      end loop;
      if v_consecutive then
        ctype := 'ladder'; power := v_distinct[array_length(v_distinct, 1)] * 2; len := v_len;
        return next; return;
      end if;
    end if;
  end if;

  -- 스트레이트 / 폭탄(스트레이트 플러시): 5장 이상, 서로 다른 랭크, 연속(마작=rank1이 최하단 가능)
  if v_len >= 5 and array_length(v_distinct, 1) = v_len then
    select array_agg(x order by x) into v_sorted from unnest(p_ranks) x;
    v_consecutive := true;
    for i in 2..array_length(v_sorted, 1) loop
      if v_sorted[i] <> v_sorted[i - 1] + 1 then v_consecutive := false; end if;
    end loop;
    if v_consecutive then
      v_top := v_sorted[array_length(v_sorted, 1)];
      select (bool_and(s is not null) and count(distinct s) = 1) into v_same_suit from unnest(p_suits) s;
      if v_same_suit then
        ctype := 'bombsf'; power := 1000 * v_len + v_top; len := v_len;
      else
        ctype := 'straight'; power := v_top * 2; len := v_len;
      end if;
      return next; return;
    end if;
  end if;

  return;
end;
$$;
revoke all on function _classify_concrete_arrays(int[], int[], boolean) from public;

-- 카드 인코딩(smallint 0..55) 기준 조합 판정. rules.js의 classify()와 1:1 대응.
-- 개(53)는 여기서 다루지 않는다(호출자가 별도 분기) — rules.js도 동일하게 DOG는 classify()에서 null.
create or replace function _classify(p_cards smallint[])
returns table(ctype text, power int, len int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_len int := coalesce(array_length(p_cards, 1), 0);
  v_phoenix_count int;
  v_others smallint[];
  v_ranks int[];
  v_suits int[];
  v_r int;
  v_row record;
  v_best_type text;
  v_best_power int;
  v_best_len int;
begin
  if v_len = 0 then return; end if;
  if 53 = any(p_cards) then return; end if; -- 개: 호출자가 별도 처리
  if 55 = any(p_cards) then
    if v_len = 1 then
      ctype := 'single'; power := 40; len := 1; return next;
    end if;
    return;
  end if;

  v_phoenix_count := (select count(*) from unnest(p_cards) c where c = 54);
  if v_phoenix_count > 1 then return; end if;

  if v_phoenix_count = 0 then
    v_ranks := array(select case when c = 52 then 1 else (c % 13) + 2 end from unnest(p_cards) c);
    v_suits := array(select case when c = 52 then null else (c / 13) end from unnest(p_cards) c);
    return query select * from _classify_concrete_arrays(v_ranks, v_suits, false);
    return;
  end if;

  if v_len = 1 then
    ctype := 'single'; power := null; len := 1; return next; return; -- 봉황 단독: 파워는 문맥 의존(호출자가 재계산)
  end if;

  v_others := array_remove(p_cards, 54);
  v_best_power := null;
  for v_r in 2..14 loop
    v_ranks := array(select case when c = 52 then 1 else (c % 13) + 2 end from unnest(v_others) c) || array[v_r];
    v_suits := array(select case when c = 52 then null else (c / 13) end from unnest(v_others) c) || array[null::int];
    select * into v_row from _classify_concrete_arrays(v_ranks, v_suits, true) limit 1;
    if v_row.ctype is not null and (v_best_power is null or v_row.power > v_best_power) then
      v_best_type := v_row.ctype; v_best_power := v_row.power; v_best_len := v_row.len;
    end if;
  end loop;

  if v_best_type is not null then
    ctype := v_best_type; power := v_best_power; len := v_best_len; return next;
  end if;
  return;
end;
$$;
revoke all on function _classify(smallint[]) from public;

-- rules.js의 beats()와 1:1 대응(단, 봉황 단독 파워 문맥은 호출자가 이미 확정해서 넘긴다).
create or replace function _beats(
  p_type text, p_power int, p_len int,
  p_top_type text, p_top_power int, p_top_len int
)
returns boolean
language sql
immutable
as $$
  select case
    when p_type in ('bomb4','bombsf') and p_top_type not in ('bomb4','bombsf') then true
    when p_type not in ('bomb4','bombsf') and p_top_type in ('bomb4','bombsf') then false
    when p_type in ('bomb4','bombsf') and p_top_type in ('bomb4','bombsf') then p_power > p_top_power
    when p_type <> p_top_type or p_len <> p_top_len then false
    else p_power > p_top_power
  end;
$$;
revoke all on function _beats(text, int, int, text, int, int) from public;

-- p_seat이 out_order에 없으면 그대로, 있으면 시계방향으로 다음 생존자를 찾는다.
-- (개 리드 대상, 트릭 승자의 다음 리드, 용 상납 후 다음 리드에 공통 사용)
create or replace function _next_survivor(p_round uuid, p_seat smallint)
returns smallint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_out_order smallint[];
  i int;
  v_candidate smallint;
begin
  select out_order into v_out_order from rounds where id = p_round;
  if not (p_seat = any(v_out_order)) then
    return p_seat;
  end if;
  for i in 1..3 loop
    v_candidate := (p_seat + i) % 4;
    if not (v_candidate = any(v_out_order)) then
      return v_candidate;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function _next_survivor(uuid, smallint) from public;

-- 일반 턴 전진(폭탄 인터럽트가 아닌 정상 진행 시): p_from_seat 다음의 첫 생존 좌석.
create or replace function _advance_turn(p_round uuid, p_from_seat smallint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_out_order smallint[];
  i int;
  v_next smallint;
begin
  select out_order into v_out_order from rounds where id = p_round;
  for i in 1..4 loop
    v_next := (p_from_seat + i) % 4;
    if not (v_next = any(v_out_order)) then
      update rounds set turn_seat = v_next where id = p_round;
      return;
    end if;
  end loop;
end;
$$;
revoke all on function _advance_turn(uuid, smallint) from public;

-- games.version을 1 증가시키고 game_events에 기록한다. 모든 상태변경 RPC는 끝에 이걸 호출한다.
create or replace function _emit(p_game uuid, p_type text, p_payload jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version bigint;
  v_round_no int;
  v_seat smallint;
begin
  update games set version = version + 1 where id = p_game returning version, round_no into v_version, v_round_no;
  v_seat := nullif(p_payload->>'seat', '')::smallint;
  insert into game_events (game_id, version, round_no, seat, type, payload)
  values (p_game, v_version, v_round_no, v_seat, p_type, p_payload);
  return v_version;
end;
$$;
revoke all on function _emit(uuid, text, jsonb) from public;

-- 56장 셔플 후 좌석별 8장(cards)+6장(hidden6) 배분, rounds/round_players/hands 행 생성.
create or replace function _deal_round(p_game uuid, p_round_no int)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deck smallint[];
  v_round_id uuid;
  v_room_id uuid;
  v_seat smallint;
  v_user uuid;
  v_cards smallint[];
  v_hidden smallint[];
begin
  select room_id into v_room_id from games where id = p_game;

  select array_agg(n order by random())::smallint[] into v_deck from generate_series(0, 55) as n;

  insert into rounds (game_id, round_no, phase, trick_no, out_order)
  values (p_game, p_round_no, 'grand', 0, '{}')
  returning id into v_round_id;

  insert into round_secrets (round_id, deck) values (v_round_id, v_deck);

  for v_seat in 0..3 loop
    select user_id into v_user from room_seats where room_id = v_room_id and seat = v_seat;
    v_cards := v_deck[(v_seat * 8 + 1):(v_seat * 8 + 8)];
    v_hidden := v_deck[(33 + v_seat * 6):(38 + v_seat * 6)];
    insert into round_players (round_id, seat, user_id, hand_count) values (v_round_id, v_seat, v_user, 8);
    insert into hands (round_id, seat, user_id, cards, hidden6, received)
    values (v_round_id, v_seat, v_user, v_cards, v_hidden, '{}');
  end loop;

  update games set round_no = p_round_no where id = p_game;

  return v_round_id;
end;
$$;
revoke all on function _deal_round(uuid, int) from public;

-- 라운드 종료 정산: 더블윈/3인아웃 분기, 손패점수/트릭점수 귀속, 티츄 보너스, 게임종료/다음라운드.
-- rules.js의 scoreRound()와 동일 규칙(docs/rules-spec.md §8)이며, 이쪽은 DB 상태를 직접 갱신한다.
create or replace function _score_round(p_round uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game_id uuid;
  v_out_order smallint[];
  v_out_len int;
  v_loser_seat smallint;
  v_first_team smallint;
  v_opp_of_loser_team smallint;
  v_taken int[] := array[0,0,0,0];
  v_tichu int[] := array[0,0,0,0];
  v_tp int;
  v_tc int;
  v_loser_hand_pts int := 0;
  v_seat smallint;
  v_d_a int := 0;
  v_d_b int := 0;
  v_team smallint;
  v_bonus int;
  v_success boolean;
  v_score_a int;
  v_score_b int;
  v_target int;
  v_room_id uuid;
  v_match_id uuid;
  v_winner_team smallint;
  v_rounds_played int;
begin
  select game_id, out_order into v_game_id, v_out_order from rounds where id = p_round;
  v_out_len := coalesce(array_length(v_out_order, 1), 0);

  for v_seat in 0..3 loop
    select taken_points, tichu into v_tp, v_tc from round_players where round_id = p_round and seat = v_seat;
    v_taken[v_seat + 1] := v_tp;
    v_tichu[v_seat + 1] := v_tc;
  end loop;

  if v_out_len >= 2 and (v_out_order[1] % 2) = (v_out_order[2] % 2) then
    -- 원투 피니시: 카드점수 무시, 고정 200점
    v_team := v_out_order[1] % 2;
    if v_team = 0 then v_d_a := v_d_a + 200; else v_d_b := v_d_b + 200; end if;
  else
    v_loser_seat := null;
    for v_seat in 0..3 loop
      if not (v_seat = any(v_out_order)) then v_loser_seat := v_seat; end if;
    end loop;

    v_first_team := v_out_order[1] % 2;
    v_opp_of_loser_team := 1 - (v_loser_seat % 2);

    select _card_points(cards) into v_loser_hand_pts from hands where round_id = p_round and seat = v_loser_seat;

    for v_seat in 0..3 loop
      if v_seat = v_loser_seat then
        -- 꼴찌가 딴 트릭 점수는 1등의 팀으로
        if v_first_team = 0 then v_d_a := v_d_a + v_taken[v_seat + 1]; else v_d_b := v_d_b + v_taken[v_seat + 1]; end if;
      else
        if (v_seat % 2) = 0 then v_d_a := v_d_a + v_taken[v_seat + 1]; else v_d_b := v_d_b + v_taken[v_seat + 1]; end if;
      end if;
    end loop;

    -- 꼴찌의 남은 손패 점수는 상대팀으로
    if v_opp_of_loser_team = 0 then v_d_a := v_d_a + v_loser_hand_pts; else v_d_b := v_d_b + v_loser_hand_pts; end if;
  end if;

  -- 티츄/그랜드티츄 보너스: 1등(out_order[1])만 성공
  for v_seat in 0..3 loop
    if v_tichu[v_seat + 1] = 0 then continue; end if;
    v_bonus := case when v_tichu[v_seat + 1] = 200 then 200 else 100 end;
    v_success := (v_out_len >= 1 and v_out_order[1] = v_seat);
    v_team := v_seat % 2;
    if v_team = 0 then
      v_d_a := v_d_a + (case when v_success then v_bonus else -v_bonus end);
    else
      v_d_b := v_d_b + (case when v_success then v_bonus else -v_bonus end);
    end if;
  end loop;

  update games set score_a = score_a + v_d_a, score_b = score_b + v_d_b
  where id = v_game_id
  returning score_a, score_b, target_score, room_id into v_score_a, v_score_b, v_target, v_room_id;

  update rounds set phase = 'scored', score_delta_a = v_d_a, score_delta_b = v_d_b where id = p_round;

  if (v_score_a >= v_target or v_score_b >= v_target) and v_score_a <> v_score_b then
    v_winner_team := case when v_score_a > v_score_b then 0 else 1 end;
    update games set status = 'finished', winner_team = v_winner_team, finished_at = now() where id = v_game_id;
    update rooms set status = 'finished' where id = v_room_id;

    select count(*) into v_rounds_played from rounds where game_id = v_game_id;

    insert into matches (room_id, score_a, score_b, winner_team, rounds_played)
    values (v_room_id, v_score_a, v_score_b, v_winner_team, v_rounds_played)
    returning id into v_match_id;

    for v_seat in 0..3 loop
      insert into match_players (match_id, user_id, seat, team, won, tichu_calls, tichu_wins, grand_calls, grand_wins)
      select
        v_match_id, rp.user_id, v_seat, v_seat % 2, (v_seat % 2) = v_winner_team,
        count(*) filter (where rp.tichu = 100),
        count(*) filter (where rp.tichu = 100 and r.out_order[1] = v_seat),
        count(*) filter (where rp.tichu = 200),
        count(*) filter (where rp.tichu = 200 and r.out_order[1] = v_seat)
      from round_players rp
      join rounds r on r.id = rp.round_id
      where r.game_id = v_game_id and rp.seat = v_seat
      group by rp.user_id;
    end loop;
  else
    -- 동점이면 목표점수 도달해도 계속(위 조건의 "score_a <> score_b"에서 자동으로 이 분기로 빠짐)
    perform _deal_round(v_game_id, (select round_no from games where id = v_game_id) + 1);
  end if;

  perform _emit(v_game_id, 'score_round', jsonb_build_object('round', p_round, 'delta_a', v_d_a, 'delta_b', v_d_b));
end;
$$;
revoke all on function _score_round(uuid) from public;


-- ============================================================================
-- P3. 공개 RPC (전부 SECURITY DEFINER, authenticated에만 EXECUTE 부여)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ensure_profile(p_nickname) → {user_id, nickname}
-- ---------------------------------------------------------------------------
create or replace function ensure_profile(p_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clean text;
begin
  v_clean := regexp_replace(trim(p_nickname), '[\x00-\x1F\x7F]', '', 'g');
  if char_length(v_clean) < 1 or char_length(v_clean) > 12 then
    raise exception '닉네임은 1~12자여야 합니다';
  end if;

  insert into profiles (user_id, nickname) values (auth.uid(), v_clean)
  on conflict (user_id) do update set nickname = excluded.nickname;

  return jsonb_build_object('user_id', auth.uid(), 'nickname', v_clean);
end;
$$;
revoke all on function ensure_profile(text) from public;
grant execute on function ensure_profile(text) to authenticated;

-- ---------------------------------------------------------------------------
-- create_room() → {room_id, code}
-- ---------------------------------------------------------------------------
create or replace function create_room()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- I/O/0/1 제외(오독 방지)
  v_code text;
  v_room_id uuid;
  v_attempt int := 0;
begin
  loop
    v_attempt := v_attempt + 1;
    select string_agg(substr(v_chars, (floor(random() * length(v_chars)))::int + 1, 1), '')
    into v_code
    from generate_series(1, 4);

    begin
      insert into rooms (code, created_by) values (v_code, auth.uid()) returning id into v_room_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 20 then raise exception '방 코드 생성에 실패했습니다. 다시 시도해주세요'; end if;
    end;
  end loop;

  insert into room_seats (room_id, seat, user_id) values (v_room_id, 0, auth.uid());

  return jsonb_build_object('room_id', v_room_id, 'code', v_code);
end;
$$;
revoke all on function create_room() from public;
grant execute on function create_room() to authenticated;

-- ---------------------------------------------------------------------------
-- join_room(p_code) → {room_id, seat, rejoined}  (이미 멤버면 재입장으로 처리)
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
  v_existing_seat smallint;
  v_seat smallint;
begin
  select id, status into v_room_id, v_status from rooms where code = upper(p_code) for update;
  if v_room_id is null then raise exception '방을 찾을 수 없습니다'; end if;

  select seat into v_existing_seat from room_seats where room_id = v_room_id and user_id = auth.uid();
  if v_existing_seat is not null then
    return jsonb_build_object('room_id', v_room_id, 'seat', v_existing_seat, 'rejoined', true);
  end if;

  if v_status <> 'lobby' then raise exception '이미 시작된 방입니다'; end if;

  select min(s) into v_seat from generate_series(0, 3) s
  where s not in (select seat from room_seats where room_id = v_room_id);
  if v_seat is null then raise exception '방이 가득 찼습니다'; end if;

  insert into room_seats (room_id, seat, user_id) values (v_room_id, v_seat, auth.uid());

  return jsonb_build_object('room_id', v_room_id, 'seat', v_seat, 'rejoined', false);
end;
$$;
revoke all on function join_room(text) from public;
grant execute on function join_room(text) to authenticated;

-- ---------------------------------------------------------------------------
-- switch_seat(p_room, p_seat)
-- ---------------------------------------------------------------------------
create or replace function switch_seat(p_room uuid, p_seat smallint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_taken boolean;
begin
  select status into v_status from rooms where id = p_room for update;
  if v_status is null then raise exception '방을 찾을 수 없습니다'; end if;
  if v_status <> 'lobby' then raise exception '이미 시작된 방입니다'; end if;
  if not exists(select 1 from room_seats where room_id = p_room and user_id = auth.uid()) then
    raise exception '이 방의 멤버가 아닙니다';
  end if;
  if p_seat < 0 or p_seat > 3 then raise exception '좌석 번호가 올바르지 않습니다'; end if;

  select exists(select 1 from room_seats where room_id = p_room and seat = p_seat) into v_taken;
  if v_taken then raise exception '이미 사용 중인 좌석입니다'; end if;

  update room_seats set seat = p_seat where room_id = p_room and user_id = auth.uid();
end;
$$;
revoke all on function switch_seat(uuid, smallint) from public;
grant execute on function switch_seat(uuid, smallint) to authenticated;

-- ---------------------------------------------------------------------------
-- leave_room(p_room)
-- ---------------------------------------------------------------------------
create or replace function leave_room(p_room uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from rooms where id = p_room for update;
  if v_status is null then raise exception '방을 찾을 수 없습니다'; end if;
  if v_status <> 'lobby' then raise exception '이미 시작된 방입니다'; end if;
  delete from room_seats where room_id = p_room and user_id = auth.uid();
end;
$$;
revoke all on function leave_room(uuid) from public;
grant execute on function leave_room(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- start_game(p_room) → game id(uuid)
-- ---------------------------------------------------------------------------
create or replace function start_game(p_room uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_seat_count int;
  v_game_id uuid;
begin
  select status into v_status from rooms where id = p_room for update;
  if v_status is null then raise exception '방을 찾을 수 없습니다'; end if;
  if v_status <> 'lobby' then raise exception '이미 시작된 방입니다'; end if;
  if not exists(select 1 from room_seats where room_id = p_room and user_id = auth.uid()) then
    raise exception '이 방의 멤버가 아닙니다';
  end if;

  select count(*) into v_seat_count from room_seats where room_id = p_room;
  if v_seat_count <> 4 then raise exception '4명이 모여야 시작할 수 있습니다'; end if;

  insert into games (room_id) values (p_room) returning id into v_game_id;
  update rooms set status = 'playing', current_game_id = v_game_id where id = p_room;

  perform _deal_round(v_game_id, 1);

  return v_game_id;
end;
$$;
revoke all on function start_game(uuid) from public;
grant execute on function start_game(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- decide_grand(p_round, p_call)
-- ---------------------------------------------------------------------------
create or replace function decide_grand(p_round uuid, p_call boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game_id uuid;
  v_phase text;
  v_seat smallint;
  v_all_done boolean;
begin
  select game_id, phase into v_game_id, v_phase from rounds where id = p_round for update;
  if v_game_id is null then raise exception '라운드를 찾을 수 없습니다'; end if;
  if v_phase <> 'grand' then raise exception '그랜드 티츄를 선언할 단계가 아닙니다'; end if;

  select seat into v_seat from round_players where round_id = p_round and user_id = auth.uid();
  if v_seat is null then raise exception '이 라운드의 참가자가 아닙니다'; end if;
  if (select grand_decided from round_players where round_id = p_round and seat = v_seat) then
    raise exception '이미 결정했습니다';
  end if;

  update round_players
  set grand_decided = true, tichu = case when p_call then 200 else tichu end
  where round_id = p_round and seat = v_seat;

  select bool_and(grand_decided) into v_all_done from round_players where round_id = p_round;

  if v_all_done then
    update hands set cards = cards || hidden6, hidden6 = '{}' where round_id = p_round;
    update round_players set hand_count = 14 where round_id = p_round;
    update rounds set phase = 'exchange' where id = p_round;
  end if;

  return jsonb_build_object('version', _emit(v_game_id, 'grand', jsonb_build_object('seat', v_seat, 'call', p_call)));
end;
$$;
revoke all on function decide_grand(uuid, boolean) from public;
grant execute on function decide_grand(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- call_tichu(p_round)
-- ---------------------------------------------------------------------------
create or replace function call_tichu(p_round uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game_id uuid;
  v_phase text;
  v_seat smallint;
  v_tichu smallint;
  v_hand_count smallint;
begin
  select game_id, phase into v_game_id, v_phase from rounds where id = p_round for update;
  if v_game_id is null then raise exception '라운드를 찾을 수 없습니다'; end if;
  if v_phase not in ('exchange', 'play') then raise exception '지금은 티츄를 선언할 수 없습니다'; end if;

  select seat, tichu, hand_count into v_seat, v_tichu, v_hand_count
  from round_players where round_id = p_round and user_id = auth.uid();
  if v_seat is null then raise exception '이 라운드의 참가자가 아닙니다'; end if;
  if v_tichu <> 0 then raise exception '이미 선언했습니다'; end if;
  if v_hand_count <> 14 then raise exception '카드를 내기 전에만 선언할 수 있습니다'; end if;

  update round_players set tichu = 100 where round_id = p_round and seat = v_seat;

  return jsonb_build_object('version', _emit(v_game_id, 'tichu', jsonb_build_object('seat', v_seat)));
end;
$$;
revoke all on function call_tichu(uuid) from public;
grant execute on function call_tichu(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- submit_exchange(p_round, p_left, p_partner, p_right)
-- ---------------------------------------------------------------------------
create or replace function submit_exchange(p_round uuid, p_left smallint, p_partner smallint, p_right smallint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game_id uuid;
  v_seat smallint;
  v_cards smallint[];
  v_all_done boolean;
  v_target_seat smallint;
  v_recipient_seat smallint;
  v_merge smallint[];
begin
  select game_id into v_game_id from rounds where id = p_round for update;
  if v_game_id is null then raise exception '라운드를 찾을 수 없습니다'; end if;
  if (select phase from rounds where id = p_round) <> 'exchange' then
    raise exception '지금은 교환 단계가 아닙니다';
  end if;

  select seat into v_seat from round_players where round_id = p_round and user_id = auth.uid();
  if v_seat is null then raise exception '이 라운드의 참가자가 아닙니다'; end if;
  if (select exchange_done from round_players where round_id = p_round and seat = v_seat) then
    raise exception '이미 교환을 제출했습니다';
  end if;
  if p_left = p_partner or p_left = p_right or p_partner = p_right then
    raise exception '서로 다른 카드 3장을 선택해야 합니다';
  end if;

  select cards into v_cards from hands where round_id = p_round and seat = v_seat;
  if not (array[p_left, p_partner, p_right] <@ v_cards) then
    raise exception '보유하지 않은 카드입니다';
  end if;

  update hands set cards = _array_remove_many(cards, array[p_left, p_partner, p_right])
  where round_id = p_round and seat = v_seat;

  insert into exchanges (round_id, from_seat, from_user, to_seat, card) values
    (p_round, v_seat, auth.uid(), (v_seat + 3) % 4, p_left),
    (p_round, v_seat, auth.uid(), (v_seat + 2) % 4, p_partner),
    (p_round, v_seat, auth.uid(), (v_seat + 1) % 4, p_right);

  update round_players set exchange_done = true where round_id = p_round and seat = v_seat;

  select bool_and(exchange_done) into v_all_done from round_players where round_id = p_round;

  if v_all_done then
    for v_target_seat in 0..3 loop
      select array_agg(card) into v_merge from exchanges where round_id = p_round and to_seat = v_target_seat;
      update hands set cards = cards || v_merge, received = v_merge
      where round_id = p_round and seat = v_target_seat;
    end loop;

    select seat into v_recipient_seat from hands where round_id = p_round and 52 = any(cards);
    update rounds set phase = 'play', turn_seat = v_recipient_seat, lead_seat = v_recipient_seat
    where id = p_round;
  end if;

  return jsonb_build_object('version', _emit(v_game_id, 'exchange', jsonb_build_object('seat', v_seat)));
end;
$$;
revoke all on function submit_exchange(uuid, smallint, smallint, smallint) from public;
grant execute on function submit_exchange(uuid, smallint, smallint, smallint) to authenticated;

-- ---------------------------------------------------------------------------
-- play_cards(p_round, p_cards, p_wish) → {version, hand}
-- 가장 복잡한 함수: 소유권/턴/조합/봉황단독파워/소원의무/아웃/라운드종료를 모두 검증·처리한다.
-- ---------------------------------------------------------------------------
create or replace function play_cards(p_round uuid, p_cards smallint[], p_wish smallint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game_id uuid;
  v_phase text;
  v_trick_no int;
  v_turn_seat smallint;
  v_wish_rank smallint;
  v_pending_dragon smallint;
  v_out_order smallint[];
  v_seat smallint;
  v_hand smallint[];

  v_top_seat smallint;
  v_top_ctype text;
  v_top_power int;
  v_top_len int;
  v_has_top boolean;

  v_ctype text;
  v_power int;
  v_len int;
  v_is_dog boolean;

  v_seq smallint;
  v_new_hand_count smallint;
  v_partner smallint;
  v_next_seat smallint;
  v_out_len int;
  v_has_wish_rank_card boolean;
begin
  select game_id, phase, trick_no, turn_seat, wish_rank, pending_dragon_seat, out_order
  into v_game_id, v_phase, v_trick_no, v_turn_seat, v_wish_rank, v_pending_dragon, v_out_order
  from rounds where id = p_round for update;
  if v_game_id is null then raise exception '라운드를 찾을 수 없습니다'; end if;
  if v_phase <> 'play' then raise exception '지금은 카드를 낼 수 없습니다'; end if;
  if v_pending_dragon is not null then raise exception '용을 상납해야 합니다'; end if;

  select seat into v_seat from round_players where round_id = p_round and user_id = auth.uid();
  if v_seat is null then raise exception '이 라운드의 참가자가 아닙니다'; end if;

  select cards into v_hand from hands where round_id = p_round and seat = v_seat;
  if coalesce(array_length(p_cards, 1), 0) = 0 then raise exception '낼 카드를 선택해주세요'; end if;
  if not (p_cards <@ v_hand) then raise exception '보유하지 않은 카드입니다'; end if;

  -- 현재 트릭의 top(마지막 non-pass play)
  select seat, ctype, power, array_length(cards, 1)
  into v_top_seat, v_top_ctype, v_top_power, v_top_len
  from plays where round_id = p_round and trick_no = v_trick_no and is_pass = false
  order by seq desc limit 1;
  v_has_top := v_top_seat is not null;

  v_is_dog := (array_length(p_cards, 1) = 1 and p_cards[1] = 53);

  if v_is_dog then
    if v_has_top then raise exception '개는 리드로만 낼 수 있습니다'; end if;
    v_ctype := 'dog'; v_power := null; v_len := 1;
  else
    select ctype, power, len into v_ctype, v_power, v_len from _classify(p_cards) limit 1;
    if v_ctype is null then raise exception '유효하지 않은 조합입니다'; end if;
  end if;

  -- 턴 검증: 내 턴이거나, 트릭이 열려있고 폭탄일 때만 턴 외 허용(개는 열린 트릭이 아니므로 자동 배제)
  if v_seat <> v_turn_seat then
    if not (v_has_top and v_ctype in ('bomb4', 'bombsf')) then
      raise exception '자신의 턴이 아닙니다';
    end if;
  end if;

  -- 봉황 단독 파워 재계산(서버 권위 — 클라 power는 신뢰하지 않음)
  if v_ctype = 'single' and v_power is null then
    if not v_has_top then
      v_power := 3;
    elsif v_top_power = 40 then
      raise exception '용 위에는 봉황을 낼 수 없습니다';
    else
      v_power := v_top_power + 1;
    end if;
  end if;

  if v_has_top then
    if not _beats(v_ctype, v_power, v_len, v_top_ctype, v_top_power, v_top_len) then
      raise exception '직전 패보다 강해야 합니다';
    end if;
  end if;

  -- 소원 의무(rules-spec §4.4의 a/b/c 세 가지만 서버가 강제, 나머지는 클라 legalPlays 책임)
  if v_wish_rank is not null then
    v_has_wish_rank_card := exists(select 1 from unnest(v_hand) c where c < 52 and (c % 13) + 2 = v_wish_rank);
    if v_has_wish_rank_card and v_ctype not in ('bomb4', 'bombsf') then
      if not v_has_top then
        if not exists(select 1 from unnest(p_cards) c where c < 52 and (c % 13) + 2 = v_wish_rank) then
          raise exception '소원을 충족해야 합니다';
        end if;
      elsif v_top_ctype = 'single' then
        if (v_wish_rank * 2) > v_top_power
           and not exists(select 1 from unnest(p_cards) c where c < 52 and (c % 13) + 2 = v_wish_rank)
        then
          raise exception '소원을 충족해야 합니다';
        end if;
      elsif v_top_ctype in ('pair', 'triple', 'bomb4') then
        if (select count(*) from unnest(v_hand) c where c < 52 and (c % 13) + 2 = v_wish_rank) >= v_top_len
           and (select count(*) from unnest(p_cards) c where c < 52 and (c % 13) + 2 = v_wish_rank) < v_top_len
        then
          raise exception '소원을 충족해야 합니다';
        end if;
      end if;
    end if;
  end if;

  -- 소원 해소: 이번 플레이에 소원 랭크의 실물(수트 있는) 카드가 포함되면 즉시 해제
  if v_wish_rank is not null
     and exists(select 1 from unnest(p_cards) c where c < 52 and (c % 13) + 2 = v_wish_rank)
  then
    update rounds set wish_rank = null where id = p_round;
  end if;

  -- 새 소원 설정: 마작을 낼 때만
  if p_wish is not null then
    if not (52 = any(p_cards)) then raise exception '마작을 낼 때만 소원을 설정할 수 있습니다'; end if;
    if p_wish < 2 or p_wish > 14 then raise exception '소원 랭크가 올바르지 않습니다'; end if;
    update rounds set wish_rank = p_wish where id = p_round;
  end if;

  -- 손패 갱신 + plays 기록
  update hands set cards = _array_remove_many(cards, p_cards) where round_id = p_round and seat = v_seat;
  v_new_hand_count := coalesce(array_length(v_hand, 1), 0) - array_length(p_cards, 1);
  update round_players set hand_count = v_new_hand_count where round_id = p_round and seat = v_seat;

  select coalesce(max(seq), 0) + 1 into v_seq from plays where round_id = p_round and trick_no = v_trick_no;
  insert into plays (round_id, trick_no, seq, seat, cards, ctype, power, is_pass)
  values (p_round, v_trick_no, v_seq, v_seat, p_cards, v_ctype, v_power, false);

  -- 아웃 판정(개 처리보다 먼저 — 개가 마지막 카드였을 경우 다음 리드 계산에 반영돼야 함)
  if v_new_hand_count = 0 then
    v_out_order := v_out_order || v_seat;
    update rounds set out_order = v_out_order where id = p_round;
  end if;

  if v_is_dog then
    -- 개: 트릭 없이 즉시 리셋, 파트너(아웃이면 다음 생존자)에게 리드
    v_partner := (v_seat + 2) % 4;
    v_next_seat := _next_survivor(p_round, v_partner);
    update rounds set trick_no = v_trick_no + 1, turn_seat = v_next_seat, lead_seat = v_next_seat
    where id = p_round;
  end if;

  v_out_len := coalesce(array_length(v_out_order, 1), 0);

  if v_out_len = 3 or (v_out_len = 2 and (v_out_order[1] % 2) = (v_out_order[2] % 2)) then
    perform _score_round(p_round);
  elsif not v_is_dog then
    perform _advance_turn(p_round, v_seat);
  end if;

  return jsonb_build_object(
    'version', _emit(v_game_id, 'play', jsonb_build_object('seat', v_seat, 'cards', p_cards)),
    'hand', (select cards from hands where round_id = p_round and seat = v_seat)
  );
end;
$$;
revoke all on function play_cards(uuid, smallint[], smallint) from public;
grant execute on function play_cards(uuid, smallint[], smallint) to authenticated;

-- ---------------------------------------------------------------------------
-- pass_turn(p_round) → {version}
-- ---------------------------------------------------------------------------
create or replace function pass_turn(p_round uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game_id uuid;
  v_phase text;
  v_trick_no int;
  v_turn_seat smallint;
  v_wish_rank smallint;
  v_pending_dragon smallint;
  v_out_order smallint[];
  v_seat smallint;
  v_hand smallint[];

  v_top_seat smallint;
  v_top_ctype text;
  v_top_power int;
  v_top_len int;
  v_top_seq smallint;

  v_seq smallint;
  v_active int;
  v_required int;
  v_trick_cards smallint[];
  v_trick_pts int;
  v_has_dragon boolean;
  v_winner_next smallint;
begin
  select game_id, phase, trick_no, turn_seat, wish_rank, pending_dragon_seat, out_order
  into v_game_id, v_phase, v_trick_no, v_turn_seat, v_wish_rank, v_pending_dragon, v_out_order
  from rounds where id = p_round for update;
  if v_game_id is null then raise exception '라운드를 찾을 수 없습니다'; end if;
  if v_phase <> 'play' then raise exception '지금은 패스할 수 없습니다'; end if;
  if v_pending_dragon is not null then raise exception '용을 상납해야 합니다'; end if;

  select seat into v_seat from round_players where round_id = p_round and user_id = auth.uid();
  if v_seat is null then raise exception '이 라운드의 참가자가 아닙니다'; end if;
  if v_seat <> v_turn_seat then raise exception '자신의 턴이 아닙니다'; end if;

  select seat, ctype, power, array_length(cards, 1), seq
  into v_top_seat, v_top_ctype, v_top_power, v_top_len, v_top_seq
  from plays where round_id = p_round and trick_no = v_trick_no and is_pass = false
  order by seq desc limit 1;
  if v_top_seat is null then raise exception '리드는 패스할 수 없습니다'; end if;

  if v_wish_rank is not null then
    select cards into v_hand from hands where round_id = p_round and seat = v_seat;
    if exists(select 1 from unnest(v_hand) c where c < 52 and (c % 13) + 2 = v_wish_rank) then
      if v_top_ctype = 'single' then
        if v_wish_rank * 2 > v_top_power then raise exception '소원을 충족해야 합니다'; end if;
      elsif v_top_ctype in ('pair', 'triple', 'bomb4') then
        if (select count(*) from unnest(v_hand) c where c < 52 and (c % 13) + 2 = v_wish_rank) >= v_top_len then
          raise exception '소원을 충족해야 합니다';
        end if;
      end if;
    end if;
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq from plays where round_id = p_round and trick_no = v_trick_no;
  insert into plays (round_id, trick_no, seq, seat, cards, ctype, power, is_pass)
  values (p_round, v_trick_no, v_seq, v_seat, '{}', 'pass', null, true);

  -- 트릭 완료 판정: top을 제외한 "현재 생존한" 나머지 전원이 패스했는가
  v_active := 4 - coalesce(array_length(v_out_order, 1), 0);
  v_required := v_active - (case when v_top_seat = any(v_out_order) then 0 else 1 end);

  if (v_seq - v_top_seq) >= v_required then
    select array_agg(c) into v_trick_cards
    from plays, unnest(cards) c
    where round_id = p_round and trick_no = v_trick_no and is_pass = false;

    v_trick_pts := _card_points(v_trick_cards);
    v_has_dragon := 55 = any(v_trick_cards);

    if v_has_dragon then
      update rounds set pending_dragon_seat = v_top_seat, turn_seat = v_top_seat where id = p_round;
    else
      update round_players set taken_points = taken_points + v_trick_pts
      where round_id = p_round and seat = v_top_seat;
      v_winner_next := _next_survivor(p_round, v_top_seat);
      update rounds set trick_no = v_trick_no + 1, lead_seat = v_winner_next, turn_seat = v_winner_next
      where id = p_round;
    end if;
  else
    perform _advance_turn(p_round, v_seat);
  end if;

  return jsonb_build_object('version', _emit(v_game_id, 'pass', jsonb_build_object('seat', v_seat)));
end;
$$;
revoke all on function pass_turn(uuid) from public;
grant execute on function pass_turn(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- gift_dragon(p_round, p_to_seat) → {version}
-- ---------------------------------------------------------------------------
create or replace function gift_dragon(p_round uuid, p_to_seat smallint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game_id uuid;
  v_pending smallint;
  v_trick_no int;
  v_seat smallint;
  v_trick_cards smallint[];
  v_trick_pts int;
  v_next smallint;
begin
  select game_id, pending_dragon_seat, trick_no into v_game_id, v_pending, v_trick_no
  from rounds where id = p_round for update;
  if v_game_id is null then raise exception '라운드를 찾을 수 없습니다'; end if;
  if p_to_seat < 0 or p_to_seat > 3 then raise exception '좌석 번호가 올바르지 않습니다'; end if;

  select seat into v_seat from round_players where round_id = p_round and user_id = auth.uid();
  if v_seat is null or v_seat <> v_pending then raise exception '지금은 용을 넘길 수 없습니다'; end if;
  if (v_seat % 2) = (p_to_seat % 2) then raise exception '상대팀에게만 넘길 수 있습니다'; end if;

  select array_agg(c) into v_trick_cards
  from plays, unnest(cards) c
  where round_id = p_round and trick_no = v_trick_no and is_pass = false;

  v_trick_pts := _card_points(v_trick_cards);

  update round_players set taken_points = taken_points + v_trick_pts
  where round_id = p_round and seat = p_to_seat;

  v_next := _next_survivor(p_round, v_seat);

  update rounds
  set pending_dragon_seat = null, trick_no = v_trick_no + 1, lead_seat = v_next, turn_seat = v_next
  where id = p_round;

  return jsonb_build_object('version', _emit(v_game_id, 'dragon', jsonb_build_object('from', v_seat, 'to', p_to_seat)));
end;
$$;
revoke all on function gift_dragon(uuid, smallint) from public;
grant execute on function gift_dragon(uuid, smallint) to authenticated;

-- ---------------------------------------------------------------------------
-- get_game_state(p_game) → 클라이언트 스냅샷(app.js applySnapshot()과 1:1 대응)
-- ---------------------------------------------------------------------------
create or replace function get_game_state(p_game uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_round_id uuid;
  v_trick_no int;
  v_seat smallint;
begin
  select room_id into v_room_id from games where id = p_game;
  if v_room_id is null then raise exception '게임을 찾을 수 없습니다'; end if;
  if not exists(select 1 from room_seats where room_id = v_room_id and user_id = auth.uid()) then
    raise exception '이 게임의 멤버가 아닙니다';
  end if;

  select id, trick_no into v_round_id, v_trick_no from rounds where game_id = p_game order by round_no desc limit 1;
  select seat into v_seat from round_players where round_id = v_round_id and user_id = auth.uid();

  return jsonb_build_object(
    'game', (
      select jsonb_build_object(
        'id', g.id, 'room_id', g.room_id, 'status', g.status,
        'score_a', g.score_a, 'score_b', g.score_b, 'round_no', g.round_no,
        'version', g.version, 'winner_team', g.winner_team
      )
      from games g where g.id = p_game
    ),
    'round', (
      select jsonb_build_object(
        'id', r.id, 'round_no', r.round_no, 'phase', r.phase,
        'turn_seat', r.turn_seat, 'lead_seat', r.lead_seat, 'trick_no', r.trick_no,
        'wish_rank', r.wish_rank, 'pending_dragon_seat', r.pending_dragon_seat,
        'out_order', r.out_order
      )
      from rounds r where r.id = v_round_id
    ),
    'players', (
      select jsonb_agg(jsonb_build_object(
        'seat', rp.seat, 'user_id', rp.user_id, 'nickname', p.nickname,
        'hand_count', rp.hand_count, 'tichu', rp.tichu,
        'grand_decided', rp.grand_decided, 'exchange_done', rp.exchange_done,
        'taken_points', rp.taken_points
      ) order by rp.seat)
      from round_players rp join profiles p on p.user_id = rp.user_id
      where rp.round_id = v_round_id
    ),
    'trick', (
      select jsonb_agg(jsonb_build_object(
        'seat', pl.seat, 'cards', pl.cards, 'ctype', pl.ctype, 'power', pl.power, 'is_pass', pl.is_pass
      ) order by pl.seq)
      from plays pl where pl.round_id = v_round_id and pl.trick_no = v_trick_no
    ),
    'hand', (
      select jsonb_build_object('cards', h.cards, 'hidden6', h.hidden6, 'received', h.received)
      from hands h where h.round_id = v_round_id and h.seat = v_seat
    ),
    'events', (
      select jsonb_agg(jsonb_build_object(
        'id', ge.id, 'version', ge.version, 'round_no', ge.round_no,
        'seat', ge.seat, 'type', ge.type, 'payload', ge.payload
      ) order by ge.id)
      from (select * from game_events where game_id = p_game order by id desc limit 30) ge
    )
  );
end;
$$;
revoke all on function get_game_state(uuid) from public;
grant execute on function get_game_state(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- abandon_game(p_game)
-- ---------------------------------------------------------------------------
create or replace function abandon_game(p_game uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
begin
  select room_id into v_room_id from games where id = p_game for update;
  if v_room_id is null then raise exception '게임을 찾을 수 없습니다'; end if;
  if not exists(select 1 from room_seats where room_id = v_room_id and user_id = auth.uid()) then
    raise exception '이 게임의 멤버가 아닙니다';
  end if;
  update games set status = 'abandoned' where id = p_game;
  update rooms set status = 'abandoned' where id = v_room_id;
  perform _emit(p_game, 'abandon', '{}'::jsonb);
end;
$$;
revoke all on function abandon_game(uuid) from public;
grant execute on function abandon_game(uuid) to authenticated;
