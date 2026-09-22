---
name: threads-plugin-check
description: Check the installed Threads Collector plugin version, loaded skills, and collection prerequisites without opening Threads or collecting data. Use for Threads 플러그인 설치 확인, 버전 확인, or 수집 준비 상태 점검.
---

# Threads 플러그인 설치 점검

설치 후 새 대화에서 패키지 버전과 필요한 도구의 준비 상태만 확인한다. 수집·다운로드를 시작하거나 브라우저 탭을 열지 않는다. 설치 여부, 현재 대화 로드 여부, 도구 노출, 실제 동작 검증은 별도 상태다.

1. 현재 대화의 사용 가능한 스킬 목록에서 이 스킬과 `threads-setup`, `threads-collect`의 실제 경로를 확인한다. 이름을 안다는 이유로 설치·로드 성공을 선언하지 않는다. 사용자가 소스 파일을 직접 읽으라고 했다면 `소스 점검`으로 보고하며 설치 성공과 구분한다.
2. 이 스킬이 속한 패키지의 [manifest](../../.codex-plugin/plugin.json)를 읽어 이름·버전을 보고한다. 다른 개발 폴더나 저장소의 최신 버전으로 대체하지 않는다. 실제 로드 경로가 확인되지 않으면 `현재 대화 버전 미확인`으로 남긴다. 설치 캐시와 현재 대화의 정보가 다르면 새 대화에서 다시 확인하도록 안내한다.
3. 현재 제공된 도구 설명/스킬 목록에서 Codex 내부 브라우저(`mcp__cua_repl`), `spreadsheets` 스킬, 로컬 파일을 읽고 저장할 수 있는 도구가 있는지만 확인한다. 이 점검에서 브라우저 도구를 호출하거나 의존성을 자동 설치하지 않는다. 없으면 필요한 구성 요소를 구체적으로 안내하며 외부 브라우저·직접 HTTP 수집으로 대체하지 않는다.
4. 포함된 [초기 설정 지침](../threads-setup/SKILL.md), [설정 helper](../../scripts/setup_collection.py), [수집 지침](../threads-collect/SKILL.md), 예제 행이 있는 [계정 양식](../threads-collect/assets/accounts.xlsx)의 파일 존재를 확인한다. 이 설치 점검만 요청받았을 때 사용자 Excel·위치 설정을 탐색하거나 수정하지 않는다. 실제 초기 설정에서 수집 위치를 한 번 기억하고 수집 요청 시 재사용한다. 패키지 업데이트로 위치 설정을 초기화하지 않는다.
5. `패키지 이름/확인한 버전`, `현재 대화 스킬 로드 근거`, `필수 도구 노출`, `실제 수집·다운로드 실행 여부`를 짧게 보고한다. 도구 이름이 보이는 것을 Windows 내부 브라우저의 실제 동작이나 Threads 로그인 확인이라고 표현하지 않는다.

현재 패키지는 초기 설정·수집·임시 JSONL과 Excel 원본만 포함한다. [수집 원본 helper](../../scripts/collection_source.py)의 존재·버전을 확인한다. 다운로드 실행기·Pillow·ffprobe·다운로드 DB는 로컬 앱의 책임이며 플러그인 설치 조건이 아니다. Windows 실제 검증을 추정하지 않는다. 설치 확인을 이유로 테스트 요청이나 URL 유효성 검사(GET/HEAD)를 보내지 않는다. 초기 설정/수집에서 이 지침을 내부 단계로 적용해도 별도 점검 명령을 사용자에게 다시 요구하지 않는다.
