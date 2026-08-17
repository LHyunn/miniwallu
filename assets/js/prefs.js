// 미니월루천국 공용 환경설정 — 테마(라이트/다크)와 위장(월루모드) 상태를
// 플랫폼 전체 키 하나로 관리한다. 어느 페이지에서 토글해도 전역 반영.
const THEME_KEY = "mw:theme"; //  'light' | 'dark'
const STEALTH_KEY = "mw:stealth"; // '1' | '0'  (기본 '1' — 위장 ON)

// 구 프로토타입의 게임별 키에서 1회성 승계
function migrateLegacy() {
  if (localStorage.getItem(STEALTH_KEY) == null) {
    const legacy =
      localStorage.getItem("tichu-stealth") ??
      localStorage.getItem("numball-stealth") ??
      localStorage.getItem("omok-stealth");
    if (legacy != null) localStorage.setItem(STEALTH_KEY, legacy === "0" ? "0" : "1");
  }
  if (localStorage.getItem(THEME_KEY) == null) {
    const legacy =
      localStorage.getItem("tichu-theme") ??
      localStorage.getItem("numball-theme") ??
      localStorage.getItem("omok-theme");
    if (legacy === "dark" || legacy === "light") localStorage.setItem(THEME_KEY, legacy);
  }
}
migrateLegacy();

export function getTheme() {
  // 밤이 이 플랫폼의 기본 정체성 — 명시적으로 light를 고른 경우에만 라이트
  return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
}

export function getStealth() {
  return localStorage.getItem(STEALTH_KEY) !== "0";
}

export function applyPrefs() {
  document.body.dataset.theme = getTheme();
  document.body.classList.toggle("stealth", getStealth());
}

export function setTheme(theme) {
  localStorage.setItem(THEME_KEY, theme === "dark" ? "dark" : "light");
  applyPrefs();
}

export function setStealth(on) {
  localStorage.setItem(STEALTH_KEY, on ? "1" : "0");
  applyPrefs();
}

// 헤더의 테마/위장 토글 버튼 배선. onChange는 페이지가 재렌더 등 후속 처리에 쓴다.
export function initPrefsUI({ themeBtn, stealthBtn, stealthTitle, normalTitle, onChange } = {}) {
  const sync = () => {
    applyPrefs();
    if (themeBtn) themeBtn.textContent = getTheme() === "dark" ? "☀️" : "🌙";
    if (stealthBtn) {
      stealthBtn.textContent = getStealth() ? "📊" : "👔";
      stealthBtn.title = getStealth() ? "위장 끄기" : "위장 켜기";
    }
    if (stealthTitle && normalTitle) document.title = getStealth() ? stealthTitle : normalTitle;
    if (onChange) onChange({ theme: getTheme(), stealth: getStealth() });
  };
  if (themeBtn)
    themeBtn.addEventListener("click", () => {
      setTheme(getTheme() === "dark" ? "light" : "dark");
      sync();
    });
  if (stealthBtn)
    stealthBtn.addEventListener("click", () => {
      setStealth(!getStealth());
      sync();
    });
  sync();
}
