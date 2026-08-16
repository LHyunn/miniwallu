// 미니월루천국 공용 인증 계층. 같은 origin이므로 Supabase 세션(localStorage)이
// 랜딩/로그인/전적/게임 전 페이지에서 자동 공유된다 — 로그인은 /login/ 한 곳에서만 한다.
import { sb, rpc } from "/assets/js/supabase.js";

export const PENDING_NICK_KEY = "mw:pending-nick";

export function getSession() {
  return sb.auth.getSession();
}

export function onAuth(cb) {
  return sb.auth.onAuthStateChange(cb);
}

// 구글 OAuth 왕복 후 /login/으로 돌아와 next 처리를 이어간다.
export function signInGoogle(next) {
  const redirectTo =
    location.origin + "/login/" + (next ? "?next=" + encodeURIComponent(next) : "");
  return sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
}

export function signInAnon() {
  return sb.auth.signInAnonymously();
}

export function signOut() {
  return sb.auth.signOut();
}

export async function ensureProfile(nickname) {
  return rpc("ensure_profile", { p_nickname: nickname });
}

export async function getProfile(userId) {
  const { data } = await sb
    .from("profiles")
    .select("nickname")
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

// 오픈 리다이렉트 차단: 우리 origin 안의 경로만 허용
export function safeNext(raw) {
  if (typeof raw !== "string") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

// 게임/전적 페이지 최상단에서 호출. 세션+프로필이 없으면 /login/으로 보낸다.
// 리다이렉트가 일어나면 영원히 resolve되지 않는 Promise를 반환해 이후 코드를 멈춘다.
export async function requireAuth() {
  const {
    data: { session },
  } = await getSession();
  if (session) {
    const profile = await getProfile(session.user.id);
    if (profile) return { session, profile };
  }
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace("/login/?next=" + next);
  return new Promise(() => {});
}
