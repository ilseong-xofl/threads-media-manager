# Threads 3개 프로젝트 통합 인수인계

작성 기준: 2026-10-19, 한국 시간. 이 문서는 Claude가 현재 작업을 이어받기 위한 통합 진입점이다. **2026-10-20: 상태 조회 연결 실패의 원인을 확정했다(Meta 응답에 CORS 허용 헤더 없음). 상태 조회 없이 60초씩 기다리는 흐름으로 바꿔 PC 개발 예외에서 이미지 2장 캐러셀 원글과 댓글의 실제 게시를 확인했다. 영상·Android 실기는 미검증이다.** **2026-10-28: 토큰 확인·갱신을 휴대폰에서 PC 프로그램으로 옮기는 코드를 작성했다(아래 2026-10-28 항목). 같은 날 0009와 서버(관리자/API)만 개발 서버에 배포했고, 10-29에 사용자 계정으로 재확인·중복·갱신 실확인을 마쳤다. PC 0.1.8과 모바일은 아직 배포하지 않았다. 이 항목이 아래의 휴대폰 토큰 확인·갱신 설명보다 우선한다.** 코드 보관·커밋·푸시는 장애 해결이나 배포 완료를 의미하지 않는다.

## 2026-10-20 1차 테스트 배포 (기준점)

사용자가 아래 상태를 1차 테스트로 정해 테스터에게 그대로 배포했다.

| 대상 | 버전·소스 | 상태 |
| --- | --- | --- |
| Electron Windows | 0.1.6, 태그 `v0.1.6` = `e5d898e` | 공개 Release, 개발 서버 연결. 사용자가 Windows 업데이트 적용을 확인했다. |
| 관리자/API | `ilseong/threads-admin-api:v0.1.0-dev.20261020.1`, 소스 `783d5ef` | 개발 서버 배포 |
| 모바일 웹 | `ilseong/threads-mobile-web:v0.1.0-dev.20261020.1`, 소스 `3096b30` | 개발 서버 배포, Android 실기에서 이미지 원글·댓글 등록 확인 |

- 이미지 소스 이후 두 저장소의 커밋은 문서만 바꿨다.
- 테스트 중 갱신(2026-10-20): 관리자/API만 `ilseong/threads-admin-api:v0.1.0-dev.20261020.2`(소스 `69e1e9f`)로 올렸다. 계정 연결 탭 제거·사용자별 계정 상세, 사용자 삭제(퇴사), 사용 중지 로그인 문구가 바뀌었다. 사용자가 개발 DB에 `0007_user_deletion`을 적용한 뒤 배포했다. Electron·모바일은 기준점 그대로다.
- 테스트 중 갱신(2026-10-20): Electron을 Windows 0.1.7로 올렸다(17:34 KST 공개, 태그 `v0.1.7` = `9dc7023`). WebP 첨부 전송 실패를 고친 버전이다(아래 항목). 관리자/API·모바일은 그대로다.
- 테스트 중 갱신(2026-10-21): 휴대폰 연결·기기 제한을 없앤 관리자/API `v0.1.0-dev.20261021.1`(소스 `507d6dd`)과 모바일 `v0.1.0-dev.20261021.1`(소스 `241715b`)을 배포했다. 개발 DB에는 0008을 먼저 적용했다(아래 2026-10-21 항목). Electron은 그대로다.
- 테스트 중 갱신(2026-10-27): 모바일만 `v0.1.0-dev.20261027.1`(소스 `ca556d5`)로 올렸다. 오래된 Chrome·삼성 인터넷에서 로그인이 실패하던 문제를 고쳤다(아래 2026-10-27 항목). 관리자/API·Electron은 그대로다.
- 영상 실기는 테스터가 진행한다. 사용자가 오류 내역을 모아 전달하면, 영상이 있을 때 대기를 늘리는 방식으로 대응한다(사전 결정).
- 테스트가 끝나면 운영 주소로 바꿔 운영 배포와 Windows 릴리스를 다시 진행한다.

## 2026-10-28 토큰 확인·갱신 PC 이전 (서버만 배포, PC·모바일 미배포)

- **배경:** 10-28 오전 신규 계정 2개가 휴대폰 최초 접속의 Meta 토큰 갱신에서 "연결 실패"로 끝나 모바일 갱신 잠금에 걸렸고, 토큰 교체를 6번 해도 반복됐다(10-20·10-27에도 같은 패턴). 브라우저는 Meta 오류 응답을 읽지 못해 원인을 확정할 수 없었다. 유력 후보는 발급 24시간 미만 토큰의 갱신 거절이다. 근본 문제는 휴대폰이 만료일을 알려고 갱신을 우회 사용하고 오류가 "연결 실패"로 뭉개지는 것이었다.
- **결정(사용자):** 토큰 확인(`debug_token`)·갱신(`refresh_access_token`)은 PC 프로그램 main 프로세스가 직접 요청하고 휴대폰은 게시만 한다. 서버 Meta 대리 호출 금지는 유지한다. 아래 1장 2번의 "Electron Meta 호출 금지"와 3장 "토큰 정책 — 최종 결정"의 휴대폰 확인·7일 자동 갱신은 이 항목으로 대체한다(구 모바일이 남아 있는 동안은 그 동작이 계속된다).
- **PC(이 저장소, 0.1.8 예정):** `src/main/meta-token-client.ts`가 고정 GET 2개만 보낸다(`/v1.0/debug_token?input_token=T&access_token=T`, `/refresh_access_token?grant_type=th_refresh_token`). 30초 시간 제한, 2MB 응답 제한, `redirect: 'error'`, URL·토큰은 오류에 넣지 않는다. 결과 분류: 성공 / `invalid_token`(190, `is_valid=false`, 만료, 남은 기간 24시간 미만) / `rejected`(코드 10·200은 테스터 초대 수락 안내) / `network` / `not_sent`(DNS 실패·연결 거부) / `timeout` / `bad_response`. HTTP 상태·Meta 코드·하위 코드·유형·메시지(300자, 토큰 가림)·fbtrace_id·네트워크 코드를 화면 오류와 `userData/meta-token-checks.log`(평문 JSON 줄, 토큰 없음, 약 1MB)에 남긴다. 기존 `ThreadsClient`·`desktop-threads.ts`는 비활성 그대로다.
- **흐름:** 모든 Meta 요청 전에 서버와 동기화하고, 남은 간격이 있으면 예약·Meta 요청 없이 거절한다. 그다음 서버에 예약(`POST /api/v1/threads/meta-requests`) → Meta 요청 → 기록 → 실패면 결과 보고(`invalid_token`은 예약부터 5분, `not_sent`는 해제, 그 밖은 10분 유지)다. 성공은 보고하지 않는다.
  - **중복 사전 검사(10-28, 사용자 결정):** Meta 앱 하나에 Threads 계정 하나다. 계정 추가는 Meta 요청 전에, 방금 동기화한 내 계정들과 토큰·Meta 앱 이름·Threads 계정 이름(대소문자·앞뒤 공백 무시)을 비교해 같은 값이 있으면 `DUPLICATE_ACCOUNT`로 바로 거절한다. 토큰 교체는 동기화 뒤 토큰만 비교한다(지금 토큰이면 `SAME_TOKEN`, 내 다른 계정의 토큰이면 `DUPLICATE_ACCOUNT`). 정보 수정은 이 PC 사본의 내 다른 계정과 이름을 비교한다. 어느 경우도 Meta 요청과 요청 간격을 쓰지 않는다. 다른 직원의 계정과는 Meta 확인 뒤 서버의 사용자 ID 고유 검사로만 막는다. 10-19부터 있던 "같은 이름의 두 계정을 따로 등록" 테스트는 새 규칙(두 번째 등록 거절)으로 바꿨다.
  - **등록:** 확인 성공이면 확인 정보(`verification`)와 함께 저장해 서버가 "확인됨"으로 만든다. 토큰이 달라도 같은 Threads 사용자 ID가 내 목록에 있으면 저장하지 않는다. 확인이 실패해도 "확인 필요"로 저장하고(`TOKEN_CHECK_FAILED_SAVED`, 창 닫힘) 행의 토큰 확인 칸에 [재확인]을, 선택 요약에 원인을 둔다.
  - **토큰 교체:** 성공이면 기존 Threads 사용자 ID와 같을 때만 저장한다. 확인된 계정의 새 토큰이 확인에 실패하면 서버를 바꾸지 않는다(`TOKEN_CHECK_FAILED`, 입력 유지, 판단 A). 확인 필요·사용할 수 없음 계정은 실패해도 "확인 필요"로 저장한다.
  - **[재확인]:** "확인 필요" 계정의 토큰 확인 칸에만 나온다(10-28 사용자 결정: 확인됨은 결과가 같고, 사용할 수 없음은 토큰 교체가 해결책). 저장된 같은 토큰을 확인한다. 성공하면 같은 토큰을 `reason: recheck`로 다시 보내 revision이 1 오른다. 실패하면 서버는 그대로다.
  - **[갱신]:** 확인됨이고 만료 14일 이내(만료 전)인 계정만, 한 계정씩 수동으로 한다. 새 토큰을 즉시 이 PC에 보류(`reason: refresh`)로 저장한 뒤 서버로 보낸다. 로컬 저장이 실패해도 전송을 시도해 한 곳에는 남긴다. 서버에 못 보냈으면 [갱신 재시도]로 Meta에 다시 묻지 않고 그 토큰을 보낸다(그사이 서버 토큰이 바뀌었으면 서버를 따른다). 결과가 불명확한 실패는 요청 간격 뒤 [갱신]을 다시 누르고, 그래도 안 되면 토큰을 교체한다. 개발 실행에서만 `TMM_TOKEN_REFRESH_WINDOW_DAYS`(1~60)로 구간을 바꿀 수 있다.
  - 서버의 `ALREADY_REGISTERED`·`ACCOUNT_IDENTITY_MISMATCH`는 로컬 보류를 정리하고, `ACCOUNT_BUSY`(휴대폰 게시 중)는 등록·교체에서는 오류로 끝나고, 갱신에서는 보류로 남아 [갱신 재시도]한다. 확인 정보가 있는 보류는 서버가 "확인됨"이고 만료일이 같을 때만 응답 유실 복구로 완료 처리한다.
  - **서버 먼저(10-28, 사용자 결정):** 계정 추가·토큰 교체·재확인은 Meta 확인 뒤 서버에 먼저 저장하고, 성공해야 이 PC에 반영한다. 통신 오류면 아무것도 남기지 않고 입력 창을 그대로 둔다(다시 저장하려면 Meta 확인부터 다시 하므로 요청 간격이 지나야 한다). 응답만 잃었으면 다음 동기화가 서버 값을 내려받는다. [보류 취소]는 없앴다. 이 PC에만 남는 것은 갱신 토큰뿐이라 [서버 재전송]을 [갱신 재시도]로 바꾸고, 삭제 뒤 세로선으로 떼어 놓았으며, 켜졌을 때만 오른쪽 i 버튼으로 이유를 설명한다. 갱신 재시도가 필요한 계정은 모바일로 보내기에서 고를 수 없다(PC만 막고 서버·모바일은 바꾸지 않음, 1인 1PC 전제). 예전 버전이 남긴 미전송 등록·교체도 [갱신 재시도]로 보내고, 보낼 수 없는 예전 등록은 그때 정리한다.
  - 화면: 열 이름 "토큰 확인"(확인됨/확인 필요/사용할 수 없음)·"만료 일시"(N일 남음/만료됨), 요청 간격 동안 계정 추가·토큰 교체·다시 확인·갱신 버튼은 비활성화하고 "선택 계정" 줄 오른쪽에 "다음 토큰 확인·갱신까지 m:ss" 타이머 하나(추가·교체 창의 저장 버튼 아래에는 "m:ss 후 가능"), 계정 추가 창의 세 칸 이름 옆 흐린 "(중복 불가)", 선택 계정 작업은 정보 수정·토큰 교체·갱신·삭제 | 갱신 재시도(10-28: 상단 [서버와 동기화]는 창을 열 때와 모든 작업 전에 자동으로 동기화하므로 없앴다), 선택 요약의 최근 확인 결과와 [오류 내용 복사], 로그인당 1번 만료·14일 이내 계정 토스트([계정 관리] 버튼). 계정 변경 작업 중에는 로그아웃을 막는다.
- **서버(관리자/API, 먼저 배포):** migration 0009 `desktop_meta_request_gate`, 예약·결과 보고 경로, 목록의 `metaRequest.retryAfterSeconds`, 생성·교체의 `verification`·`reason`, 게시 중 190이면 계정 "사용할 수 없음"(판단 B). 휴대폰 갱신·보고 경로는 구 모바일과 대안용으로 이번에 지우지 않는다.
- **배포 순서:** 서버(하위 호환) → PC 0.1.8 → 테스터 Windows 실확인(막힌 2개 계정 [재확인]) → 모바일 마지막. 서버에 못 보낸 갱신 토큰이 남아 있는 동안 PC를 0.1.7 이하로 되돌리면 계정 보관 파일을 읽지 못한다(파일은 보존).
- **검증(PC):** 가짜 Meta 클라이언트·가짜 서버만 사용해 Vitest 63개 파일 1481개, Python 575개, lint·typecheck를 통과했다. `format:check`는 Git 밖의 로컬 `.claude/settings.local.json` 한 파일 때문에만 실패한다(저장소 파일은 모두 통과). 실제 Meta·실제 서버 요청, 앱 실행, Windows 실기는 하지 않았다. 남는 미검증: 다른 Meta 앱으로 발급한 같은 Threads 계정의 사용자 ID 동일성, Windows에서 PC Meta 호출.
- **실행 확인(로컬 격리, 10-28):** 로컬 Docker PostgreSQL 11.22(`threads_test`, 0000~0009 적용), 실제 환경파일을 뺀 관리자/API 복사본(합성 비밀값), 개발 Electron(`TMM_USER_DATA` 임시, 원격 디버깅으로 조작)으로 확인했다. 로그인 직후 14일 이내 계정 토스트, 열 이름·상태 표시, 계정별 [다시 확인]·[갱신] 사용 조건(5일 남음만 갱신 가능), 서버 간격 8분을 넣었을 때 버튼 잠금과 "m:ss 후 가능" 타이머 감소를 화면으로 확인했다. 사용자 승인으로 가짜 토큰 `debug_token` 요청을 실제 Meta에 1번 보냈다: HTTP 400 · 코드 190 · OAuthException · "Invalid OAuth access token - Cannot parse access token" · fbtrace_id가 선택 요약과 [오류 내용 복사]에 나오고, 서버 간격이 예약부터 300초(5분)로 줄었으며, `meta-token-checks.log`(권한 0600)에 토큰 문자열은 0회였다. 계정은 "확인 필요" 그대로였다(서버 변경 없음).
- **토스트(10-28, 사용자 요청):** PC·모바일 모두 성공·오류 토스트를 30초 뒤 닫고, 오른쪽 위 X로 직접 닫는다. PC 실측 약 29초(1초 간격 측정), 모바일 27초 표시·32초 닫힘. 개발 실행의 폴더 선택 창에서 실제 수집 폴더를 고르면 그 자료를 읽으니 실계정 확인 때 고르지 않는다.
- **앱 연결 확인 열 삭제(10-28, 사용자 결정):** 이 열은 휴대폰 확인 보고에 `reportedAppId`가 있을 때만 "휴대폰 확인 보고 있음"이 되는데, 모바일은 이 값을 보낸 적이 없어 늘 "확인되지 않음"이었다. 이 값으로 판단하는 곳도 없어 PC 계정 표에서 열을 지웠다. 서버·DB의 `appIdVerified`·`appId`와 PC 저장 형식은 0.1.7 호환을 위해 그대로 두고, 서버의 휴대폰 확인·갱신 경로를 지울 때 함께 정리한다(앱 이름 칸의 `App ID` 보조 표시도 같은 값이라 지금은 나타나지 않는다).
- **배포(서버, 2026-10-28):** 사용자 지시로 로컬 CLI에서 개발 DB에 0009를 적용했다(적용 9개·대기 1개 → 10개·0개). 관리자/API `v0.1.0-dev.20261028.1`(소스 `330b79e`, linux/amd64, `sha256:9708f694e2e31c5dde47f7a545a993fd43512cba0d319d7c9a6a71b7e84d2bdd`)은 이미지 안에 환경·키 파일과 실제 비밀값이 없음을 확인한 뒤 Docker Hub에 올렸고, 사용자가 개발 서버에 배포했다. 배포 뒤 공개 HTTPS로 health 200, 새 요청 간격 경로가 있음(403 출처 확인, 없는 경로는 404), 구 모바일용 갱신 경로 유지, 지운 연결 경로 404를 확인했다. 세 저장소의 커밋은 `feat/pc-token-check` 브랜치로 push했고 main에는 병합하지 않았다. 다음 순서: 사용자 계정 실확인(단계마다 승인) → PC 0.1.8 → 테스터 Windows 확인 → 모바일.
- **사용자 계정 실확인(10-28~29, 개발 서버, macOS 개발 실행, 사용자 계정 `seunghun6235`):** 1단계 [재확인]으로 `debug_token`의 사용자 ID가 서버에 저장된 ID(옛 모바일 `/me` 값)와 같음을 확인했다(revision 2→3). 2단계에서 사용자가 이름 중복이 Meta 요청 없이 막히는 것을 확인했고, 다른 이름과 처음 발급한 토큰으로 등록하자 Meta 사용자 ID로 중복이 막혔다(저장 없음). 서버 토큰은 10-19 22:08에 옛 모바일이 갱신한 다른 문자열이라 토큰 글자 비교에는 걸리지 않았다. 처음 발급한 토큰은 갱신 9일 뒤에도 갱신된 만료일로 유효했다(갱신해도 이전 토큰이 무효가 되지 않는 것으로 보임, 1회 관찰). `debug_token`도 Meta 요청이라 10분 간격을 그대로 둔다(사용자 결정). 3단계 [갱신]은 성공해 만료가 12-18 22:08 → 12-28 00:48, revision 3→4가 됐고 보류 없이 서버에 저장됐다. 새 타이머가 선택 계정 줄 오른쪽에 하나만 뜨는 것도 실제 창에서 확인했다. 확인 기록 파일(3줄)에 토큰 문자열은 없다. 이 실확인 중 사용자 결정으로 계정 관리 화면과 저장 순서를 바꿨다(위 중복 사전 검사·서버 먼저·화면 항목). 다음: PC 0.1.8 → 테스터 Windows 확인 → 모바일.

## 2026-10-27 오래된 Chrome·삼성 인터넷 지원 (모바일)

- **증상(사용자 보고):** 같은 계정으로 휴대폰 3대에 로그인하면 1대(갤럭시 A12)만 "서버에 연결하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요."로 실패했다. 기기·세션 수 제한은 서버와 모바일 어디에도 없다. 로그인 제한은 IP당 분당 `LOGIN_RATE_LIMIT_PER_MINUTE`와 아이디당 15분 실패 10회뿐이다.
- **원인:** 업데이트하지 않은 브라우저에 `AbortSignal.timeout`(Chrome 103·삼성 인터넷 20)이 없어 요청을 보내기 전에 예외가 났고, `api.ts`가 이를 연결 실패로 보였다. A12에서 Chrome을 업데이트하자 로그인돼 확정했다. 마케팅팀 휴대폰에 오래된 삼성 인터넷이 많아 코드로 보완했다(사용자 결정).
- **수정(모바일만):** `src/compat.ts`에 `AbortSignal.timeout`·`crypto.randomUUID` 대체를 두고 빌드 대상을 `chrome71`(삼성 인터넷 10)로 낮췄다(나머지는 Vite 기본값). 상세 창 높이에 `vh` 대체값을 넣었다. 오래된 브라우저에는 모두 같은 "Chrome 업데이트" 안내를 보인다(사용자 결정).

| 브라우저 | 동작 |
| --- | --- |
| 삼성 인터넷 20+ · Chrome 103+ | 그대로 동작, 안내 없음 |
| 삼성 인터넷 10~19 · Chrome 71~102 | 대체 코드로 동작, 열 때마다 업데이트 토스트 |
| 삼성 인터넷 9 · Chrome 66~70 | 화면·토스트는 뜨지만 Web Locks가 없어 등록 불가(로그인 후 기존 잠금 안내) |
| 삼성 인터넷 8 이하 | 앱이 시작하지 못해 4초 뒤 `index.html` 고정 안내문 |

- **검증:** 모바일 93개와 정적 배포 검사 13개, 수정 전 실패하던 재현 테스트, 대체 UUID 1만 개의 `z.uuid()` 통과, 빌드본 iframe 흉내, 로컬 격리 서버에서 기능을 지운 Chrome 로그인. 상세는 모바일 `docs/verification.md`의 2026-10-27 항목이다.
- **배포(2026-10-27):** `ilseong/threads-mobile-web:v0.1.0-dev.20261027.1`(소스 `ca556d5`, linux/amd64, `sha256:a136015b72dfc2688f51305a09bed3260f69d44797995653d71a41c980039b92`)을 Docker Hub에 올렸고 사용자가 개발 서버에 배포했다. 공개 HTTPS로 새 번들을 확인했다. 실기(사용자 보고): 갤럭시 A12의 삼성 인터넷에서 로그인과 원글·댓글 등록을 확인했다(버전은 기록하지 않음). 같은 폰의 Chrome은 최신으로 업데이트하면 수정 전에도 동작했다.
- **남은 차이:** 삼성 인터넷 14 이하는 카드 미디어가 정사각형이 아니고, 13 이하는 요소 간격, 11 이하는 좌우 여백·배경 흐림이 빠진다. Chrome 98 미만에서 Meta 시간 초과는 "응답을 받지 못했습니다"로 보인다(결과 불명 처리는 같다). iOS 16 미만 iPhone에도 Chrome 업데이트 문구가 뜨지만 iPhone은 iOS를 업데이트해야 한다.
- **로컬 테스트:** 관리자/API의 실제 `.env.development.local`은 AWS 개발 DB를 가리키므로 원본 폴더에서 `pnpm dev`를 띄우지 않는다. `git archive` 복사본과 합성 비밀값, Docker `postgres:11.22-alpine`의 `threads_test`로 띄운다.

## 2026-10-21 휴대폰 연결 제한 삭제 (코드 수정, 미배포)

- **결정(사용자):** "휴대폰 한 대 = Threads 계정 하나, 계정 하나 = 휴대폰 한 대" 연결을 없앴다. 계정 수 제한도 두지 않는다. 같은 계정을 여러 휴대폰에서 쓰는 것도 막지 않는다.
- **모바일:** 로그인 뒤 연결 화면을 없앴다. 계정 박스 위 셀렉트 박스에서 계정을 고른다(등록이 오래된 순서, 로그인 직후 첫 계정, 재연결 때는 보던 계정 유지). 고른 계정만 토큰 만료 확인과 등록 대기·완료 조회를 한다. 등록본의 계정은 PC에서 보낼 때 정해지므로 원글 등록 때 계정을 고르지 않는다.
- **관리자/API:** 휴대폰 연결 API(`/api/v1/threads/mobile/bindings`, `/attach`, 관리자 `/api/v1/admin/bindings/:id`)와 관리자 화면의 연결 칸·`연결 해제`를 삭제했다. 모바일 목록은 `accountId`를 받고, 나머지는 등록본·실행 기록의 계정을 쓴다. 계정 삭제는 휴대폰 세션을 지우지 않는다. `0008_mobile_account_selection.sql`은 `mobile_publish_attempt.binding_id` NOT NULL 해제 한 줄이다.
- **기기 제한 삭제(같은 날 추가 결정):** 모바일 웹의 Android 전용 조건도 없앴다. 이제 HTTPS로 접속해 화면을 연 브라우저면 휴대폰·PC 구분 없이 토큰 확인·갱신과 원글·댓글 등록을 직접 보낸다(로컬 http 개발 서버는 `pnpm dev:desktop-meta`로 명시할 때만). 서버에는 원래 기기 검사가 없다.
- **Electron:** 기능 수정 없음. "토큰과 휴대폰 연결은 그대로입니다" 같은 문구 두 곳(`use-managed-threads.ts`, `ManagedThreadsAccountSettings.tsx`)은 다음 Windows 릴리스 때 고친다.
- **검증:** 관리자/API Vitest 192개(격리 PostgreSQL 11.22), HTTP 통합 84개, 빌드·타입·린트. 모바일 84개, 정적 배포 검사 13개, 합성 미리보기와 격리 서버 화면 확인. 실제 계정·Meta·Android 실기는 하지 않았다. 상세는 각 저장소 `docs/verification.md`의 2026-10-21 항목이다.
- **배포(2026-10-21):** 사용자 승인으로 로컬 CLI에서 개발 DB에 0008을 적용하고(적용 9개·대기 0개), 이미지 두 개를 Docker Hub에 올렸다. 관리자/API `sha256:cb466e44c80158780f8036860ea0727f5e1abf53f45b910891d42bb1d8a6ad59`, 모바일 `sha256:be9bf01ef3d4479c9500e2240603506123ddfd6866bf195dd24cc39b3074faf2`, 둘 다 linux/amd64다. 사용자가 관리자/API → 모바일 순서로 개발 서버에 배포했다. 배포 뒤 공개 HTTPS로 관리자 health 200, 지운 연결 경로 404, 모바일 번들의 새 코드를 확인했다. 실제 계정·Android·PC 브라우저 등록은 아직 확인하지 않았다. 이 Mac은 Docker Desktop의 현재 context가 `desktop-linux`라 빌드 스크립트를 `DOCKER_CONTEXT=default`로 실행해야 한다.

## 2026-10-20 WebP 첨부 전송 실패 수정 (Windows 0.1.7)

- **증상:** 테스터가 Threads 계정 3개를 등록한 뒤 PC의 `모바일로 보내기`를 누르자 "게시 대기 전송 상태를 확인하지 못했습니다. 기존 자료는 보존했습니다."가 떴다. 이 문구는 `mobile-publications.ts`의 `safeProblem`이 분류되지 않은 예외를 덮는 포괄 메시지이고, 원래 오류는 기록되지 않는다.
- **원인:** WebP 첨부였다. Electron 43.3.0의 `nativeImage.createFromBuffer`는 PNG·JPEG만 읽기 때문에 WebP에서는 빈 이미지를 돌려주고, 전송 준비가 `Error('Invalid upload image')`로 끝났다. 테스터의 등록 글 ZIP(영상 1개, WebP 이미지 1개)으로 확인했다. 계정 수와 계정 이름의 `_`·`.`은 원인이 아니다. 3계정 합성 재현에서 세 계정 모두 정상 전송됐다.
- **수정:** WebP→PNG 변환을 앱에 포함된 Python Pillow 작업 파일 `local-runtime/convert_upload_image.py`로 옮겼다(`src/main/webp-png.ts`). 변환에 실패하면 구체적인 이미지 오류를 보여 준다. 테스터 파일로 실제 준비 경로를 실행해 원본과 픽셀이 같은 PNG가 나오는 것을 확인했다. 서버·모바일·DB 변경은 없다.
- **배포:** 2026-10-20 17:34 KST에 [0.1.7 Release](https://github.com/ilseong-xofl/threads-media-manager/releases/tag/v0.1.7)를 공개했다(기록: Electron `docs/windows-validation.md`). 접속 서버는 개발 서버 그대로다. Electron 피드가 0.1.6 설치 앱에 0.1.7을 안내하는 것까지 확인했다.
- **다음으로 미룸(사용자 결정):** 포괄 오류의 원인 표시, 전송할 때 선택한 계정만 검사. PC·모바일 로그인의 사용 중지 문구 표시는 2026-10-21 폐기했다(사용자 결정). 개발 실행 전용 AI 이미지 생성 결과 검사(`ContentGenerator`)도 `nativeImage`를 쓰므로 WebP를 읽지 못한다.
- **미검증:** Windows 설치 앱에서 업데이트한 뒤 WebP 글을 전송하는 것은 테스터 확인이 필요하다.

## 2026-10-20 원인 확정과 등록 흐름 변경

- **원인:** Meta는 유효한 토큰으로 조회한 컨테이너 상태(`GET /v1.0/{container-id}`) 응답에 `Access-Control-Allow-Origin`을 보내지 않는다. 정식 Chrome 155 콘솔 원문 이유는 `No 'Access-Control-Allow-Origin' header is present on the requested resource.`이다. 같은 실행의 자식 컨테이너 생성 POST는 HTTP 200으로 읽혔고, 상태 GET은 328ms 만에 왕복한 뒤 `TypeError`(Resource Timing 상태 0)로 끝났다. Electron은 Node라 CORS 검사가 없어서 같은 요청이 성공했다. 요청 코드·localhost·이미지 링크·캡션 문제가 아니다. 측정 표는 모바일 `docs/direct-publishing.md`의 2026-10-20 항목에 있다.
- **흐름 변경(사용자 결정):** 브라우저에서 상태와 게시 링크를 조회하지 않는다. 자식 컨테이너 생성 → 60초 → 캐러셀/단일 컨테이너 생성 → 60초 → 게시 순서다. 댓글도 컨테이너 생성 60초 뒤 등록한다. 결과 확인 버튼은 휴대폰 영수증만 서버에 저장한다.
- **코드:**
  - 모바일 `src/publisher.ts`·`meta.ts`·`api.ts`·`App.tsx`와 테스트를 수정했다.
  - 관리자/API `src/server/mobile/service.ts`는 상태 보고 없이 컨테이너가 생성된 시도(`preparing`/`ready`)에 게시 실행권을 준다. 통합 테스트 1건을 추가했다.
  - Electron은 예전 PC 게시 이력의 Threads 링크 열기 버튼과 IPC를 제거했다. 게시 ID는 일반 글자로 표시하고, `threads-publishing.ts`의 링크 열기 메서드는 보존 원칙에 따라 호출 없이 남겼다.
- **실제 확인(2026-10-20 00:27~00:30 KST, 개발 계정):** 두 번째 자식 생성, 캐러셀 생성(이미지 2장 + 캡션), `threads_publish`가 모두 HTTP 200으로 읽혔고 사용자가 Threads에서 게시를 확인했다. 게시 후 링크 조회는 같은 CORS 이유로 차단되어 제거했다.
- **검증:** 모바일 80개, 정적 검사 13개, 관리자/API 177개(격리 PostgreSQL 11.22), Electron 60개 파일 / 1,395개 테스트와 각 타입·린트 통과.
- **미검증·후속:**
  - 영상: 처리가 60초보다 길 수 있고, '처리 중' 거절 코드가 아직 관측되지 않았다. 자동 재시도 규칙은 그 코드를 본 뒤 정한다.
  - 댓글 실게시: 2026-10-20 PC 개발 예외에서 확인했다(PC에서 저장한 댓글 동기화 → 모바일 웹 등록 → Threads 실제 댓글). Android 실기는 미검증이다.
  - Android 실기: 2026-10-20 `v0.1.0-dev.20261020.1`을 개발 서버에 배포한 뒤 Android Chrome에서 이미지 원글과 댓글 등록을 확인했다(사용자 보고). Android 영상은 미검증이다. 영상은 지금 60초 대기를 유지하고, 테스트 사용자가 영상 오류를 보고하면 영상이 있을 때 대기를 늘린다(사용자 결정).
  - 코드 리뷰 지적 14건은 반영했다(관리자/API `docs/mobile-publishing.md`의 2026-10-20 코드 리뷰 반영 항목). 관리자/API 19개 파일 / 185개, 모바일 82개 테스트 통과. `tests/http-integration.mjs`의 본문 없는 DELETE와 모바일 `App.tsx` 화면 흐름은 자동 검증하지 못했다.
  - 이어서 모바일 등록 완료 탭은 전송 후 7일 동안 원글 완료 글을 댓글 상태와 관계없이 표시하고(댓글이 등록되면 `댓글 완료` 뱃지), Electron 등록 카드의 `등록 완료`·`댓글 완료` 뱃지를 서버 `GET /api/v1/publications/statuses`(초안별 집계)로 복원했다. 관리자/API 186개 테스트 통과.
  - 이어서 PC에서 댓글을 저장하면 보낸 등록본에도 자동 반영한다(서버 먼저, 휴대폰이 그 댓글 게시를 시작하면 잠금). 계약은 Electron `docs/mobile-publication-delivery.md`의 2026-10-20 댓글 동기화 항목. 관리자/API를 먼저 배포해야 한다.
  - Windows 0.1.6: 서비스 로그인이 들어간 첫 Windows 버전이다. 테스트 단계라 접속 서버는 개발 서버로 정했고(사용자 결정, 테스트 완료 후 운영 주소로 바꿔 운영 배포), 저장소 변수 `THREADS_ADMIN_API_URL`을 `https://threads-admin-dev.ilscp.net`으로 설정했다. 2026-10-20 10:58 KST에 [0.1.6 Release](https://github.com/ilseong-xofl/threads-media-manager/releases/tag/v0.1.6)를 공개했다(기록: Electron `docs/windows-validation.md`). 서버 주소가 없는 빌드는 `release-windows.yml`이 게시를 거절한다(Electron `docs/windows-release.md`의 서비스 주소 항목). 업데이트 후에는 PC 직접 게시가 중단되고 휴대폰 게시만 쓴다.
  - 문제가 생기면 Android 앱의 네이티브 통신 전환을 검토한다.
- 이 변경은 아직 커밋하지 않았다.

## 후속 수정: 막힌 등록 작업의 명시적 삭제

사용자가 결과 불명 때문에 관리자 연결 해제·계정 삭제·로컬 회수가 모두 막히는 문제를 제보하여 아래 복구 경로를 추가했다. 이 항목이 이전의 무조건 삭제 차단 정책을 대체한다.

- Electron에 `등록 작업 삭제`와 별도 경고 확인창을 추가했다. 진행 중/결과 불명 작업과 원글 완료·댓글 미완료 작업을 서비스에서 종료한다. 로컬 원본·미디어와 원격 ID·실행/완료 이력은 보존한다.
- 관리자 연결 해제는 경고 확인 후 미해결 작업만 종료하고 연결·세션을 해제한다. 아직 시작하지 않은 대기 글과 토큰은 유지한다. 이미 해제된 연결의 반복 요청은 새 휴대폰의 작업을 변경하지 않는다.
- 담당자의 계정 삭제는 경고 확인 후 미완료 작업을 종료하고 토큰·연결을 폐기한다. 실제 Threads 계정·게시글은 삭제하지 않는다.
- 기존 `cancelled_at`과 snapshot `cancelled`를 사용한다. `sending` 결과는 `unknown`으로 보존하며, 명시적 종료를 성공 등록이나 Meta 요청 취소로 표시하지 않는다. 새 DB migration은 없다.
- 삭제된 작업의 시작·intent·상태 보고를 차단한다. 늦은 결과 영수증은 저장한 뒤 `closed: true`로 다음 실행을 중단한다(2026-10-20 리뷰 반영 전 `.4` 서버는 409 `PUBLICATION_CLOSED_RECEIPT_SAVED`, 새 모바일은 둘 다 처리). 연결 해제·계정 삭제 뒤의 늦은 영수증은 같은 사용자의 휴대폰 로그인에서 `/api/v1/mobile/receipts`로 저장한다. 모바일은 60초 대기 후 다음 Meta 요청 직전에 실행권(intent)을 받으며, 이때 서버가 작업이 여전히 열려 있는지 확인한다(2026-10-20 상태 조회 제거 후 기준).
- 검증: 격리 PostgreSQL 11.22 관리자/API 176개, Electron 관련 89개, 모바일 전체 85개 검사 통과. 타입·린트 및 관리자/API와 모바일 Linux/amd64 Docker 빌드 통과. 합성 화면에서 삭제 확인·취소·승인·원격 결과 미확인 표시를 확인했다. 실제 사용자 작업 삭제·외부 DB 변경·Meta 호출은 하지 않았다.
- 사용자 승인 후 `ilseong/threads-admin-api:v0.1.0-dev.20261019.4`, `ilseong/threads-mobile-web:v0.1.0-dev.20261019.4`를 Docker Hub에 업로드했다. digest는 각각 `sha256:1e4eeceac79708cfdf066a7c01548b51b6b0fe629917ef99edc29fbf6cec64f3`, `sha256:a3846a3db52c4fc75aab20a383c86a40304af1ddf12219664780f035dc6d91f4`다. 이후 사용자가 관리자/API `.4`의 개발 서버 배포를 통보했다. 모바일 `.4`의 배포 완료 통보는 없다. 관리자/API를 먼저 갱신해야 새 삭제 요청이 동작한다. 등록 연결 실패 원인은 2026-10-20에 확정했다(위 항목).
- 검증용 PostgreSQL 컨테이너와 합성 화면은 종료했다. 로컬 모바일 웹 4196은 `VITE_ALLOW_DESKTOP_META_TEST=false`로 다시 실행해 PC의 실제 Meta 요청을 차단한다. 이번 후속 수정은 아직 Git 커밋·푸시하지 않았다.

## 1. 먼저 지킬 사항

1. 실제 계정의 Meta 호출·등록·토큰 갱신은 사용자가 범위를 승인한 테스트에서만 실행한다. 승인은 그 테스트 범위에 한정하며 다음 실행의 포괄 승인으로 재사용하지 않는다.
2. 오류를 해결하기 위해 서버 프록시, Electron 게시 호출, `no-cors`, 자동 재등록으로 우회하지 않는다. Meta 게시 요청은 원칙적으로 사용자 브라우저의 모바일 웹에서 직접 나가야 한다(2026-10-21부터 PC 브라우저도 허용). 2026-10-28부터 토큰 확인(`debug_token`)·갱신만 PC 프로그램 main이 직접 요청한다(위 항목). 브라우저가 읽을 수 없는 Meta 응답(컨테이너 상태·게시 링크)은 조회하지 않는다.
3. 기존 실제 컨테이너 ID, 실행 시도, 미저장 영수증, 토큰 revision을 보존한다. 사용자가 확인창에서 승인한 작업 종료·연결 해제·계정 삭제는 허용하되 원격 결과와 실행 흔적을 없애거나 자동 재등록하지 않는다.
4. `marketo-sync`, `local-video-manager`, `local-video-manager-service`는 읽기 전용 참고 프로젝트다. 코드·설정·DB·배포를 수정하거나 런타임 의존성을 만들지 않는다. Lambda는 사용하지 않는다.
5. AWS 서버에 SSH/SCP/SFTP/SSM/원격 Docker로 접속하지 않는다. 외부 DB 관리·AWS 배포·S3 설정은 사용자가 실행한다. 비밀번호·토큰·서명 URL·환경파일 내용을 채팅이나 로그로 출력하지 않는다.
6. 오래된 문서에는 단일 계정, PC 게시, 통계, 파일 서버, Prisma/Fastify, 2일 기한, 중지·이관, 체크박스, 수동 갱신 버튼이 남아 있다. **이 문서의 최신 결정과 현재 코드가 우선**한다. 과거 성공 기록을 현재 모바일 성공으로 바꾸어 말하지 않는다.

## 2. 프로젝트와 코드 보관 위치

| 역할 | 로컬 경로 | GitHub / 인수인계 브랜치 |
| --- | --- | --- |
| 사용자 Electron 앱 | `/Users/xofl/IdeaProjects/threads-media-manager` | `ilseong-xofl/threads-media-manager` / `codex/phase-2-registration` |
| 관리자 웹 + 중앙 API | `/Users/xofl/IdeaProjects/threads-admin-api` | `ilseong-xofl/threads-admin-api` / `main` |
| 사용자 모바일 웹 | `/Users/xofl/IdeaProjects/threads-mobile-web` | `ilseong-xofl/threads-mobile-web` / `main` |

새 등록 흐름의 실행 프로젝트는 위 세 개다. `threads-file-server`는 과거 파일 전송 구현이며 신규 경로에서 사용하지 않는다. `threads-collector`는 기존 수집 플러그인의 별도 배포 저장소이고 이번 모바일 등록 런타임을 담당하지 않는다.

Electron은 자동 업데이트 때문에 기존 공개 저장소를 유지한다. 새 관리자/API·모바일 저장소는 비공개로 보관한다. 인수인계 직전 Electron HEAD는 `eca8d6f`, 브랜치는 `codex/phase-2-registration`이었다. 관리자/API와 모바일은 Git 저장소가 없었으며 이번 보관 작업에서 초기화했다. 정확한 인수인계 커밋은 각 저장소의 `git log -1`을 확인한다.

실제 `.env*`, DB·사용자 미디어·토큰·OS 보안 저장소, `node_modules`, 빌드 출력, 배포 압축, 로컬 `artifacts/`는 Git 보관 대상이 아니다. `.env.example`, `.env.dev.example`, `.env.prod.example`는 빈 값/예시만 포함한다. Electron `artifacts/threads-guides-site/`는 별도의 중첩 저장소이므로 세 프로젝트의 소스로 추가하지 않는다.

## 3. 확정된 제품 정책

### 로그인·권한·계정

- 관리자가 서비스 아이디·비밀번호를 발급한다. Electron과 모바일은 같은 직원 계정으로 중앙 API에 로그인한다. 공개 회원가입·이메일 인증·Meta 소셜 로그인은 없다.
- 관리자는 직원 생성·사용 중지·비밀번호 초기화와 처리 상태를 관리한다. 직원의 본문·댓글·미디어·Meta 토큰은 열람하지 않는다.
- Electron은 인터넷/API 접근 확인 실패 시 자료 열람·편집도 잠근다. 초기의 오프라인 허용 결정은 폐기되었다. 로컬 자료 자체는 보존한다.
- 각 직원은 본인의 Facebook 개발자 계정 아래에서 Threads 계정별로 Meta 앱을 나눈다. 회사 전체 공용 개발자 계정이 아니다. 이 구조가 Meta 제재를 방지한다고 보장하지 않는다.
- 계정 입력 순서는 **Meta 앱 이름 → Threads 계정 이름 → 수동 발급 장기 토큰**이다. 숫자 App ID는 필수 입력이 아니다. 표시 이름과 실제 `/me` 계정 ID를 혼동하지 않는다.
- 계정별 **중지·재개·직원 간 이관은 모두 폐기**했다. 추가·토큰 교체·동기화·삭제만 제공한다. 관리자에 의한 서비스 사용자 중지는 별도 기능으로 유지한다.
- 삭제는 경고 확인창 후 미완료 작업을 종료하고 서버 credential을 폐기한다(2026-10-21부터 휴대폰 로그인은 유지). 진행 중/결과 불명 결과는 미확인 이력으로 남기며 실제 Threads 계정·글과 완료 이력은 보존한다. 재등록은 새 장기 토큰으로 시작한다.
- 2026-10-21부터 휴대폰과 계정의 연결 제한이 없다(위 2026-10-21 항목). 휴대폰은 로그인한 직원의 모든 계정을 셀렉트 박스로 골라 쓰고, 관리자 연결 해제는 없다. 모바일 웹은 기기를 검사하지 않으며(PC 브라우저 허용) 물리 휴대폰이나 모바일 데이터 사용을 증명하지 않는다.

### 등록·목록·보관

- 수집·다운로드·편집·직접 작성·캡션·댓글 준비는 Electron에 남긴다. 직접 작성 자료의 구분과 외부 원본 보존 정책을 유지한다.
- `모바일로 보내기`는 선택한 **계정 하나**에 불변 등록본을 준비하는 동작이다. 실제 Threads 등록이 아니다. 계정은 오래된 등록순, 첫 계정 기본 선택, 계정이 없으면 버튼 비활성화다.
- 전송 중/등록 대기/전송 보류가 남으면 새 보내기를 막는다. 시작 전에는 회수 → 수정 → 재전송한다. 로컬 등록 삭제는 미시작 대기 취소 성공 후 진행한다.
- 새 등록본 기한은 서버 전송 확정 `sentAt`부터 168시간(7일). 기존 48시간 등록본을 조회나 migration으로 늘리지 않는다. S3 Lifecycle 7일은 사용자가 설정하며 실제 객체 삭제 시점과 앱 기한은 구분한다.
- 모바일은 내용 수정 없이 확인·등록만 한다. 원글과 준비된 댓글은 **별도 버튼/별도 실행**이다. 회사 전체 유사·중복 콘텐츠 검사로 전송을 차단하지 않는다.
- 화면 용어는 **등록 대기 / 등록 완료**다. 둘 다 이미지·영상 캐러셀과 최신순 cursor 목록을 사용한다. 완료 탭은 **전송 후 7일 이내 + 원글 완료 + 댓글 작업이 남은 항목만** 표시한다. 원글 등록 시각 최신순, 20개 단위 무한 스크롤이다.
- 댓글 완료/없음/취소 또는 기간 초과 항목은 모바일 목록에서 숨기며 DB 이력은 보존한다. 전체 이력은 로컬 조회용이다. 전환 전 PC 게시 이력을 모바일로 이관하지 않는다.
- 통계 기능은 PC·모바일에서 중단한다. 과거 구현·게시 이력은 삭제하지 않는다.

### 토큰 정책 — 최종 결정

- **2026-10-28 대체:** 아래 휴대폰 확인·7일 자동 갱신은 맨 위 2026-10-28 항목(PC 확인·14일 수동 갱신)으로 대체한다. 새 모바일 배포 전까지 구 모바일의 동작 기록으로 남긴다.
- PC 입력·DB 저장 성공은 Meta 검증 성공이 아니다. PC에서 토큰을 확인하거나 갱신하지 않는다. 수동 토큰 문자열에 만료일이 없다고 등록일+60일을 임의 저장하지 않는다.
- 최초 연결에서 만료 정보가 없으면 브라우저의 `/me` 확인과 직접 갱신 1회로 실제 `expires_in`을 얻어 서버에 저장한다. 이후 같은 revision의 유효성·계정 ID·만료일을 재사용한다.
- **만료까지 7일 초과면 Meta 확인·갱신 요청 0회.** 만료 전 7일 이내만 자동 갱신한다. 이미 만료/무효인 토큰은 새 장기 토큰 등록을 안내한다.
- 로그인·접속·새로고침·온라인/포커스 복귀·계정 선택 시 선택한 계정만 서버 메타데이터를 읽고 조건에 맞을 때만 준비한다. 원글/댓글 직전에 별도 `/me`나 갱신을 반복하지 않는다.
- 모바일 데이터 동의 체크박스, 수동 토큰 확인·갱신 버튼, 정상 갱신 성공 알림은 제거했다. 상태와 만료일은 계정 카드 오른쪽 두 줄로 표시한다.
- 갱신 후 서버 저장 실패는 같은 메모리 결과만 다시 저장한다. 응답 불명 갱신은 revision latch로 반복 호출을 막는다. 코드 190과 네트워크 오류를 같은 토큰 만료로 표시하지 않는다.

## 4. 네트워크·비밀정보 경계

```text
Electron ── 로그인 / 계정 / 스냅샷 / 서명 요청 ──> 관리자/API ──> PostgreSQL
Electron ── 서명된 PUT, 이미지·영상 바이트 ─────> S3
관리자/API ── HEAD·체크섬 확인·S3 내부 CopyObject ─> S3

모바일 브라우저 ── 로그인 / 조회 / 결과 저장 ───────> 관리자/API
모바일 브라우저 ── 생성 / 등록 (구 모바일: 토큰 확인·갱신) ─> graph.threads.com
Electron main ── 토큰 확인(debug_token)·갱신 (2026-10-28) ──> graph.threads.com
모바일 브라우저 ── 서명된 GET 미디어 미리보기 ─────> S3
Meta ── 전달받은 미디어 URL 읽기 ────────────────> S3
```

서버에 미디어 바이트 업로드 API나 Meta proxy/server action을 만들지 않는다. S3는 서버가 짧은 서명 URL만 발급하고 PC가 직접 업로드한다. 객체는 `threads/dev/`와 `threads/prod/`의 `staging/`·`published/`로 분리하며 버킷 전체 공개 정책을 요구하지 않는다.

Better Auth secret과 Meta 암호화 마스터키는 다르다. DB credential은 AES-256-GCM으로 암호화하고 Electron 사본은 OS `safeStorage`로 보관한다. 모바일의 Meta 토큰과 S3 서명 URL은 메모리에만 둔다. 서비스 세션은 sessionStorage, 계정별 비민감 실행 영수증과 갱신 잠금 번호는 localStorage를 사용한다. 브라우저 저장소를 무조건 삭제하면 복구 기록이 유실될 수 있다.

## 5. 프로젝트별 주요 코드

아래 파일 경로는 각 프로젝트 루트 기준이다.

### Electron — `threads-media-manager`

| 파일 | 역할 |
| --- | --- |
| `src/main/index.ts` | 인증/IPC 연결, 계정·전송 서비스 구성, 기존 PC 게시·통계 Meta 실행 차단 |
| `src/main/service-api.ts`, `service-access.ts`, `auth-token-store.ts` | 중앙 서비스 로그인·접근 검사, main 전용 Bearer/암호화 |
| `src/main/managed-threads.ts`, `managed-threads-store.ts`, `managed-threads-ipc.ts` | 다중 계정 등록·교체·삭제, 암호화 보류·서버 동기화 |
| `src/main/desktop-threads.ts` | 기존 데스크톱 Meta 기능 중단 경계 |
| `src/main/meta-token-client.ts`, `meta-token-log.ts` | 2026-10-28 계정 토큰 확인·갱신 전용 Meta 요청, 토큰 없는 확인 기록 |
| `src/main/mobile-publications.ts`, `mobile-publication-data.ts` | 등록본 구성·전송·완료·회수, 원문 revision 보호 |
| `src/main/publication-outbox.ts`, `publication-s3-upload.ts`, `publication-work-gate.ts` | 암호화 전송 의도, 직접 S3 PUT, 진행 중 수정·종료 보호 |
| `src/renderer/AuthenticationGate.tsx`, `AppAccountMenu.tsx` | 로그인 잠금·닉네임/메뉴 |
| `src/renderer/AccountManagementModal.tsx`, `ManagedThreadsAccountSettings.tsx`, `ManagedThreadsActionDialog.tsx` | 계정 테이블과 별도 추가·교체·삭제 모달 |
| `src/renderer/MobilePublicationPanel.tsx`, `use-mobile-publications.ts`, `PostRegistrationModal.tsx` | 모바일 전송·상태·회수 UI |
| `src/shared/service-auth.ts`, `managed-threads.ts`, `mobile-publications.ts` | renderer/main 계약 |
| `src/main/threads-client.ts`, `threads-publishing.ts` | **과거 실제 성공한 Meta 요청·게시 순서 비교 기준**. 신규 PC 호출을 켜기 위한 파일이 아님 |

기존 게시·통계 코드를 삭제하지 않고 새 실행 경로에서 막았다. 2026-10-20 예전 PC 게시 이력의 Threads 링크 열기 버튼과 IPC는 제거했다(게시 ID는 일반 글자로 표시). `local-runtime/`은 기존 SQLite·미디어·등록/댓글 자료를 소유한다. 공개 업데이트 Release와 단순 소스 push는 다르며 이번 보관 작업은 새 Windows Release를 만들지 않는다.

### 관리자/API — `threads-admin-api`

Next.js 16.3.0, React 19.2.8, Drizzle ORM 0.45.2 / Kit 0.31.10, Better Auth 1.6.27, `postgres` 3.4.9. 이전 Fastify/Prisma는 `legacy/prisma-foundation/`의 이력이며 현재 빌드·실행·migration 대상이 아니다.

| 파일/폴더 | 역할 |
| --- | --- |
| `src/server/auth/`, `src/app/api/auth/[...all]/route.ts` | Better Auth 쿠키/서명 Bearer, 채널·권한 검사 |
| `src/server/admin/service.ts`, `src/app/admin/page.tsx` | 관리자 직원·계정 처리 상태 |
| `src/server/threads/service.ts`, `contracts.ts`, `schema-capabilities.ts` | 계정/credential/모바일 검증·갱신 결과 저장 |
| `src/server/publications/service.ts`, `storage.ts` | 스냅샷·직접 PUT 서명·HEAD·S3 복사·완료·회수 |
| `src/server/mobile/service.ts`, `contracts.ts`, `list-cursor.ts` | 모바일 목록·실행권·영수증·상태 보고, 중복/결과 불명 보호 |
| `src/server/db/` | 인증·계정·등록본·모바일 실행 Drizzle 모델 |
| `src/server/security.ts`, `config/env.ts` | 암호화/안전한 서버 설정 |
| `scripts/db-command.mjs`, `database-config.mjs`, `db-state.mjs`, `migrate.mjs` | 명시적 환경 선택·DB 이름/이력 검증·migration |

주요 경로: `/api/v1/access`, `/api/v1/account/password`, `/api/v1/admin/*`, `/api/v1/threads/accounts`, `/api/v1/publications`, `/api/v1/threads/mobile/*`, `/api/v1/mobile/publications`, `/api/v1/mobile/attempts/*`. 모바일 `validation`/`refresh`는 **브라우저 결과를 저장하는 API**이며 서버가 Meta를 대신 호출하지 않는다.

### 모바일 — `threads-mobile-web`

React 19.2.8 + TypeScript 5.9.3 + Vite 8.3.4 정적 클라이언트다. Next.js 프로젝트가 아니다. 배포의 Node 서버는 정적 파일/CSP/health만 제공한다.

| 파일 | 역할 |
| --- | --- |
| `src/api.ts` | 관리자/API 로그인·Bearer·소유권·등록본 호출 |
| `src/meta.ts` | 브라우저 직접 Meta fetch, form 인코딩, 안전한 오류 분류 |
| `src/token.ts` | 만료일 기반 재사용·최초/7일 갱신·revision/latch/저장 복구 |
| `src/publisher.ts` | 실행 의도 저장 → Meta 요청 → ID/영수증 저장, 순차 캐러셀, 단계 사이 60초 대기(상태·링크 조회 없음) |
| `src/journal.ts` | 비민감 실행/영수증 보관·서버 저장 복구 |
| `src/gate.ts` | HTTPS·온라인/표시 상태(기기 검사 없음), 명시적 로컬 개발 예외 |
| `src/App.tsx`, `PostMediaCarousel.tsx`, `publication-list.ts`, `styles.css` | 계정 선택·목록/상세·자동 계정 준비·캐러셀·cursor·계정 카드 |
| `scripts/serve.mjs`, `build-meta.mjs`, `check-static.mjs` | 정적 배포, origin/CSP, 번들/중계 금지 검사 |
| `tests/preview.html`, `preview.ts` | 외부 요청을 차단하는 합성 UI 미리보기 |
| `tests/meta-error-preview.html` | 외부 요청 없는 예외 분류 미리보기 |
| `tests/meta-network-diagnostic.html` | 과거 무효 진단 토큰용 비교 페이지. 현재 실제 요청 재개 수단으로 쓰지 않음 |

## 6. DB·S3·환경 설정

개발 DB는 `threads_admin_dev`, 사용자 `threads_admin_dev_user`. 개발·운영 엔진은 사용자가 확인한 PostgreSQL `11.22-rds.20250508`이다. 운영 DB/사용자 예시는 `threads_admin_prod`/`threads_admin_prod_user`이며 운영 적용 완료로 간주하지 않는다. 같은 인스턴스에 참고 서비스가 있어도 Threads 전용 DB·역할·schema 이력을 분리한다.

| migration | 내용 |
| --- | --- |
| `0000_threads_auth_foundation.sql` | 인증·계정·credential·연결 기반 |
| `0001_account_app_names.sql` | 숫자 App ID 입력 제거, 표시 이름·불변 암호화 context |
| `0002_account_deletion.sql` | 연결 삭제·tombstone·활성 행 고유 제약 |
| `0003_account_lifecycle.sql` | 당시 중지/이관·ledger 모델. 폐기 기능의 스키마 이력은 유지 |
| `0004_publication_snapshots.sql` | 불변 등록본·파일 manifest·source CAS·삭제 영수증 |
| `0005_publication_seven_day_deadline.sql` | 기존 행 보존, 새 168시간 기한 허용 |
| `0006_mobile_publishing.sql` | 모바일 attempt/operation·실행권·결과 저장 |
| `0008_mobile_account_selection.sql` | 휴대폰 연결 제한 삭제: 실행 기록의 연결 ID 필수 해제(2026-10-21 개발 DB 적용) |
| `0009_desktop_meta_request_gate.sql` | 토큰 확인 PC 이전: 직원별 Meta 요청 간격 테이블(2026-10-28 개발 DB 적용) |

개발 DB는 2026-10-28 0009까지 10개 적용/대기 0이다(적용 직후 `db:status`로 확인). SQL·snapshot·hash를 고치거나 reset/push하지 않는다. 서버 시작·deploy는 migration/관리자를 자동 생성하지 않는다.

로컬 관리자 설정은 `.env.development.local`, 서버 배포 폴더는 `.env`다. 현재 값을 보존하고 토큰 마스터키를 임의 재생성하지 않는다.

| 항목 | 용도/위치 |
| --- | --- |
| `DATABASE_URL`, `EXPECTED_DATABASE_NAME` | 중앙 API 서버 전용 DB |
| `BETTER_AUTH_SECRET` | 인증 서명, Meta 암호화 키와 분리 |
| `TOKEN_ENCRYPTION_KEY_BASE64`, `TOKEN_KEY_VERSION`, `TOKEN_PREVIOUS_KEYS_JSON` | 서버 Meta 암호화와 선택적 키 교체 |
| `SERVICE_BASE_URL`, `BETTER_AUTH_BASE_URL`, `MOBILE_ORIGINS` | 서비스 주소와 허용 모바일 origin |
| `TRUSTED_PROXY_MODE` | 로컬 direct, 제어된 NPM 뒤 nginx |
| `S3_UPLOADS_ENABLED`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`, `S3_PREFIX` | 서버에서만 S3 권한/서명 관리 |
| `S3_UPLOAD_URL_TTL_SECONDS` | PUT 서명 기한 기본 900초 |
| `THREADS_ADMIN_API_URL` | Electron 빌드에 주입하는 **공개 API 주소** |
| `VITE_API_BASE_URL` | 모바일 빌드에 주입하는 **공개 API 주소** |

사용자 결정에 따라 외부 DB는 TLS 암호화하지만 CA/서버 인증서 검증은 생략한 구현이다. `scripts/database-config.mjs`를 확인한다. 이 선택을 인증서 검증까지 완료한 보안 상태로 기록하지 않는다.

## 7. 상태 조회 장애 — 2026-10-20 원인 확정

오류:

> Meta 응답을 받지 못했습니다. 브라우저 또는 네트워크에서 요청이 차단되었을 수 있습니다. [등록 결과 확인 · 연결 실패]

**결론(2026-10-20):** Meta의 컨테이너 상태 응답에 `Access-Control-Allow-Origin`이 없어 브라우저가 차단했다. 상태·링크 조회를 제거하고 60초 대기 흐름으로 바꿨으며 이미지 캐러셀 원글의 실제 게시를 확인했다(문서 맨 위 2026-10-20 항목). 아래는 원인 확정 전(2026-10-19) 조사 기록이다.

### 원인 확정 전 확인된 사실

- 과거 Electron/Node 경로에서는 파일 서버를 통한 혼합 원글·댓글 등록 성공 이력이 있다. 지금의 브라우저/S3 경로 성공 증거와는 별개다.
- 새 흐름에서 PC→S3 실제 전송·DB 등록 대기·회수는 확인했다. 사용자 준비 등록본이 모바일 목록에 표시되었다.
- 개발 PC 브라우저 예외에서 실제 `/v1.0/me`와 최초 `/refresh_access_token`이 성공했고 실제 만료일을 서버에 저장했다.
- 실제 이미지 자식 컨테이너 2개 생성 ID가 남아 있다. 이후 상태 GET을 브라우저에서 읽지 못했다. **부모/원글/댓글 등록 성공은 확인하지 못했다.**
- 60초 대기 후 기존 컨테이너 읽기에서도 동일 오류가 보고되었다. 3초 조회 간격만 바꾸면 해결된다는 결론은 성립하지 않는다.
- 무효 진단 토큰/공식 샘플 ID로는 localhost와 개발 HTTPS Origin의 GET이 HTTP 400/코드 190, CORS `*`로 읽혔다. 이것은 **실제 유효 컨테이너 응답의 CORS 성공 증거가 아니다.**
- 따라서 localhost 전체 금지, 모든 fetch의 공통 실패는 재현하지 못했으나 **실제 요청의 CORS·redirect·브라우저/네트워크 실패 원인은 미확정**이다.

### 원인 확정 전에 고친 문제

1. **로그인 즉시 실패는 원인 확정/수정됨:** native `fetch`를 `this.transport(...)`로 호출해 `Illegal invocation`이 발생했다. `api.ts`와 `meta.ts`에서 지역 변수 호출로 바꿨고 실제 브라우저 인증 요청/응답을 검증했다. 모바일 Docker `.3`에 포함되며 사용자가 배포 후 로그인 성공을 확인했다. 현재 상태 조회 장애를 이 버그와 같은 것으로 단정하지 않는다.
2. **토큰 debug 경로 의존 제거:** `debug_token` 브라우저 응답을 읽지 못했고 별도 permissions 조회도 실패하여 두 사전 의존을 제거했다. `/me`와 최초 직접 갱신의 실제 응답을 사용한다. App ID 확인 완료를 임의 보고하지 않는다.
3. **조회 간격/한도 수정:** 첫 조회 60초 대기, 이후 60초 이상, 컨테이너당 최대 5분/5회. 통신 실패 즉시 중단. 수동 inspect도 읽기 전용 대기이며 자동 POST 재시도 없음. → 2026-10-20 상태 조회 자체를 제거하고 단계 사이 60초 대기만 남겼다.
4. **Electron 요청 작성 대조:** POST 문자열 form body + 명시적 `application/x-www-form-urlencoded`, 상태 `fields=id,status`로 맞췄다. 계정·갱신·이미지/영상 자식·부모·댓글·상태·확정 8종 합성 요청이 일치한다. 기존 `status,error_message`는 공식 예시에도 있고 POST는 실제 성공했으므로 이 차이가 장애 원인이었다고 주장하지 않는다.
5. **마지막 진단 보완:** `src/meta.ts`의 `safeTransportDiagnostic`과 DEV 콘솔은 phase/stage/예외 종류/고정 reason/elapsedMs만 남긴다. raw URL·토큰·본문·stack을 남기지 않는다. request setup 오류와 transport 오류, timeout을 구분한다. 해당 예외 분류 합성 검증까지 수행했지만 실제 실패의 네트워크 원인 확정은 끝내지 못했다.

### 원인 확인 방법 (2026-10-20)

1. **재요청 없는 대조로 원인 후보를 좁혔다.**
   - Electron과 요청 형식(주소·헤더·form 인코딩·`redirect: "error"`)이 같았다.
   - 컨테이너 ID는 문자열로 저장되어 숫자 정밀도 손실이 없었다.
   - 개발 서버에는 CSP가 없었다.
   - 테스트 프로필의 uBlock Lite 규칙도 Meta 주소에 걸리지 않았다.
2. **사용자 승인 범위에서 정식 Chrome으로 1회 재현했다.**
   - 페이지에는 런타임 관찰 장치만 붙였고 커밋하지 않았다. 경로·소요 시간·Resource Timing 상태만 기록하고, 토큰이 든 URL은 기록하지 않았다.
   - 무효 토큰 요청 2건(계정 무관)으로 '응답을 읽을 수 있는 오류'와 'CORS 차단'의 측정 형태를 먼저 구분했다.
3. 실패한 상태 GET이 CORS 차단과 같은 형태였고, 콘솔 이유 문장으로 헤더 누락을 확정했다. `mode:no-cors`나 서버 proxy는 쓰지 않았다.

## 8. 실행·검증 명령

Node 22.22.0, pnpm 10.28.1 기준이다. Docker 기반은 TFS와 같은 `node:22.23.0-alpine3.23`로 변경했다. 아래는 필요 시 실행하는 안내이며 이번 인수인계에서 새 Meta 요청/배포를 지시하는 명령이 아니다.

```sh
# 각 프로젝트에서 설치가 필요한 경우
pnpm install --frozen-lockfile

# 관리자/API — 기존 전용 설정을 유지하고 실행
cd /Users/xofl/IdeaProjects/threads-admin-api
pnpm dev

# 모바일 — PC에서 Meta 호출을 허용하지 않는 기본 실행
cd /Users/xofl/IdeaProjects/threads-mobile-web
pnpm dev

# 합성 UI, 외부 요청 차단
pnpm dev:fixture

# Electron — 기본 개발 API는 127.0.0.1:4191
cd /Users/xofl/IdeaProjects/threads-media-manager
pnpm start
```

개발 API 4191, 모바일 4196, 합성 미리보기 4198이다. 2026-10-20 테스트 후 4196은 일반 `pnpm dev`(PC Meta 호출 차단)로 되돌렸다. 실제 계정 테스트가 필요할 때만 사용자 승인 후 `pnpm dev:desktop-meta`로 바꾸고, 끝나면 일반 모드로 되돌린다. 실행 중인 모드는 프로세스 목록에서 `pnpm dev:desktop-meta` 여부로 확인한다. 이 옵션은 Vite DEV + loopback + 명시적 환경값이 동시에 있어야 적용되고 배포본에서는 작동하지 않는다.

```sh
# 각 프로젝트의 오프라인/합성 검사
pnpm typecheck
pnpm lint
pnpm test

# 관리자/API, 모바일 빌드
pnpm build

# 모바일 정적 서비스 검사
pnpm test:static

# Electron 추가 검사
pnpm test:python
pnpm format:check
```

DB 통합 검사는 전용 loopback PostgreSQL 11.22와 합성 설정을 사용하는 opt-in 검사다. `INTEGRATION_DATABASE_URL`에 외부 개발/운영 DB를 넣지 않는다. migration/관리자 CLI는 실제 외부 DB를 변경할 수 있으므로 위 단위 검사와 구분한다.

관련 회귀 파일: 모바일 `tests/meta-request-contract.test.ts`, `carousel-sequence.test.ts`, `meta-diagnostics.test.ts`, `token-bootstrap.test.ts`, `fetch-receiver.test.ts`, `safety.test.ts`; 관리자 `tests/mobile-publishing.integration.test.ts`, `publications.integration.test.ts`, `account-deletion.integration.test.ts`; Electron `mobile-publications.test.ts`, `publication-s3-upload.test.ts`, `managed-threads*.test.ts` 등.

2026-10-20 기준 모바일 7개 파일 / 80개(상태 조회 테스트 제거)와 정적 서비스 13개, 관리자/API 18개 파일 / 177개(격리 PostgreSQL 11.22), Electron 60개 파일 / 1,395개가 통과했다. 이전 기록상 모바일은 82개, 그 전 상태 조회·요청 계약 검사는 74개/정적 서비스 13개였다. 관리자/API와 Electron의 기능별 검증 수는 각 `docs/verification.md` 및 Electron 전송/계정 문서에 당시 범위가 기록되어 있다. **인수인계 문서 작성만으로 이 전체 검사를 재실행한 것으로 기록하지 않는다. Android 모바일 데이터 E2E·Windows 새 로그인/전송/업데이트·운영 DB/배포는 별도 미검증이다.**

## 9. 배포 상태와 서버 운영

| 항목 | 관리자/API | 모바일 |
| --- | --- | --- |
| 개발 도메인 | `https://threads-admin-dev.ilscp.net` | `https://threads-mobile-dev.ilscp.net` |
| 사용자 서버 폴더 | `/docker/threads-admin-api-dev` | `/docker/threads-mobile-web-dev` |
| 호스트 → 컨테이너 포트 | 3006 → 4191 | 3007 → 4196 |
| 마지막 업로드 확인 이미지 | `ilseong/threads-admin-api:v0.1.0-dev.20261021.1` | `ilseong/threads-mobile-web:v0.1.0-dev.20261021.1` |
| 사용자 확인 | 2026-10-21 `.20261021.1` 개발 서버 배포 완료 통보 | 2026-10-21 `.20261021.1` 개발 서버 배포 완료 통보 |

운영 도메인은 `threads-admin.ilscp.net`, `threads-mobile.ilscp.net`으로 정했다. 운영 포트 3008/3009는 예제이며 운영 완료 상태가 아니다. Nginx Proxy Manager는 **개발 인스턴스와 다른 서버**다. 개발 접속 timeout은 사용자가 막힌 3006/3007 포트를 열어 해결했다. 동일 서버/localhost proxy로 가정하지 않는다.

구형 서버 Docker 19.03.5에서 초기 Bookworm 기반 Node 이미지가 worker thread 시작 전에 실패했다. 기존 TFS와 같은 Alpine 기반 `.2`로 바꿨고 사용자 배포에서 관리자 서비스 시작을 확인했다. 서버 Docker 업그레이드나 seccomp 완화로 무작정 돌아가지 않는다.

두 프로젝트 모두 각 배포 폴더 `.env`와 `COMPOSE_PROJECT_NAME`으로 dev/prod를 분리한다. 사용자는 일반 명령을 원한다.

```sh
# 해당 서버 배포 폴더에서 사용자가 실행
docker compose up -d
docker compose logs -f --tail 100
docker compose stop
docker compose start
docker compose down

# 새 이미지 태그가 실제 업로드된 뒤 사용자 실행
./deploy.sh VERSION
```

`deploy.sh`는 pull → .env 이미지 태그 저장 → up → 내부 health 확인이다. 자동 migration·down·prune·rollback을 하지 않는다. 이전 `scripts/compose.sh dev VERSION ...` 전용 운영 절차는 필수 요구가 아니다. `.env.dev`에서 표준 `.env`로 전환하는 스크립트는 이미 구현되어 있다.

**2026-10-20 변경(상태·링크 조회 제거, 게시 실행권 조건, 리뷰 반영, 완료 탭·뱃지, 댓글 동기화, 계정 정보 수정)은 `v0.1.0-dev.20261020.1`로 업로드·배포했다(관리자/API `sha256:c6e4f4d6e4903405f21db9ffdd865b3b522bf8143e34759df59807071635dfdd`, 모바일 `sha256:37cdaaa01993a3c2d23ec53759fd0c9b58cb219d8ab1229a62893694b46086bd`, 둘 다 linux/amd64). DB migration은 없다.** 소스 push만으로 개발 사이트가 최신 코드가 되지 않는다. `.env.dev.example`의 모바일 이미지 기본 태그도 `.2`이므로 신규 설치 때 마지막 사용 버전과 혼동하지 않는다. 실제 서버 `.env`를 예제로 덮어쓰지 않는다.

**2026-10-20 관리자/API `v0.1.0-dev.20261020.2`(소스 `69e1e9f`, `sha256:e8b58fd8710380ed2be897faa8099f892a6804e54a2a06c88d63f070e230064c`, linux/amd64): 계정 연결 탭 제거·사용자별 계정 상세, 사용자 삭제(퇴사)와 `0007_user_deletion`(user.deleted_at 추가), 사용 중지 로그인 문구. 사용자가 개발 DB `threads_admin_dev`에 0007을 적용(적용 8개/대기 0개)한 뒤 배포했고, 배포 후 로그인 화면 200·health ok를 확인했다.** 사용 중지 문구("사용이 중지된 계정입니다.", `BANNED_USER`)는 서버만 바뀌었다. PC 앱과 휴대폰 화면 표시는 2026-10-21 폐기했다(사용자 결정). 운영 DB는 아직 만들지 않았으며, 테스트가 끝나면 만든 뒤 모든 migration을 한 번에 적용한다.

**2026-10-21 관리자/API·모바일 `v0.1.0-dev.20261021.1`(소스 `507d6dd`·`241715b`, linux/amd64): 휴대폰 연결·기기 제한 삭제. 개발 DB에 0008을 적용(적용 9개/대기 0개)한 뒤 사용자가 배포했다.** digest와 확인 내용은 맨 위 2026-10-21 항목에 있다.

**2026-10-27 모바일 `v0.1.0-dev.20261027.1`(소스 `ca556d5`, linux/amd64): 오래된 Chrome·삼성 인터넷 지원. 관리자/API·DB 변경은 없다.** digest와 확인 내용은 맨 위 2026-10-27 항목에 있다.

**2026-10-28 관리자/API `v0.1.0-dev.20261028.1`(소스 `330b79e`, linux/amd64): 토큰 확인·갱신 PC 이전의 서버 쪽. 개발 DB에 0009를 적용(적용 10개/대기 0개)한 뒤 사용자가 배포했다. PC 0.1.8과 모바일은 아직 배포하지 않았다.** digest와 확인 내용은 맨 위 2026-10-28 항목에 있다.

## 10. 추가 문서·증거와 인수인계 완료 기준

- Electron: `docs/mobile-publishing-migration.md`, `mobile-publication-delivery.md`, `account-management-lifecycle.md`, `s3-publication-setup.md`, `phase-3-threads-api.md`.
- 관리자/API: `docs/database-contract.md`, `development-database.md`, `mobile-publishing.md`, `publication-delivery.md`, `deployment.md`, `verification.md`.
- 모바일: `docs/direct-publishing.md`, `phone-test.md`, `deployment.md`, `verification.md`.
- 로컬에만 있는 진단 증거: 모바일 `artifacts/electron-request-comparison-20261019/`의 합성 요청/소스 hash/비교 결과, `artifacts/auto-token-20261019/`의 합성 UI 결과. Git에 포함되는 계약 fixture는 `tests/fixtures/electron-wire.json`이다. 실제 계정·사용자 화면을 담을 수 있는 artifact 전체를 공개 저장소로 강제 추가하지 않는다.

문서 간 같은 날짜의 여러 기록은 누적 개발 이력이다. 오래된 “후속 단계/미정” 설명만으로 현재 코드를 다시 만들지 않는다. 정확한 현재 코드를 먼저 읽고 이번 문서의 미해결 범위를 유지한다.

상태 GET 실패의 원인과 증거는 2026-10-20에 확정했다(7절). 이후 작업은 맨 위 2026-10-20 항목의 '미검증·후속'을 따른다. 모의 테스트 통과나 PC 예외의 원글·댓글 성공만으로 영상·Android 실등록까지 완료했다고 말하지 않는다.

### 이번 코드 보관 직전 확인

- 세 프로젝트의 `pnpm typecheck`를 다시 실행해 모두 통과했다.
- 모바일 `pnpm test`는 7개 파일 / 82개 합성 검사 통과다. 처음에는 로컬 파일 권한 때문에 Vite 임시 파일 생성에서 중단됐고, 허용된 파일 접근으로 다시 실행해 통과했다. 실제 Meta 요청은 없었다.
- 커밋 후보의 환경파일·개인키·실제 토큰 패턴과 큰 파일을 점검했다. 실제 환경파일·증거 이미지·독립 가이드 저장소를 제외하고 예제/합성 fixture는 보존한다.
- 이번에는 Electron/API 전체 통합 검사·실제 등록·AWS 배포를 다시 수행하지 않았다. 세 프로젝트의 `CLAUDE.md`가 이 통합 문서를 가리킨다.
