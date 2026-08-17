// 미니월루천국 공용 — 가짜 엑셀 크롬 마크업 주입.
// 스타일은 /assets/css/chrome.css. 각 게임은 부팅 시 mountChrome() 1회 호출 후
// #sheet-grid를 자기 시트 렌더러로 채운다. (#sheet-stash는 innerHTML 교체 시
// 살아있는 버튼을 대피시키는 용도 — 티츄 stealth.js 참고)
export function mountChrome({ filename, sheetName = "Sheet1", into = "#screen-game" } = {}) {
  const host = document.querySelector(into);
  if (!host || host.querySelector(".xl-titlebar")) return; // 중복 마운트 방지

  host.insertAdjacentHTML(
    "beforeend",
    `
    <div class="xl-titlebar">
      <span class="xl-qat">▦&nbsp;&nbsp;↺&nbsp;&nbsp;↻&nbsp;&nbsp;▾</span>
      <span id="xl-filename"></span>
      <span class="xl-title-spacer"></span>
      <span class="xl-wincontrols"><span>─</span><span>▢</span><span>✕</span></span>
    </div>
    <div class="xl-menubar">
      <span class="xl-menu xl-menu-file">파일</span>
      <span class="xl-menu active">홈</span>
      <span class="xl-menu">삽입</span>
      <span class="xl-menu">페이지 레이아웃</span>
      <span class="xl-menu">수식</span>
      <span class="xl-menu">데이터</span>
      <span class="xl-menu">검토</span>
      <span class="xl-menu">보기</span>
      <span class="xl-menu">도움말</span>
    </div>
    <div class="xl-toolbar">
      <span class="xl-tool-group"><span class="xl-fontbox">맑은 고딕 <small>▾</small></span><span class="xl-sizebox">11 <small>▾</small></span></span>
      <span class="xl-tool-group"><span class="xl-tool"><b>가</b></span><span class="xl-tool"><i>가</i></span><span class="xl-tool"><u>가</u></span></span>
      <span class="xl-tool-group"><span class="xl-tool">田</span><span class="xl-tool">◇</span><span class="xl-tool">🄰</span></span>
      <span class="xl-tool-group"><span class="xl-tool">☰</span><span class="xl-tool">≡</span><span class="xl-tool">☱</span></span>
      <span class="xl-tool-group"><span class="xl-fontbox">일반 <small>▾</small></span><span class="xl-tool">%</span><span class="xl-tool">,</span></span>
    </div>
    <div class="xl-formulabar">
      <span id="xl-namebox">A1</span>
      <span class="xl-fx">fx</span>
      <span class="xl-formula-input" id="xl-formula"></span>
    </div>
    <div class="xl-grid-area">
      <table id="sheet"><tbody id="sheet-grid"></tbody></table>
    </div>
    <div class="xl-tabs"><span class="xl-tab">${sheetName}</span><span class="xl-tab-add">+</span></div>
    <div class="xl-statusbar"><span>준비</span><span class="xl-status-right">▦ ▤ ▥ &nbsp;&nbsp;&mdash;&nbsp;&#9472;&#9472;&#9679;&#9472;&#9472;&nbsp;&#43;&nbsp;&nbsp;100%</span></div>
    <div id="sheet-stash" class="hidden"></div>
  `
  );
  if (filename) setChromeFilename(filename);
}

export function setChromeFilename(name) {
  const node = document.getElementById("xl-filename");
  if (node) node.textContent = name;
}

export function setNameBox(addr) {
  const node = document.getElementById("xl-namebox");
  if (node) node.textContent = addr;
}

export function setFormula(text) {
  const node = document.getElementById("xl-formula");
  if (node) node.textContent = text;
}
