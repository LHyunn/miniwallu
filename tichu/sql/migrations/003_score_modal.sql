-- ============================================================================
-- 003: 점수 모달이 보이도록 라운드 전환을 명시적 RPC로 분리
--
-- 문제: schema.sql의 _score_round가 정산 직후 같은 트랜잭션에서 다음 라운드를
-- 즉시 딜하므로, 클라이언트가 스냅샷을 새로고침하면 이미 phase='grand'가 되어
-- 점수 모달(phase='scored' 조건)이 표시될 기회가 없다.
--
-- 해결: _score_round에서 자동 _deal_round 제거. 다음 라운드는 점수 모달의
-- "다음 라운드" 버튼이 호출하는 next_round RPC(멤버 누구나)가 시작한다.
-- ============================================================================

-- _score_round 교체: schema.sql 원본과 동일하되, 마지막 else 분기의
-- 자동 _deal_round 호출만 제거 (차이는 아래 "003 변경" 주석 참조)
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
    -- 003 변경: 여기서 자동으로 다음 라운드를 딜하지 않는다.
    -- 점수 모달 확인 후 next_round RPC가 다음 라운드를 시작한다.
    null;
  end if;

  perform _emit(v_game_id, 'score_round', jsonb_build_object('round', p_round, 'delta_a', v_d_a, 'delta_b', v_d_b));
end;
$$;
revoke all on function _score_round(uuid) from public;

-- ---------------------------------------------------------------------------
-- next_round(p_game): 정산 확인 후 다음 라운드 시작 (멤버 누구나, 중복 클릭 안전)
-- ---------------------------------------------------------------------------
create or replace function next_round(p_game uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_round_no int;
  v_room_id uuid;
  v_phase text;
begin
  select status, round_no, room_id into v_status, v_round_no, v_room_id
  from games where id = p_game for update;
  if v_status is null then raise exception '게임을 찾을 수 없습니다'; end if;
  if not is_room_member(v_room_id) then raise exception '이 방의 멤버가 아닙니다'; end if;
  if v_status <> 'playing' then raise exception '이미 종료된 게임입니다'; end if;

  select phase into v_phase from rounds where game_id = p_game and round_no = v_round_no;
  if v_phase <> 'scored' then raise exception '정산이 끝난 뒤에 시작할 수 있습니다'; end if;

  perform _deal_round(p_game, v_round_no + 1);
  perform _emit(p_game, 'next_round', jsonb_build_object('round_no', v_round_no + 1));
end;
$$;
revoke all on function next_round(uuid) from public;
grant execute on function next_round(uuid) to authenticated;
