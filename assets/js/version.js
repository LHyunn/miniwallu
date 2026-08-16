// 배포 감지 — 루트 /version.json 의 build 값이 페이지 로드 시점과 달라지면
// 우하단에 새로고침 안내 바를 띄운다. 캐시는 _headers(no-cache)가 책임지므로
// 이 모듈은 "열려 있는 탭"에게 새 배포를 알리는 용도만 맡는다.
let baseline = null;

async function fetchBuild() {
  try {
    const res = await fetch("/version.json", { cache: "no-store" });
    const v = await res.json();
    return v.build ?? null;
  } catch {
    return null;
  }
}

function showNotice() {
  if (document.getElementById("mw-update-notice")) return;
  const bar = document.createElement("div");
  bar.id = "mw-update-notice";
  bar.innerHTML = "새 버전이 있습니다 <button>새로고침</button>";
  bar.querySelector("button").addEventListener("click", () => location.reload());
  document.body.appendChild(bar);
}

export function startVersionWatch({ intervalMs = 60000 } = {}) {
  fetchBuild().then((b) => {
    baseline = b;
    if (baseline == null) return;
    setInterval(async () => {
      const b2 = await fetchBuild();
      if (b2 != null && b2 !== baseline) showNotice();
    }, intervalMs);
  });
}
