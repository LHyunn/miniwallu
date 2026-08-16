// 미니월루천국 공용 Supabase 계층.
// 반드시 절대경로("/assets/js/supabase.js")로만 import할 것 — 상대경로+쿼리스트링 혼용은
// ES 모듈을 중복 평가시켜 GoTrueClient가 2개 생기는 버그를 만든다(구 프로토타입에서 실제 발생).
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://erhsygjsnlbchvfwwodz.supabase.co";
const SUPABASE_KEY = "sb_publishable_-i288itoXEKj5KUY0LZkJw_ZX09C2Em"; // publishable — 공개 가능 값

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error.message;
  return data;
}

// 게임 실시간 채널. privateTable: 나에게만 오는 비공개 행 테이블(티츄=hands, 오목/야구=없음).
export function gameChannel(gameId, { onGameUpdate, onEvent, onPrivate, privateTable } = {}) {
  let channel = sb
    .channel("game:" + gameId)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "games", filter: "id=eq." + gameId },
      (payload) => onGameUpdate && onGameUpdate(payload.new)
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "game_events", filter: "game_id=eq." + gameId },
      (payload) => onEvent && onEvent(payload.new)
    );
  if (privateTable && onPrivate) {
    channel = channel
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: privateTable },
        (payload) => onPrivate(payload.new)
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: privateTable },
        (payload) => onPrivate(payload.new)
      );
  }
  channel.subscribe();
  return { unsubscribe: () => channel.unsubscribe() };
}

export function roomPresence(roomId, meta, onSync, onGameStart, onSettings) {
  const channel = sb.channel("room:" + roomId);
  channel
    .on("presence", { event: "sync" }, () => onSync(channel.presenceState()))
    .on("broadcast", { event: "game_start" }, (msg) => {
      if (onGameStart) onGameStart(msg.payload);
    })
    .on("broadcast", { event: "settings" }, (msg) => {
      if (onSettings) onSettings(msg.payload);
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") await channel.track(meta);
    });
  return channel;
}

// 게임 시작을 같은 방 멤버 전원에게 알림 (시작 버튼 누른 사람이 호출)
export async function announceGameStart(channel, gameId) {
  await channel.send({ type: "broadcast", event: "game_start", payload: { gameId } });
}

// 방 설정 변경을 같은 방 멤버 전원에게 알림 (방장이 호출)
export async function announceSettings(channel, settings) {
  await channel.send({ type: "broadcast", event: "settings", payload: settings });
}

// 재입장 시 방이 이미 게임 중인지 확인 (RLS: 멤버만 조회 가능)
export async function getRoomStatus(roomId) {
  const { data, error } = await sb
    .from("rooms")
    .select("status, current_game_id, target_score, turn_seconds, created_by")
    .eq("id", roomId)
    .single();
  if (error) throw error.message;
  return data;
}

// 내가 참여 중인 진행 방(대기실/게임 중) 조회 — 랜딩·게임의 "이어하기"용.
// 마이그레이션 005(rooms.game_type) 적용 전에는 game_type 없는 셀렉트로 폴백한다.
export async function getMyActiveRoom(userId) {
  let { data, error } = await sb
    .from("room_seats")
    .select("room_id, seat, user_id, rooms(code, status, current_game_id, game_type)")
    .eq("user_id", userId)
    .order("joined_at", { ascending: false })
    .limit(5);
  if (error) {
    ({ data, error } = await sb
      .from("room_seats")
      .select("room_id, seat, user_id, rooms(code, status, current_game_id)")
      .eq("user_id", userId)
      .order("joined_at", { ascending: false })
      .limit(5));
  }
  if (error) throw error.message;
  const active = (data || []).find(
    (r) => r.rooms && (r.rooms.status === "lobby" || r.rooms.status === "playing")
  );
  return active
    ? {
        roomId: active.room_id,
        seat: active.seat,
        code: active.rooms.code,
        status: active.rooms.status,
        gameId: active.rooms.current_game_id,
        gameType: active.rooms.game_type || "tichu",
      }
    : null;
}
