# Windows Release와 자동 업데이트

0.1.1부터 local-video-manager와 동일한 `update-electron-app@3.3.0`, Electron Public Update Service, 공개 GitHub Releases, Squirrel.Windows를 사용한다. Mac은 개발 코드로 실행하며 자동 업데이트 확인·다운로드를 하지 않는다.

## 사용자 동작

Windows 설치 앱은 시작 10초 후와 이후 1시간마다 최신 버전을 확인한다. Squirrel 최초 실행 잠금과 겹치지 않도록 10초를 기다린다. 새 버전은 백그라운드에서 내려받고 적용 준비가 끝나면 **나중에 / 지금 재시작**을 표시한다. 기본·취소 선택은 나중에다. 지금 재시작은 앱을 종료·갱신·재실행하고, 나중에는 정상 종료 후 다음 실행에서 적용한다. 같은 업데이트 안내를 반복하지 않는다.

진행 중 다운로드·저장·편집·삭제·DB 백업/복원·AI 캡션·ChatGPT 로그인·Threads 게시/토큰/통계 작업은 끝날 때까지 재시작을 보류한다. 열린 상세·작성·설정창도 닫기 전까지 보류해 미저장 입력을 보호한다. renderer 준비 상태가 없거나 IPC가 실패하면 보류를 유지한다. 재시작 선택 직후 busy를 다시 확인하고, 확정 뒤 새 IPC 작업과 주기 Threads 조회를 차단한다. 업데이트 실패가 로컬 앱 시작을 막거나 자료를 초기화하지 않는다.

기존 0.1.0에는 updater가 없다. 사용자는 0.1.1 Setup.exe를 한 번 실행해야 하며 그 이후부터 더 높은 공개 버전을 자동으로 받는다. 기존 앱의 userData·작업 폴더 위치, Squirrel app ID와 실행 파일 이름을 유지한다.

## GitHub 배포

대상은 공개 `ilseong-xofl/threads-media-manager`다. Actions의 `GITHUB_REPOSITORY`를 main 번들에 빌드 시 삽입하며 앱 실행 환경 변수로 원본을 바꾸지 않는다. 유효한 빌드 원본이 없으면 updater만 비활성화한다. 앱은 `https://update.electronjs.org/<owner>/<repo>/win32-x64/<version>`을 확인한다. 별도 파일 서버·AWS 키·사용자 GitHub 토큰은 필요 없다.

Release에는 다음을 함께 올린다.

- `ThreadsMediaManager-win32-x64-Setup.exe`
- `RELEASES`
- `threads_media_manager-<version>-full.nupkg`
- `SHA256SUMS.txt`
- `verification.json`

`verify:windows`는 기존 내장 실행기 검사에 더해 RELEASES SHA-1·크기, NuGet 앱 ID/버전, x64 PE, ASAR 앱 버전·GitHub updater 원본 및 알려진 인증/사용자 파일명 미포함을 검사한다. 이것은 설치 실행·실제 업데이트 완료 검사가 아니다.

향후 배포는 검증한 소스의 `package.json`을 기존 공개 버전보다 높이고 동일한 `v<version>` 태그를 push한다. `release-windows.yml`이 공개 저장소·태그/버전 일치·기존 버전 미중복을 확인하고 Windows 검사·빌드·패키지 검증을 수행한다. 모든 파일을 draft에 올린 뒤 일반 Release로 전환한다. 기존 Release 파일은 덮어쓰지 않는다. 최초 기준 Release는 성공한 동일 커밋 CI의 검증된 산출물을 그대로 게시할 수 있다.

일반 CI artifact는 14일 뒤 만료되는 시험 후보이며 자동 업데이트 배포 대상이 아니다. 공개 일반 Release만 Electron 서비스가 제공한다. draft/prerelease는 대상에서 제외된다. 공개 이후 같은 버전을 재사용하거나 설치 ID를 변경하지 않는다.

## 서명과 검증

사용자 결정에 따라 Windows는 서명 없이 배포한다. 이 업데이트 방식은 Windows 서명을 필수로 요구하지 않지만 설치 시 경고가 나올 수 있다. 인증서가 필요한 Mac 배포는 범위에 없다.

단위 테스트는 시작/플랫폼 제한·백그라운드 설정·지연/중복/나중에/재시작·작업 경합·입력 보존·오류를 확인한다. Windows CI는 패키지와 feed를 확인한다. 실제 서로 다른 공개 버전의 다운로드·지금 재시작·나중에·기존 자료/로그인 보존은 [Windows 가이드 8번](windows-install-test.md)에서 별도로 확인한다. 첫 Release만 있는 상태를 버전 간 자동 업데이트 실기 통과로 보고하지 않는다.

근거: [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater), [공식 update-electron-app](https://github.com/electron/update-electron-app), [Squirrel.Windows maker](https://www.electronforge.io/config/makers/squirrel.windows).
