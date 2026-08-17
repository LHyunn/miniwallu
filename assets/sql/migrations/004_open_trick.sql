-- ============================================================================
-- 004: 라운드 종료 시 열린(미확정) 트릭 점수 증발 버그 수정
--
-- 문제: 3번째 아웃으로 _score_round가 호출될 때, 진행 중이던 트릭의 카드가
-- 누구의 taken_points에도 반영되지 않아 라운드 합계가 100점 미만이 됨(관측: 75).
-- 물리 규칙: 라운드 종료 시 열린 트릭은 그 시점의 마지막 유효 플레이 주인이
-- 가져간다. 용이 포함된 경우는 왼쪽 상대에게 자동 상납(force_timeout과 동일한
-- 단순화 규칙, 주석 명시).
--
-- _score_round를 003 버전 그대로 두고, 첫머리에 열린 트릭 정산만 추가한다.
-- ============================================================================

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
  -- 004 추가: 열린 트릭 정산용
  v_cur_trick int;
  v_open_cards smallint[];
  v_last_seat smallint;
  v_open_pts int;
  v_gift_seat smallint;
begin
  select game_id, out_order, trick_no into v_game_id, v_out_order, v_cur_trick
  from rounds where id = p_round;
  v_out_len := coalesce(array_length(v_out_order, 1), 0);

  -- 004: 열린 트릭이 남아 있으면 마지막 유효 플레이 주인이 가져간다.
  select coalesce(array_agg(c), '{}'::smallint[]) into v_open_cards
  from (
    select unnest(cards) as c
    from plays
    where round_id = p_round and trick_no = v_cur_trick and not is_pass
  ) s;

  if coalesce(array_length(v_open_cards, 1), 0) > 0 then
    select seat into v_last_seat
    from plays
    where round_id = p_round and trick_no = v_cur_trick and not is_pass
    order by seq desc limit 1;

    v_open_pts := _card_points(v_open_cards);
    if 55 = any(v_open_cards) then
      -- 용 포함 트릭: 왼쪽 상대에게 자동 상납 (단순화 — force_timeout과 동일 규칙)
      v_gift_seat := (v_last_seat + 3) % 4;
      update round_players set taken_points = taken_points + v_open_pts
      where round_id = p_round and seat = v_gift_seat;
    else
      update round_players set taken_points = taken_points + v_open_pts
      where round_id = p_round and seat = v_last_seat;
    end if;
  end if;

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
    -- 다음 라운드는 next_round RPC가 시작 (003 유지)
    null;
  end if;

  perform _emit(v_game_id, 'score_round', jsonb_build_object('round', p_round, 'delta_a', v_d_a, 'delta_b', v_d_b));
end;
$$;
revoke all on function _score_round(uuid) from public;
