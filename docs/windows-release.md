# Windows Release와 자동 업데이트

0.1.1부터 local-video-manager와 동일한 `update-electron-app@3.3.0`, Electron Public Update Service, 공개 GitHub Releases, Squirrel.Windows를 사용한다. Mac은 개발 코드로 실행하며 자동 업데이트 확인·다운로드를 하지 않는다.

## 개발용·운영용 두 벌 (2026-11-20)

같은 소스에서 설치용 빌드를 두 벌 만든다. 벌은 빌드할 때 환경 변수 `TMM_VARIANT=dev|prod`로 고르고, 벌마다 다른 값은 모두 저장소의 [`variants.json`](../variants.json)에 있다. 읽는 코드는 `scripts/variants.mjs` 하나이며(Python 검증은 같은 파일을 직접 읽는다) 빌드 설정·검증 스크립트·CI가 이 값을 쓴다. 앱 코드는 이 파일을 import하지 않고, 빌드가 고른 벌의 값만 번들에 넣는다. 설계와 결정은 [개발/운영 분리 설계](dev-prod-split.md).

| 항목 | 개발용 (`dev`) | 운영용 (`prod`) |
| --- | --- | --- |
| 화면 안의 이름 | (개발) ILS 소셜(T) 관리 | ILS 소셜(T) 관리 |
| 시작 메뉴·프로그램 목록 이름 | Threads Media Manager | ILS 소셜(T) 관리 |
| 실행 파일 | `ThreadsMediaManager.exe` | `IlsSocialManager.exe` |
| 설치 식별자(Squirrel) | `threads_media_manager` | `ils_social_manager` |
| 설치 파일 | `ThreadsMediaManager-win32-x64-Setup.exe` | `IlsSocialManager-win32-x64-Setup.exe` |
| 자료 폴더(`%APPDATA%`) | `ThreadsMediaManager` | `IlsSocialManager` |
| 접속 서버 | `https://threads-admin-dev.ilscp.net` | `https://threads-admin.ilscp.net` |
| 업데이트·릴리스 저장소 | `ilseong-xofl/threads-media-manager` | `ilseong-xofl/threads-media-manager-prod` |

- 개발용의 설치 쪽 값은 0.1.10까지의 설치본과 같다. 그래서 기존 설치본이 자동 업데이트로 그대로 넘어온다. 달라지는 것은 화면 안의 이름뿐이다. 이 값은 `src/shared/variants.test.ts`가 고정한다.
- `TMM_VARIANT`가 없거나 `dev`·`prod`가 아니면 설치용 빌드(`pnpm make`·`pnpm package`)와 `pnpm verify:windows`가 실패한다. 기본 벌은 없다.
- 포장하지 않은 실행(`pnpm start`)은 `TMM_VARIANT`를 보지 않는다. 화면 이름만 개발용 것을 쓰고, 접속 서버 기본값(`http://127.0.0.1:4191`, `THREADS_ADMIN_API_URL`로 바꿈)·`TMM_USER_DATA` 격리·업데이트 없음은 그대로다.
- 버전 번호는 두 벌이 같이 쓴다. 운영용은 개발용으로 먼저 릴리스한 버전만 낼 수 있다(아래 "운영용 릴리스").

아래 절은 개발용 기준으로 쓰여 있다. 운영용은 표의 이름으로 바꿔 읽는다.

## 사용자 동작

Windows 설치 앱은 시작 10초 후와 이후 1시간마다 최신 버전을 확인한다. Squirrel 최초 실행 잠금과 겹치지 않도록 10초를 기다린다. 새 버전은 백그라운드에서 내려받고 적용 준비가 끝나면 **나중에 / 지금 재시작**을 표시한다. 기본·취소 선택은 나중에다. 지금 재시작은 앱을 종료·갱신·재실행하고, 나중에는 정상 종료 후 다음 실행에서 적용한다. 같은 업데이트 안내를 반복하지 않는다.

진행 중 다운로드·저장·편집·삭제·DB 백업/복원·AI 캡션·ChatGPT 로그인·Threads 게시/토큰/통계 작업은 끝날 때까지 재시작을 보류한다. 열린 상세·작성·설정창도 닫기 전까지 보류해 미저장 입력을 보호한다. renderer 준비 상태가 없거나 IPC가 실패하면 보류를 유지한다. 재시작 선택 직후 busy를 다시 확인하고, 확정 뒤 새 IPC 작업과 주기 Threads 조회를 차단한다. 업데이트 실패가 로컬 앱 시작을 막거나 자료를 초기화하지 않는다.

기존 0.1.0에는 updater가 없다. 사용자는 0.1.1 Setup.exe를 한 번 실행해야 하며 그 이후부터 더 높은 공개 버전을 자동으로 받는다. 기존 앱의 userData·작업 폴더 위치, Squirrel app ID와 실행 파일 이름을 유지한다.

## GitHub 배포

대상은 공개 `ilseong-xofl/threads-media-manager`다(개발용. 운영용은 `ilseong-xofl/threads-media-manager-prod`). 2026-11-20부터 `variants.json`의 그 벌 저장소를 main 번들에 빌드 시 삽입하며(전에는 Actions의 `GITHUB_REPOSITORY`) 앱 실행 환경 변수로 원본을 바꾸지 않는다. 유효한 빌드 원본이 없으면 updater만 비활성화한다. 앱은 `https://update.electronjs.org/<owner>/<repo>/win32-x64/<version>`을 확인한다. 별도 파일 서버·AWS 키·사용자 GitHub 토큰은 필요 없다.

Release에는 다음을 함께 올린다.

- `ThreadsMediaManager-win32-x64-Setup.exe`
- `RELEASES`
- `threads_media_manager-<version>-full.nupkg`
- `SHA256SUMS.txt`
- `verification.json`

`verify:windows`는 기존 내장 실행기 검사에 더해 RELEASES SHA-1·크기, NuGet 앱 ID/버전, x64 PE, ASAR 앱 버전·GitHub updater 원본 및 알려진 인증/사용자 파일명 미포함을 검사한다. 2026-11-20부터 벌 검사를 한다: 번들의 접속 서버가 그 벌의 값과 정확히 같고, 번들에 그 벌의 업데이트 저장소가 있으며 다른 벌의 저장소·서버 주소가 없고(개발 저장소 이름이 운영 저장소 이름의 앞부분이라 이름 전체로 비교한다), Setup.exe가 같은 벌·같은 버전의 패키지를 담고 있고, 패키지의 제목·게시자와 실행 파일이 그 벌의 것이다. 벌 이름은 `verification.json`의 `variant`와 `release.variant`에 남는다. 0.1.2부터 Windows CI는 생성한 패키지 실행 파일을 실제로 띄워 renderer·preload·조회 IPC도 확인하고 `verification.json`에 `ui` 결과를 넣는다. 게시 작업은 이 결과가 모두 성공해야 진행한다. Setup.exe 전체 설치·제거 및 실제 버전 간 업데이트 완료는 별도 검증이다.

Windows CI는 push마다 두 벌을 따로 빌드·검증한다(`Check (windows-2022, dev)`, `Check (windows-2022, prod)`). 후보 artifact 이름에 벌이 들어간다: `threads-media-manager-windows-candidate-dev-<sha>`, `...-candidate-prod-<sha>`. 이 저장소의 `release-windows.yml`은 개발용 후보만 받아 게시하며, 후보의 벌 표시가 `dev`가 아니거나 이 저장소가 개발용의 업데이트 저장소가 아니면 거절한다.

배포할 소스의 `package.json`을 기존 공개 버전보다 높이고 CI를 한 번 통과시킨다. 그 커밋에 동일한 `v<version>` 태그를 push한다. `release-windows.yml`은 공개 저장소·태그/버전 일치·기존 버전 미중복과 동일 커밋의 CI 성공을 확인하고, 이미 검증된 설치 파일을 GitHub 안에서 Release로 옮긴다. 전체 테스트와 빌드를 다시 실행하지 않는다. 전달받은 파일의 SHA-256과 Squirrel 패키지 무결성만 확인한 뒤 모든 파일을 draft에 올리고 일반 Release로 전환한다. 기존 Release 파일은 덮어쓰지 않는다. 필요하면 태그와 성공한 CI 실행 번호를 지정해 수동 게시한다. 태그는 원래 검증한 앱 소스를 유지하며 게시 작업만 수정해도 앱을 재빌드하지 않는다.

일반 CI artifact는 14일 뒤 만료되는 시험 후보이며 자동 업데이트 배포 대상이 아니다. 공개 일반 Release만 Electron 서비스가 제공한다. draft/prerelease는 대상에서 제외된다. 공개 이후 같은 버전을 재사용하거나 설치 ID를 변경하지 않는다.

## 운영용 릴리스 (2026-11-20)

운영용은 운영 저장소(`ilseong-xofl/threads-media-manager-prod`, 공개)의 작업이 릴리스한다. 그 저장소에는 릴리스 작업 파일과 릴리스만 둔다. 작업 파일의 원본은 이 저장소의 [`distribution/prod-release/`](../distribution/prod-release/README.md)에 있다.

1. 이 저장소에서 그 버전을 개발용으로 릴리스하고(태그 `v<버전>`), 테스터가 확인한다.
2. 운영 저장소의 Actions에서 사람이 버전을 넣고 직접 실행한다. 태그만으로는 나가지 않는다.
3. 작업은 이 저장소에 그 버전의 공개된 개발용 릴리스가 있는지, 그 릴리스가 태그와 같은 커밋에서 만들어졌는지, 버전이 운영 저장소의 기존 릴리스보다 큰지 확인한다. 그다음 태그의 소스를 받아 `TMM_VARIANT=prod`로 빌드하고 이 저장소의 `verify:windows`를 그대로 돌린 뒤 운영 저장소에 정식 릴리스를 만든다. 다른 저장소에 쓰는 토큰은 없다.

운영용은 개발용 파일을 옮기는 것이 아니라 같은 커밋을 운영용 값으로 다시 빌드한 것이다. 운영 저장소 생성·첫 릴리스·예행은 운영 개시 때 한다(설계 문서 5장·7장). 2026-11-20 현재 운영 저장소는 없고 운영용은 릴리스한 적이 없다.

## 서비스 주소 (2026-10-20)

2026-11-20부터 접속 서버는 저장소 변수가 아니라 `variants.json`의 그 벌 값이다. 저장소 변수 `THREADS_ADMIN_API_URL`은 CI와 릴리스에서 더 쓰지 않는다. 아래는 그 전의 기록이다.

서비스 로그인이 들어간 첫 Windows 버전(0.1.6 예정)부터 설치 앱은 서비스에 로그인해야 열리고, 서비스에 닿지 못하면 앱 전체가 잠긴다. CI는 저장소 변수 `THREADS_ADMIN_API_URL`(HTTPS origin)을 빌드에 넣고, 실제 앱 번들에 들어갔는지 확인해 `verification.json`의 `release.serviceUrl`에 기록한다. 변수가 없으면 CI는 통과하지만 `release-windows.yml`이 게시를 거절한다. 접속 서버(운영/개발)와 사용자 서비스 계정을 정한 뒤 변수를 설정하고 CI를 다시 통과시켜 릴리스한다. 2026-10-20 테스트 단계로 개발 서버 `https://threads-admin-dev.ilscp.net`을 설정했다. 테스트가 끝나면 운영 주소로 바꿔 새 버전으로 빌드·릴리스한다.

패키지 화면 검사는 첫 화면인 서비스 로그인·잠금 화면, preload, 인증 IPC 응답, 로그인 전 라이브러리 IPC 거절을 확인한다. CI에는 서비스 계정이 없으므로 로그인하거나 화면을 조작하지 않는다.

## 서명과 검증

사용자 결정에 따라 Windows는 서명 없이 배포한다. 이 업데이트 방식은 Windows 서명을 필수로 요구하지 않지만 설치 시 경고가 나올 수 있다. 인증서가 필요한 Mac 배포는 범위에 없다.

단위 테스트는 시작/플랫폼 제한·백그라운드 설정·지연/중복/나중에/재시작·작업 경합·입력 보존·오류를 확인한다. Windows CI는 패키지와 feed를 확인한다. 실제 서로 다른 공개 버전의 다운로드·지금 재시작·나중에·기존 자료/로그인 보존은 [Windows 가이드의 앱 업데이트](windows-install-test.md)에서 별도로 확인한다. 첫 Release만 있는 상태를 버전 간 자동 업데이트 실기 통과로 보고하지 않는다.

근거: [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater), [공식 update-electron-app](https://github.com/electron/update-electron-app), [Squirrel.Windows maker](https://www.electronforge.io/config/makers/squirrel.windows).
