---
name: threads-update
description: Update an installed Threads Collector plugin from its verified GitHub marketplace without asking the user to use a terminal. Use for 수집 플러그인 업데이트 or Threads 플러그인 갱신. Does not collect posts or update the local app.
---

# Threads 수집 플러그인 업데이트

사용자가 업데이트를 요청하면 Codex가 공식 플러그인 관리 명령으로 처리한다. 사용자에게 터미널·Git·Node·Python 설치나 명령 입력을 요구하지 않는다. 수집 플러그인만 갱신하며 로컬 앱·Codex 앱 자체의 업데이트와 구분한다.

## 배포 대상 확인

이 스킬의 배포 대상은 다음 하나다.

- GitHub 저장소: `https://github.com/ilseong-xofl/threads-collector`
- 추적 브랜치: `main`
- marketplace 이름: `threads-collector`
- 설치 식별자: `threads-collector@threads-collector`

1. 현재 대화의 스킬 목록에서 이 스킬의 실제 로드 경로를 확인하고 같은 패키지의 [manifest](../../.codex-plugin/plugin.json)를 읽는다. 현재 대화 버전과 설치된 캐시 버전을 별도로 기록한다. 개발 저장소의 버전을 현재 대화 버전이라고 보고하지 않는다.
2. 현재 PC에 제공된 Codex 앱의 실행 파일·설치 정보 또는 이미 사용 가능한 `codex`를 확인하고 공식 CLI를 사용한다. 앱에 포함된 CLI 경로가 필요하면 실제 설치 정보에서 찾는다. Mac/Windows의 고정 경로나 다른 PC의 경로를 추정하지 않는다. `--version`, `plugin marketplace --help`, `plugin add --help`로 지원 여부를 확인한다. CLI나 필요한 명령이 없으면 Codex 앱의 업데이트/지원 확인이 필요하다고 알리고 종료한다. 설치 스크립트 다운로드, 전역 도구 설치, 임의의 다른 CLI로 대체하지 않는다.
3. 같은 사용자·같은 Codex 홈에서 `plugin marketplace list --json`과 `plugin list --json`을 읽는다. 앱의 실제 설치 환경과 다른 임시 `CODEX_HOME`이나 로컬 앱의 AI 캡션 전용 CLI/인증 홈을 사용하지 않는다. 인증 파일과 전체 설정 내용을 출력하지 않는다.
4. 대상 marketplace가 Git 원본이고 위 GitHub 저장소를 가리키는지 확인한다. HTTPS 주소의 `.git` 유무는 같은 저장소로 판단할 수 있지만 계정·저장소 이름이 다른 주소는 허용하지 않는다. 등록 정보에서 추적 브랜치가 `main`인지 확인한다. 목록에 브랜치가 없으면 공식 명령/등록 메타데이터의 해당 항목만 읽어 확인하며 필드 이름이나 기본 브랜치를 추정하지 않는다. CLI 0.158.0에서 확인한 사용자 config.toml의 `[marketplaces.threads-collector]` 등록 정보는 `source_type="git"`, `source="https://github.com/ilseong-xofl/threads-collector.git"`, `ref="main"`이다. 전체 설정 대신 이 항목만 확인하고 현재 설치 버전의 형식이 다르면 추정하지 않는다. 자격 증명이 포함된 URL은 출력하지 않는다.
5. 설치된 대상 식별자와 패키지 경로를 확인한다. 같은 이름의 `personal`, `threads-collector-testing`, 로컬 폴더 또는 다른 Git 원본은 이 업데이트 대상이 아니다. 대상이 없거나 출처·브랜치를 확인할 수 없으면 확인된 불일치와 최초 설치 가이드가 필요한 이유를 보고하고 멈춘다. marketplace를 임의로 추가·제거·교체하거나 개발용 설치를 삭제하지 않는다. 별도 출처의 동명 플러그인이 함께 활성화되어 어느 것이 쓰이는지 불명확하면 먼저 충돌을 설명한다.

## 실행 중인 작업과 자료 보호

- 현재 대화, 제공된 작업 상태와 사용자가 알려준 상태에서 수집·Excel 최종 저장·로컬 앱 다운로드가 진행 중인지 확인한다. 진행 중이면 작업 완료 후 갱신하도록 안내하고 코드를 바꾸지 않는다. 실행 중일 수 있다는 구체적 근거가 있는데 완료 여부를 확인할 수 없으면 그 작업의 완료 여부부터 확인한다. 업데이트를 위해 실행 중인 작업·앱을 종료하거나 자동으로 재시작하지 않는다.
- [로컬 설정 계약](../../references/local-settings.md)을 따라 기존 `setup_collection.py status`를 Codex 제공 Python으로 읽기 전용 실행할 수 있다. 제공 Python은 `load_workspace_dependencies`에서 확인한다. `busy`이면 갱신을 보류하고 잠금을 삭제하지 않는다. 손상 설정·복구 필요 상태는 보존하고 문제를 안내한다. **잠금이 없다는 사실만으로 수집 탐색이나 다운로드가 끝났다고 판단하지 않는다.** 탐색 중에는 공통 잠금을 유지하지 않는다. 제공 도구로 확인하지 못한 다른 대화나 앱의 실행 상태를 확인했다고 보고하지 않는다.
- 초기 설정 `init`, 수집/복구/다운로드 명령을 호출하지 않는다. 수집 위치 설정, `accounts.xlsx`, 결과 Excel, `_work` 기록, 미디어, 앱 DB·토큰은 갱신 대상이 아니다. 사용자 자료를 이동·초기화하거나 예제 계정을 다시 넣지 않는다. 브라우저·Threads URL에도 접속하지 않는다.

## 갱신과 확인

아래 명령은 Codex가 확인한 CLI 실행 파일로 직접 실행한다. 경로·인수는 사용 중인 셸에 맞게 안전하게 전달한다.

```text
codex plugin marketplace upgrade threads-collector --json
codex plugin list --marketplace threads-collector --available --json
codex plugin add threads-collector@threads-collector --json
codex plugin list --marketplace threads-collector --json
```

1. `marketplace upgrade`에는 항상 대상 이름을 넣는다. 이름을 생략하여 모든 marketplace를 갱신하지 않는다. 실패하면 설치/제거로 우회하지 않고 오류와 기존 설치 유지 여부를 보고한다.
2. 갱신된 목록의 원본·브랜치와 plugin manifest 이름·버전을 확인한다. 원본 불일치나 지원하지 않는 설치 형식이면 `plugin add` 전에 중단한다. 변경이 없어도 목록 갱신만으로 설치 캐시가 갱신됐다고 단정하지 않는다.
3. 확인한 대상에만 `plugin add`를 명시적으로 실행한다. 별도 uninstall이나 캐시 수동 삭제를 먼저 수행하지 않는다. 실패 시 기존 설치·자료를 보존하고 재설치 완료로 보고하지 않는다.
4. 설치 결과와 다시 조회한 목록의 식별자·버전·실제 캐시 manifest가 일치하는지 확인한다. 결과가 부족하면 해당 확인 항목을 미확인으로 남긴다. 저장소 최신 버전, 설치된 버전, 현재 대화에 로드된 버전을 구분한다.
5. 갱신 전후 설치 버전과 결과를 짧게 보고하고 **“새 대화에서 ‘수집 플러그인 버전 확인해줘’라고 요청해주세요.”**라고 안내한다. 현재 대화의 실행 지침이 새 버전으로 바뀌었다고 주장하거나 여기서 바로 수집을 이어서 실행하지 않는다. 새 대화에서 [설치 점검](../threads-plugin-check/SKILL.md)이 실제 로드 경로와 버전을 확인해야 적용 확인이 끝난다.

같은 버전을 다시 설치했다면 ‘새 버전으로 업데이트’ 대신 ‘배포 목록 갱신 및 같은 버전 설치 확인’으로 보고한다. 이 명시적 갱신 절차를 상시 자동 업데이트나 Windows 실기 검증 완료로 표현하지 않는다. 사용자 자료를 변경하는 명령을 실행하지 않았다는 사실과 파일 전체 보존을 실제 비교 검증했다는 사실도 구분한다.
