import { sb, rpc } from "./net.js?v=3";

export function getSession() {
  return sb.auth.getSession();
}

export function onAuth(cb) {
  return sb.auth.onAuthStateChange(cb);
}

export function signInGoogle() {
  return sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.href.split("?")[0] },
  });
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
