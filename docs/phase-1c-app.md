# 1C: Electron 개발 환경과 Excel 목록

2026-09-21 Mac 개발 검증 완료. 후속 변경으로 입력을 Excel 원본으로 전환했다. 실제 CDN 요청과 다운로드 실행기 연결은 1D 이후다.

## 실행

프로젝트 루트에서 Node 24.18.0과 pnpm 10.28.1을 사용한다.

```sh
nvm use
pnpm install --frozen-lockfile
pnpm start
```

Excel 읽기는 Python 3.11 이상 표준 라이브러리만 사용한다. Mac은 PATH의 `python3`, Windows 개발 코드는 `py -3`을 기본으로 한다. 다른 실행 파일은 `TMM_PYTHON`에 절대 경로를 지정한다. 기존 다운로드 테스트 전체에는 종전과 같이 Pillow와 ffprobe가 필요하지만 1C 앱에는 필요하지 않다. Python이 없거나 실행에 실패하면 UI에 원인과 설정 안내를 표시한다. 자동 설치하지 않는다.

```sh
TMM_PYTHON="/path/to/python3" pnpm start
TMM_PYTHON="/path/to/python3-with-existing-test-dependencies" pnpm check
```

`pnpm check`는 lint, TypeScript, Vitest, 기존 테스트를 포함한 Python 테스트, 새 앱 코드 형식을 확인한다. 기존 플러그인·문서의 서식을 일괄 변경하지 않는다.

## 화면과 데이터

- 첫 실행은 홈의 `.threads-media-manager/settings.json`에서 수집 위치를 읽는다. 앱에서 폴더를 선택하면 새 앱의 `userData/view-settings.json`에 그 위치만 기억한다. 플러그인의 기본 설정은 변경하지 않는다.
- 시작과 사용자 새로고침에서 검증된 Excel을 검증·병합한다. 자동 수집, 폴더 감시, 원격 확인은 없다.
- 계정·저장 상태 필터와 캡션/계정/게시글 ID 검색, 게시글 상세, KST 등록일/수집일/관찰일, 원문 캡션, 첨부 종류·순서·수집 상태를 표시한다.
- 실제 전체 첨부 수 미확정과 현재 확인된 첨부 수를 구분한다. 최신 관찰이 부분이어도 이전의 더 완전한 캡션과 그 확인 시각을 표시한다. 부분 관찰에서 사라진 저장 파일은 원본 연결 필요로 보존한다.
- 같은 원본 재읽기는 목록을 늘리지 않는다. 손상·진행 중 실행·관찰 충돌·읽는 중 변경은 새 스냅샷을 반영하지 않고 오류와 마지막 정상 목록을 표시한다. `_work/collector.lock`이 있으면 새 읽기를 보류하며 잠금을 생성하거나 삭제하지 않는다.
- 기존 앱 전용 `state/state.db`의 application/schema ID와 library UUID를 확인한다. `mode=ro&immutable=1`, `query_only`로 연결 정보만 읽고 파일 크기·SHA-256을 확인한다. DB/미디어/잠금/정책을 생성·수정하지 않는다.
- 비어 있지 않은 WAL 또는 rollback journal이 있으면 기존 저장 상태는 확인 필요로 표시한다. 미반영 기록을 무시하지 않고 checkpoint·복구·migration도 실행하지 않는다. Excel 목록은 계속 볼 수 있다.
- 등록된 로컬 첨부 UUID만 `threads-media://file/<UUID>`로 전달한다. 원격 미디어 URL은 renderer에 전달하지 않으며 `img`/`video`의 src로 사용하지 않는다. 저장되지 않은 첨부에는 상태만 표시한다. 영상은 자동재생하지 않는다.

## 분리된 환경

| 항목 | 값 |
|---|---|
| 앱 이름 / package | Threads Media Manager / threads-media-manager |
| 앱 ID | com.threadsmediamanager.desktop |
| 실행 파일명 | ThreadsMediaManager |
| userData | OS appData 아래 ThreadsMediaManager |
| preload API | window.threadsMedia.current / chooseFolder / refresh |
| 미디어 protocol | threads-media |
| 개발 서버 / 로그 서버 | localhost:3120 / localhost:9120 |

local-video-manager에서 직접 확인한 Electron 43.3.0, Forge 7.11.2, Webpack 5.109.2, React/ReactDOM 19.2.8, TypeScript 5.9.3, Vitest 4.1.10과 hoisted pnpm 환경을 고정했다. macOS polling watcher와 로컬 파일 range 응답 구조를 재사용했다. 기존 main, 로그인, 토큰, 기존 앱 SQLite, service client, updater, Google Fonts, GitHub/service 주소 주입은 가져오지 않았다.

[Electron 보안 지침](https://www.electronjs.org/docs/latest/tutorial/security)에 맞춰 context isolation, sandbox, Node integration 비활성화, 제한된 preload, main frame/sender 검증, 새 창·탐색·권한 거부를 적용했다. 개발 renderer 네트워크는 해당 Forge loopback 포트와 UUID 미디어 주소만 허용한다. 실제 파일 제공 시에도 realpath·symlink·hardlink·크기·파일 변경을 확인한다. 범위 요청은 단일 byte range/HEAD만 지원한다.

## 검증 결과

- `pnpm check`: TypeScript/Vitest 20개, Python 170개, lint/typecheck/format 통과.
- Mac Forge 개발 앱 실행, 실제 10게시글·20첨부·기존 저장 이미지 1개 표시. 실제 영상 재생은 이번 자료에 저장된 영상이 없어 검증하지 않았다. 영상 range 응답은 합성 로컬 파일 단위 테스트로 확인했다.
- 새로고침 전후 게시글 내용/수량 일치, 검색과 저장 상태 필터, 로컬 이미지 너비 870px 로드, renderer에서 require/process 미노출, 가로 넘침 없음, 영상 자동재생 없음 확인.
- 실제 화면 새로고침·검색·미리보기 구간 CDP 관찰에서 원격 HTTP/HTTPS/WS 요청 0건, renderer 예외 0건.
- 1C 최초 검증에서 사용자 자료12파일의 목록·SHA-256이 같았다. Excel 전환 후 기존 JSONL1개만 동등성 확인 뒤 backups/legacy-jsonl로 이동했으며, 12파일의 내용 해시는 모두 같다. 추가 수집·GET·HEAD·요청 소비·다운로드는 실행하지 않았다.

화면 검증은 개발 앱에 loopback 디버그 포트를 열어 다음처럼 재현한다. 정상 수집 폴더가 연결된 앱에 사용한다. 로그에는 캡션·서명 URL을 출력하지 않는다. 화면 캡처는 개인 자료가 포함될 수 있으므로 코드 저장소 밖에 둔다.

```sh
pnpm start -- --remote-debugging-port=9337
# 별도 터미널
TMM_SMOKE_OUTPUT="/path/outside/repository" node scripts/smoke.mjs
```

격리된 개발 확인에는 `TMM_USER_DATA`와 `TMM_SETTINGS_PATH`를 사용할 수 있다. 정상 실행에는 디버그 포트나 테스트 환경 변수가 필요하지 않다.

## 다음 단계

1D에서 앱의 단일 다운로드 실행기 연결·한 파일 처리·첫 오류 중단을 구현한다. 기존 HTTP 1회/24시간 파일럿, 요청 소비량과 중단 상태는 그대로 보존돼 있다. 실제 CDN 요청의 승인과 운영 정책 확정은 별개다. 1E의 게시글 회차·재개, 1F의 확장 관리, 1G의 Windows 실제 기능/설치/업데이트는 미구현·미검증이다. Mac 설치 파일, Windows 패키지, 배포·커밋·push는 이번 작업에 포함하지 않았다.

## Excel 원본 전환

앱과 파일럿은 daily-v1 Excel을 직접 읽고 SQLite 작업 상태에 연결한다. 신규 계획은 source_type=xlsx를 저장한다. 기존 jsonl 완료 작업의 UUID·파일·소비량은 유지하며 미완료 작업은 원본 변경을 확인하기 전 전송하지 않는다. 수집은 임시 JSONL만 쓰고 검증된 Excel 저장 후 정리한다. [저장·복구 계약](../plugins/threads-collector/references/collection-source.md)을 따른다.

실제 Excel 읽기에서 10게시글·20첨부·기존 로컬 JPEG1개를 확인했다. 오프라인 테스트는 저장 실패 후 재실행, Excel 잠금, 부분 수집의 일별 시도, 같은 날 부분 관찰의 캡션 출처, 추가 열·메모·서식 보존, 임시 기록 정리와 이전 다운로드 상태 호환을 포함한다.

플러그인 설치본은 `0.1.0+codex.20260921075554`이며 소스24파일과 해시가 일치한다. 새 스킬 로드는 새 Codex 작업에서 확인한다. Excel 전환 후 Mac 앱의 새로고침·검색·저장 필터·로컬 이미지·원격 요청0·renderer 예외0 검증도 통과했다.
