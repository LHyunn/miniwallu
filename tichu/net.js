import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://erhsygjsnlbchvfwwodz.supabase.co";
const SUPABASE_KEY = "sb_publishable_-i288itoXEKj5KUY0LZkJw_ZX09C2Em";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error.message;
  return data;
}

export function gameChannel(gameId, { onGameUpdate, onEvent, onHand }) {
  const channel = sb
    .channel("game:" + gameId)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "games", filter: "id=eq." + gameId },
      (payload) => onGameUpdate(payload.new)
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "game_events", filter: "game_id=eq." + gameId },
      (payload) => onEvent(payload.new)
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "hands" },
      (payload) => onHand(payload.new)
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "hands" },
      (payload) => onHand(payload.new)
    )
    .subscribe();
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

// 방 설정(목표점수/제한시간) 변경을 같은 방 멤버 전원에게 알림 (방장이 호출)
export async function announceSettings(channel, settings) {
  await channel.send({ type: "broadcast", event: "settings", payload: settings });
}

export async function getState(gameId) {
  return rpc("get_game_state", { p_game: gameId });
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

// 내가 참여 중인 진행 방(대기실/게임 중) 조회 — 접속 화면의 "이어하기"용
export async function getMyActiveRoom(userId) {
  const { data, error } = await sb
    .from("room_seats")
    .select("room_id, seat, user_id, rooms(code, status, current_game_id)")
    .eq("user_id", userId)
    .order("joined_at", { ascending: false })
    .limit(5);
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
      }
    : null;
}
