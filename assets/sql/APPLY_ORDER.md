# SQL 적용 순서

새 Supabase 프로젝트에 미니월루천국 DB를 처음부터 재현할 때, SQL Editor에서
아래 순서대로 각 파일 전체를 붙여넣어 1회씩 실행한다. 모든 파일은 단일 트랜잭션
(begin/commit)이라 중간 실패 시 롤백된다.

| 순서 | 파일 | 내용 |
|---|---|---|
| 1 | `schema.sql` | 티츄 기반 초기 스키마: profiles/rooms/room_seats/games/rounds/hands/round_secrets/matches + 티츄 RPC 전체 |
| 2 | `migrations/002_settings_timer.sql` | 방 설정(set_room_settings)·턴 타이머(turn_seconds, _touch_deadline, force_timeout) |
| 3 | `migrations/003_score_modal.sql` | 라운드 점수 상세(_score_round 개편, round_scores) |
| 4 | `migrations/004_open_trick.sql` | 열린 트릭 종료 엣지 케이스 + rooms.status='finished' 관례 |
| 5 | `migrations/005_platform.sql` | 플랫폼화: rooms.game_type/capacity/settings, create_room(game_type), v_player_stats(게임별+all) |
| 6 | `migrations/006_baseball.sql` | 숫자야구: bb_rounds/bb_secrets/bb_guesses, set_secret/bb_guess/bb_next_round/get_bb_state, update_room_settings, start_game(baseball 분기) |
| 7 | `migrations/007_omok.sql` | 오목: omok_boards/omok_moves, 렌주 금수 plpgsql(_ob_*), place_stone/omok_next_board/omok_timeout/get_omok_state, start_game(omok+baseball 분기 병합판) |

적용 후 Dashboard 체크리스트:
- Authentication → Sign In / Up → **Anonymous sign-ins 활성화** (게스트 로그인)
- Authentication → URL Configuration → Site URL과 Redirect URLs를 배포 도메인으로
- (선택) Google provider: GCP OAuth 클라이언트의 ID/Secret 등록
  (redirect URI = `https://<프로젝트>.supabase.co/auth/v1/callback`)

## 검증 (tests/)

- `tests/tichu_tests.sql` — 티츄 `_classify`/`_beats` 등 SQL 단위 테스트. 그대로 실행.
- `tests/omok_rules_tests.sql` — 오목 렌주 판정 JS↔SQL 패리티. A파트(고전 36 assert)는
  그대로 실행되고, B파트는 `tests/gen-omok-vectors.html`을 브라우저로 열어 생성한
  벡터 INSERT를 파일 안 표시된 위치에 붙여넣은 뒤 실행한다(자세한 방법은 파일 주석).
- `omok/tests.html` · `node omok/tests.js` — 같은 판정의 JS쪽 단위 테스트 37건.

## 주의 (운영 불변식)

- 비밀 테이블(`round_secrets`, `bb_secrets`)은 RLS on + 정책 0개가 정상이다.
  realtime publication에 넣지 말고, REPLICA IDENTITY FULL 금지, 라이브 중 행 DELETE 금지.
- 게임 상태 변경은 전부 SECURITY DEFINER RPC 경유 — 클라이언트 직접 쓰기 정책을 추가하지 않는다.
- 새 공개 테이블을 만들면 `alter publication supabase_realtime add table ...`을 잊지 말 것.
