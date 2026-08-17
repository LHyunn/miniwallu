# 미니월루천국 구현 계획

직장인 위장 게임 플랫폼. 프론트 = Cloudflare Pages(이 repo), 백엔드 = Supabase(erhsygjsnlbchvfwwodz, 무료 티어).
구 GitHub Pages(lhyunn/weekly-report)는 프로토타입 — P0~P3 동안 그대로 살려두고 P4에서 리다이렉트 은퇴.

## 확정 결정
- 이름: **미니월루천국**. 호스팅: **Cloudflare Pages** (대역폭 무제한, `_headers` 지원, 빌드 없음).
- 빌드 도구 없음. `?v=N` 수동 캐시버스팅 **폐기** → `_headers`의 `Cache-Control: no-cache` + 절대경로 import.
  (구 프로토타입에서 auth.js `?v=3` vs app.js `?v=11`로 Supabase 클라이언트가 2중 생성되는 실버그 있었음 — 절대경로 단일 URL이 근본 차단)
- 오목·숫자야구: P2P(PeerJS/TURN) 폐기, 티츄처럼 **서버 권위 RPC + RLS + FOR UPDATE + 버전갭 스냅샷**으로 재작성.
- 랜딩: 브랜드 면 기본 + 위장 면(문서 탐색기)을 한 문서 두 표현(body.stealth)으로. 어디서 토글해도 전역 반영(`mw:stealth`).
- 위장 원칙: 시각 구조(엑셀 크롬/셀 톤)가 위장을 전담, 화면 안 텍스트는 일반 게임 용어. 크롬 자체 텍스트(파일명·리본)는 유지.
- 전적: `/stats/` 분리. `v_player_stats`를 GROUPING SETS(게임별+전체)로 재정의, 쿼리 1번으로 4탭.

## 디렉터리
```
/                 랜딩 (브랜드+위장 2표현)
/login/           로그인 (게스트+구글, ?next= + safeNext, mw:pending-nick)
/stats/           통합 전적 (P1)
/tichu/ /omok/ /baseball/
/assets/css/      tokens.css base.css (P1: chrome.css sheet.css)
/assets/js/       supabase.js auth.js prefs.js version.js (P1: chrome.js)
/assets/sql/      (P1에서 tichu/sql 이동) migrations/005~007, tests/
/version.json     { build: N } — 배포 시 이 숫자 하나만 올린다 (탭 갱신 알림용)
/_headers         전 자산 no-cache
```

## DB 마이그레이션 (라이브 티츄를 절대 깨지 않는다 — 전부 default 있는 추가만)
- **005_platform**: `rooms.game_type('tichu'|'omok'|'baseball') default 'tichu'` + `capacity(2|4) default 4` + `settings jsonb`,
  `games.game_type`, `games.rematch_seats smallint[]`, `matches.game_type` + `meta jsonb`.
  `create_room(p_game_type default 'tichu', p_settings default '{}')`로 재정의(**begin/commit으로 drop+create 묶기**),
  `join_room`은 `generate_series(0, capacity-1)`, `start_game`은 capacity 검증 + 딜 분기(case game_type).
  `v_player_stats` → GROUPING SETS((user_id, game_type),(user_id)) + security_invoker.
  2인 게임 매핑: team0=seat0, team1=seat1, score_a/b=세트 승수, rounds_played=판 수 → matches NOT NULL 그대로 재사용.
- **006_baseball**: `bb_rounds(digits 3~5, status setting|playing|finished, turn_seat...)`,
  `bb_secrets`(★RLS on·정책 0개·realtime 추가 금지 — tichu round_secrets 패턴), `bb_guesses`(방 멤버 SELECT — 정보누출 없음).
  RPC: `_bb_evaluate`(evaluate() 8줄 포팅), `set_secret`(자릿수·중복 검증, 양측 완료 시 playing, 선공=1판 랜덤/이후 직전 패자),
  `guess`(FOR UPDATE→턴 검증→서버 판정→4S면 세트 승→target 도달 시 matches 기록), `get_bb_state`(비밀은 내 것도 절대 반환 금지),
  `vote_rematch`(공용). 패리티 테스트: 3자리 720개 순서쌍 518,400개의 `sum(strikes*10+balls)` **체크섬 비교**.
- **007_omok**: `omok_boards(cells smallint[225], black_seat 판마다 교대, win_line...)`, `omok_moves`(기보).
  렌주 판정 plpgsql 포팅(원본 omok/app.js:111-269 → `_ob_run_cells/_ob_check_win/_ob_four_keys/_ob_is_open_four/_ob_open_three_keys/_ob_forbidden_basic/_ob_forbidden`).
  주의: ① plpgsql 배열은 값 타입이라 JS의 mutate 후 복원이 불필요 ② openThreeKeys의 "완성점 0 되돌린 후 basic 검사" 순서 유지
  ③ 인덱스 `idx = r*15+c+1` (1-based) 헬퍼로 가둠. `place_stone`: 금수는 **거부**(턴 미소모), 5완성이 금수보다 우선, 백은 육목 승리.
  패리티: rules.js 추출 → tests.html 랜덤 자가대국으로 벡터 3천~5천 생성(gen-omok-vectors.html) → SQL A파트(고전 25케이스)+B파트(벡터 전량).
  **SQL은 JS와 "같게 틀려야" 한다** — isForbidden은 근사 규칙, 목적은 동치성.

## 단계
- **P0 (완료)**: repo 뼈대 + 공용 모듈 4종 + 랜딩 + 로그인 + 전적 스텁 + 게임 3종 무수정 복사 + _headers + keep-alive 복사 + CF Pages 연결.
  검증: 랜딩 브랜드/위장 토글 왕복, 게스트 로그인→닉네임 스트립, /stats/ 세션 공유·비로그인 리다이렉트(?next=), `?next=//evil.com` → `/` 폴백, JS/CSS 304 확인.
- **P1 (완료 2026-08-18)**: 005 적용(→구 프로토타입 티츄 회귀 확인 필수) + 티츄를 공용 모듈로 이관(net.js/auth.js/스크린auth/크롬/토글/버전체크 삭제, chrome.js+chrome.css 공용화) + /stats/ 구현(4탭+랭킹 5판↑+최근 20건). 검증: 새 도메인 4탭 풀 매치, 전적 반영, GoTrue 중복 경고 없음.
- **P2 (완료 2026-08-18, build 7)**: 006 적용 + /baseball/ 재작성(connect/로비 2좌석/자릿수·선승 설정 동기화, 서버 판정, 월루모드 시트) + update_room_settings 공용 RPC. 검증: 2탭 E2E(2S2B/OUT/정답 판정, 매치 종료 동기화, 전적 반영), 라이브 스모크.
- **P3 (완료 2026-08-18, build 8)**: 007 적용(start_game baseball 분기 병합 포함) + rules.js/tests 37건 + SQL 패리티(A 36 + 자가대국 벡터 3,000) 전건 통과 + /omok/ 재작성(로비/설정/보드/월루 시트/이어하기/재대국). 검증: 2탭 E2E — 삼삼 거부(미리보기+서버+턴 유지), 가로·대각·백 5목, 흑백 교대, 이어하기, 재대국 투표, 전적 반영.
- **P4 (완료 2026-08-18)**: 위장 원칙 통일(P2/P3 신규 클라이언트가 이미 게임 용어), 구 weekly-report 전 경로 리다이렉트 은퇴 + keep-alive 삭제(miniwallu 것이 대체), Supabase Redirect URL 정리(github.io·레거시 localhost 제거, 3건만 유지), 404(#REF!), APPLY_ORDER.md(스냅샷 재생성 대신 적용 순서 문서화 — SQL Editor 재현 절차), 랜딩 결선·모바일(반응형 브레이크포인트 확인).

## 남은 항목 (사용자 작업)
- 구글 로그인: GCP OAuth 클라이언트 생성 후 ID/Secret을 Supabase Google provider에 등록
  (redirect URI = `https://erhsygjsnlbchvfwwodz.supabase.co/auth/v1/callback`)

## 사용자(사람) 작업 체크리스트
- [ ] Cloudflare 계정 → Workers & Pages → Create → Pages → Connect to Git → 이 repo → Framework: None, Build command 비움, Output: `/`
- [ ] Supabase Auth URL: Site URL=`https://<프로젝트>.pages.dev`, Redirect에 `https://<프로젝트>.pages.dev/**`, `https://*.<프로젝트>.pages.dev/**`, `http://localhost:*/**` 추가
- [ ] (구글 로그인) GCP OAuth 클라이언트: redirect URI=`https://erhsygjsnlbchvfwwodz.supabase.co/auth/v1/callback`, JS origin=pages.dev 주소 → ID/Secret을 Supabase Google provider에 입력

## 리스크 메모
- bb_secrets/round_secrets: realtime publication 추가 금지, REPLICA IDENTITY FULL 금지, 라이브 중 DELETE 금지.
- 신규 공개 테이블은 `alter publication supabase_realtime add table ...` 잊지 말 것 (omok_boards, bb_rounds, bb_guesses).
- 오목 벡터 SQL이 커지면 3분할해 SQL Editor에 나눠 붙인다.
