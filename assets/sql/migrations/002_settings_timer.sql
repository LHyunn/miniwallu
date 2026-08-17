-- ============================================================================
-- 마이그레이션 002: 방 설정(목표점수/제한시간) + 턴 타임아웃
--
-- 실행 방법: 이 파일 전체를 기존 프로젝트(schema.sql이 이미 적용된)의 SQL Editor에
-- 한 번에 붙여넣어 1회 실행한다. schema.sql은 건드리지 않는다.
--
-- 이 파일은 schema.sql의 함수 본문을 그대로 복사해 확장한 create or replace로
-- 구성되어 있다. 원본과 달라진 부분에는 "-- 차이(원본 대비): ..." 주석을 달았다.
-- ============================================================================


-- ============================================================================
-- 1. 컬럼 추가
-- ============================================================================

alter table rooms
  add column target_score int not null default 1000,
  add column turn_seconds int not null default 0;

alter table games
  add column turn_seconds int not null default 0;

alter table rounds
  add column turn_deadline timestamptz;


-- ============================================================================
-- 2. 내부 헬퍼: _touch_deadline (신규)
--    해당 라운드가 속한 game의 turn_seconds가 0이면 무제한(turn_deadline=null),
--    아니면 now() + turn_seconds로 갱신한다. 턴이 바뀌는 모든 지점에서 호출한다.
-- ============================================================================

create or replace function _touch_deadline(p_round uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn_seconds int;
begin
  select g.turn_seconds into v_turn_seconds
  from rounds r join games g on g.id = r.game_id
  where r.id = p_round;

  if v_turn_seconds is null or v_turn_seconds = 0 then
    update rounds set turn_deadline = null where id = p_round;
  else
    update rounds set turn_deadline = now() + make_interval(secs => v_turn_seconds) where id = p_round;
  end if;
end;
$$;
revoke all on function _touch_deadline(uuid) from public;


-- ============================================================================
-- 3. _advance_turn 교체 — 원본 로직 그대로, 턴 확정 직후 _touch_deadline 호출만 추가.
--    (play_cards/pass_turn 양쪽에서 공통으로 쓰는 "정상 진행" 턴 전진 경로이므로
--    여기 한 곳에 추가하면 두 함수의 해당 분기를 모두 커버한다.)
-- ============================================================================

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
      perform _touch_deadline(p_round); -- 차이(원본 대비): 턴 전진 직후 데드라인 갱신
      return;
    end if;
  end loop;
end;
$$;
revoke all on function _advance_turn(uuid, smallint) from public;


-- ============================================================================
-- 4. start_game 교체 — 원본 로직 유지 + games.target_score/turn_seconds를
--    rooms의 현재 설정값으로 복사해서 생성.
-- ============================================================================

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

  -- 차이(원본 대비): insert into games (room_id) 단일 컬럼 → rooms의 target_score/turn_seconds를 복사
  insert into games (room_id, target_score, turn_seconds)
  select p_room, target_score, turn_seconds from rooms where id = p_room
  returning id into v_game_id;

  update rooms set status = 'playing', current_game_id = v_game_id where id = p_room;

  perform _deal_round(v_game_id, 1);

  return v_game_id;
end;
$$;
revoke all on function start_game(uuid) from public;
grant execute on function start_game(uuid) to authenticated;


-- ============================================================================
-- 5. play_cards 교체 — 원본 로직 그대로, "개" 리드로 턴이 바뀌는 직후에만
--    _touch_deadline 호출 추가(그 외 턴 전진은 _advance_turn 내부에서 이미 처리됨).
-- ============================================================================

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
    perform _touch_deadline(p_round); -- 차이(원본 대비): 개 리드로 턴이 바뀐 직후 데드라인 갱신
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


-- ============================================================================
-- 6. pass_turn 교체 — 원본 로직 그대로, 용 상납 대기 진입 / 트릭 승자 리드 전환
--    직후에 _touch_deadline 호출 추가(else 분기의 정상 전진은 _advance_turn이 처리).
-- ============================================================================

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
      perform _touch_deadline(p_round); -- 차이(원본 대비): 용 상납 대기 진입 직후 데드라인 갱신
    else
      update round_players set taken_points = taken_points + v_trick_pts
      where round_id = p_round and seat = v_top_seat;
      v_winner_next := _next_survivor(p_round, v_top_seat);
      update rounds set trick_no = v_trick_no + 1, lead_seat = v_winner_next, turn_seat = v_winner_next
      where id = p_round;
      perform _touch_deadline(p_round); -- 차이(원본 대비): 트릭 승자 리드 전환 직후 데드라인 갱신
    end if;
  else
    perform _advance_turn(p_round, v_seat);
  end if;

  return jsonb_build_object('version', _emit(v_game_id, 'pass', jsonb_build_object('seat', v_seat)));
end;
$$;
revoke all on function pass_turn(uuid) from public;
grant execute on function pass_turn(uuid) to authenticated;


-- ============================================================================
-- 7. gift_dragon 교체 — 원본 로직 그대로, 다음 리드로 턴이 바뀐 직후 _touch_deadline 추가.
-- ============================================================================

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
  perform _touch_deadline(p_round); -- 차이(원본 대비): 상납 완료 후 다음 리드 데드라인 갱신

  return jsonb_build_object('version', _emit(v_game_id, 'dragon', jsonb_build_object('from', v_seat, 'to', p_to_seat)));
end;
$$;
revoke all on function gift_dragon(uuid, smallint) from public;
grant execute on function gift_dragon(uuid, smallint) to authenticated;


-- ============================================================================
-- 8. submit_exchange 교체 — 원본 로직 그대로, 4/4 완료로 phase='play' 진입 직후
--    _touch_deadline 호출 추가.
-- ============================================================================

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
    perform _touch_deadline(p_round); -- 차이(원본 대비): play 단계 진입 직후 데드라인 설정
  end if;

  return jsonb_build_object('version', _emit(v_game_id, 'exchange', jsonb_build_object('seat', v_seat)));
end;
$$;
revoke all on function submit_exchange(uuid, smallint, smallint, smallint) from public;
grant execute on function submit_exchange(uuid, smallint, smallint, smallint) to authenticated;


-- ============================================================================
-- 9. get_game_state 교체 — 원본 반환 유지 + round.turn_deadline, game.turn_seconds 추가.
-- ============================================================================

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
        'version', g.version, 'winner_team', g.winner_team,
        'turn_seconds', g.turn_seconds -- 차이(원본 대비): 추가
      )
      from games g where g.id = p_game
    ),
    'round', (
      select jsonb_build_object(
        'id', r.id, 'round_no', r.round_no, 'phase', r.phase,
        'turn_seat', r.turn_seat, 'lead_seat', r.lead_seat, 'trick_no', r.trick_no,
        'wish_rank', r.wish_rank, 'pending_dragon_seat', r.pending_dragon_seat,
        'out_order', r.out_order,
        'turn_deadline', r.turn_deadline -- 차이(원본 대비): 추가
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


-- ============================================================================
-- 10. set_room_settings(p_room, p_target, p_turn_seconds) (신규)
--     방장만, lobby 단계에서만, 목표점수/제한시간을 검증 후 저장.
-- ============================================================================

create or replace function set_room_settings(p_room uuid, p_target int, p_turn_seconds int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_created_by uuid;
begin
  select status, created_by into v_status, v_created_by from rooms where id = p_room for update;
  if v_status is null then raise exception '방을 찾을 수 없습니다'; end if;
  if v_created_by <> auth.uid() then raise exception '방장만 설정을 변경할 수 있습니다'; end if;
  if v_status <> 'lobby' then raise exception '이미 시작된 방입니다'; end if;
  if p_target < 100 or p_target > 2000 then raise exception '목표 점수가 올바르지 않습니다'; end if;
  if p_turn_seconds not in (0, 30, 60, 90) then raise exception '제한 시간이 올바르지 않습니다'; end if;

  update rooms set target_score = p_target, turn_seconds = p_turn_seconds where id = p_room;
end;
$$;
revoke all on function set_room_settings(uuid, int, int) from public;
grant execute on function set_room_settings(uuid, int, int) to authenticated;


-- ============================================================================
-- 11. force_timeout(p_round) (신규)
--     멤버 누구나 호출 가능. phase='play' && now() > turn_deadline일 때만 동작.
--     분기 (a) 용 상납 대기 → gift_dragon 로직 복제(대상만 "왼쪽 상대"로 자동 결정)
--          (b) 트릭 열림 → pass_turn의 자동 패스 로직 복제(트릭 확정 포함)
--          (c) 리드 → play_cards의 싱글 경로 복제(손패 최저 파워 싱글, 개 제외,
--              마작이어도 소원은 설정하지 않음)
--     각 분기 후 _touch_deadline + _emit('timeout', ...).
-- ============================================================================

create or replace function force_timeout(p_round uuid)
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
  v_turn_deadline timestamptz;
  v_caller_seat smallint;

  -- (a) 용 상납 자동 처리용
  v_left smallint;
  v_to_seat smallint;
  v_trick_cards smallint[];
  v_trick_pts int;
  v_next smallint;

  -- (b) 자동 패스용
  v_top_seat smallint;
  v_top_seq smallint;
  v_seq smallint;
  v_active int;
  v_required int;
  v_has_dragon boolean;
  v_winner_next smallint;

  -- (c) 최저 싱글 자동 리드용
  v_hand smallint[];
  v_lowest_card smallint;
  v_lowest_power int;
  v_cur_power int;
  v_ctype text;
  v_power int;
  v_len int;
  v_new_hand_count smallint;
  v_out_len int;
  v_c smallint;
begin
  select game_id, phase, trick_no, turn_seat, wish_rank, pending_dragon_seat, out_order, turn_deadline
  into v_game_id, v_phase, v_trick_no, v_turn_seat, v_wish_rank, v_pending_dragon, v_out_order, v_turn_deadline
  from rounds where id = p_round for update;
  if v_game_id is null then raise exception '라운드를 찾을 수 없습니다'; end if;

  select seat into v_caller_seat from round_players where round_id = p_round and user_id = auth.uid();
  if v_caller_seat is null then raise exception '이 라운드의 참가자가 아닙니다'; end if;

  if v_phase <> 'play' then raise exception '지금은 시간초과를 처리할 수 없습니다'; end if;
  if v_turn_deadline is null or now() <= v_turn_deadline then
    raise exception '아직 시간이 초과되지 않았습니다';
  end if;

  -- (a) 용 상납 대기 중 타임아웃: gift_dragon 로직 복제. 대상은 "왼쪽 상대"
  -- (app.js btn-dragon-left와 동일하게 (seat+3)%4를 왼쪽으로 정의한다).
  -- (seat+3)%4가 상대팀이면 그쪽, 아니면(파트너면) (seat+1)%4 — 2v2 좌석배치상
  -- (seat+3)%4는 항상 상대팀이므로 else 분기는 방어적 코드다.
  if v_pending_dragon is not null then
    v_left := (v_pending_dragon + 3) % 4;
    if (v_left % 2) <> (v_pending_dragon % 2) then
      v_to_seat := v_left;
    else
      v_to_seat := (v_pending_dragon + 1) % 4;
    end if;

    select array_agg(c) into v_trick_cards
    from plays, unnest(cards) c
    where round_id = p_round and trick_no = v_trick_no and is_pass = false;

    v_trick_pts := _card_points(v_trick_cards);

    update round_players set taken_points = taken_points + v_trick_pts
    where round_id = p_round and seat = v_to_seat;

    v_next := _next_survivor(p_round, v_pending_dragon);

    update rounds
    set pending_dragon_seat = null, trick_no = v_trick_no + 1, lead_seat = v_next, turn_seat = v_next
    where id = p_round;

    perform _touch_deadline(p_round);

    return jsonb_build_object(
      'version', _emit(v_game_id, 'timeout', jsonb_build_object('kind', 'dragon', 'seat', v_pending_dragon, 'to', v_to_seat))
    );
  end if;

  -- 현재 트릭의 top(마지막 non-pass play) 확인 → 열린 트릭이면 (b), 리드면 (c)
  select seat, seq
  into v_top_seat, v_top_seq
  from plays where round_id = p_round and trick_no = v_trick_no and is_pass = false
  order by seq desc limit 1;

  if v_top_seat is not null then
    -- (b) 트릭 열림: pass_turn의 자동 패스 로직 복제(트릭 확정 포함)
    select coalesce(max(seq), 0) + 1 into v_seq from plays where round_id = p_round and trick_no = v_trick_no;
    insert into plays (round_id, trick_no, seq, seat, cards, ctype, power, is_pass)
    values (p_round, v_trick_no, v_seq, v_turn_seat, '{}', 'pass', null, true);

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
        perform _touch_deadline(p_round);
      else
        update round_players set taken_points = taken_points + v_trick_pts
        where round_id = p_round and seat = v_top_seat;
        v_winner_next := _next_survivor(p_round, v_top_seat);
        update rounds set trick_no = v_trick_no + 1, lead_seat = v_winner_next, turn_seat = v_winner_next
        where id = p_round;
        perform _touch_deadline(p_round);
      end if;
    else
      perform _advance_turn(p_round, v_turn_seat);
    end if;

    return jsonb_build_object('version', _emit(v_game_id, 'timeout', jsonb_build_object('kind', 'pass', 'seat', v_turn_seat)));
  end if;

  -- (c) 리드: 손패 최저 파워 싱글(개 제외) 자동 플레이. play_cards의 싱글 경로 복제
  -- (plays 기록/hand 갱신/아웃·라운드종료 판정 포함). 파워 스케일은 _classify의
  -- 단일 카드 판정과 동일: 마작=2, 봉황(리드)=3, 일반=rank*2, 용=40.
  select cards into v_hand from hands where round_id = p_round and seat = v_turn_seat;

  v_lowest_card := null;
  v_lowest_power := null;
  foreach v_c in array v_hand loop
    if v_c = 53 then continue; end if; -- 개는 자동 리드 대상에서 제외
    v_cur_power := case
      when v_c = 55 then 40
      when v_c = 54 then 3
      when v_c = 52 then 2
      else ((v_c % 13) + 2) * 2
    end;
    if v_lowest_power is null or v_cur_power < v_lowest_power then
      v_lowest_power := v_cur_power;
      v_lowest_card := v_c;
    end if;
  end loop;

  if v_lowest_card is null then
    raise exception '자동으로 낼 카드가 없습니다';
  end if;

  select ctype, power, len into v_ctype, v_power, v_len from _classify(array[v_lowest_card]) limit 1;
  if v_ctype = 'single' and v_power is null then
    v_power := 3; -- 봉황 단독 리드 파워(play_cards와 동일)
  end if;

  update hands set cards = _array_remove_many(cards, array[v_lowest_card]) where round_id = p_round and seat = v_turn_seat;
  v_new_hand_count := coalesce(array_length(v_hand, 1), 0) - 1;
  update round_players set hand_count = v_new_hand_count where round_id = p_round and seat = v_turn_seat;

  select coalesce(max(seq), 0) + 1 into v_seq from plays where round_id = p_round and trick_no = v_trick_no;
  insert into plays (round_id, trick_no, seq, seat, cards, ctype, power, is_pass)
  values (p_round, v_trick_no, v_seq, v_turn_seat, array[v_lowest_card], v_ctype, v_power, false);

  -- 소원 해소(play_cards와 동일 조건). 마작을 낼 때 새 소원은 설정하지 않는다(스펙 요구사항).
  if v_wish_rank is not null and v_lowest_card < 52 and (v_lowest_card % 13) + 2 = v_wish_rank then
    update rounds set wish_rank = null where id = p_round;
  end if;

  if v_new_hand_count = 0 then
    v_out_order := v_out_order || v_turn_seat;
    update rounds set out_order = v_out_order where id = p_round;
  end if;

  v_out_len := coalesce(array_length(v_out_order, 1), 0);

  if v_out_len = 3 or (v_out_len = 2 and (v_out_order[1] % 2) = (v_out_order[2] % 2)) then
    perform _score_round(p_round);
  else
    perform _advance_turn(p_round, v_turn_seat);
  end if;

  return jsonb_build_object(
    'version', _emit(v_game_id, 'timeout', jsonb_build_object('kind', 'lead', 'seat', v_turn_seat, 'cards', array[v_lowest_card]))
  );
end;
$$;
revoke all on function force_timeout(uuid) from public;
grant execute on function force_timeout(uuid) to authenticated;
