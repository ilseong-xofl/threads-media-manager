# Windows 개인 계정 플러그인 설치 검증

상태: 검증 절차 준비 / 2026-09-21. Windows에서 설치·새 대화 로드·브라우저 동작을 실행한 결과가 아니다. 실제 marketplace 등록, 사용자 설정 변경, 수집, 다운로드를 이 문서 작성 과정에서 수행하지 않았다.

이 절차는 **Mac에서 개발·기능 통합을 마친 뒤 최종 1G에서** 첫 Windows 개인 계정의 설치 경로를 확인하기 위한 것이다. 1A–1F의 Mac 개발 진행을 막는 조건으로 사용하지 않는다. 멤버용 설치 도우미는 아직 구현하지 않았으며 아래 PowerShell 명령 입력을 사내 멤버의 최종 사용 방식으로 삼지 않는다.

## 1. 이번 검증의 범위

- 공개하거나 회사 workspace에 배포하지 않은 로컬 패키지를 개인 계정에 설치한다.
- 대상 플러그인이 새 대화에 로드되는지와 현재 노출된 도구 목록을 확인한다.
- Threads 접속, 로그인 변경, 브라우저 스크롤, 실제 Excel 읽기·쓰기, 미디어 요청은 수행하지 않는다.
- 브라우저 도구의 이름이 노출된 것과 내부 브라우저가 실제 작동하는 것은 다르다. 후자는 별도 검증 전까지 `미검증`이다.
- 기존 `threads-excel-collector` 단독 스킬이 있으면 중복 존재를 기록한다. 임의로 삭제하거나 덮어쓰지 않는다.

## 2. 확인된 명령과 패키지 형식

현재 패키지는 plugin-creator가 만드는 `.codex-plugin/plugin.json` 호환 형식을 사용한다. 로컬 marketplace는 `.agents/plugins/marketplace.json`에 있으며 `source.path`는 marketplace 루트 기준 상대 경로다. 등록과 설치 이후에도 새 대화에서의 로드 확인이 필요하다. [공식 패키지 문서](https://developers.openai.com/plugins/build/plugins), [공식 설치 안내](https://learn.chatgpt.com/docs/plugins#install-and-use-a-plugin)

Mac 개발 환경에서 `codex-cli 0.155.1`의 `--help`로 다음 구문을 확인했다. Windows 실행 성공을 의미하지 않는다.

```text
codex plugin marketplace add <SOURCE> --json
codex plugin marketplace list
codex plugin list --marketplace <MARKETPLACE> --available --json
codex plugin add <PLUGIN@MARKETPLACE> --json
```

`codex plugin --help`에는 `validate` 명령이 없다. 개발 환경에서는 plugin-creator의 `scripts/validate_plugin.py <plugin-root>`와 skill-creator의 `scripts/quick_validate.py <skill-root>`로 파일 형식을 검증한다. 이 도구들은 설치·캐시·새 대화 로드·Windows 지원을 검증하지 않는다. Windows 멤버에게 Python을 설치해 검증 스크립트를 실행하게 하지 않는다.

## 3. Windows 검증 순서

1. Windows 버전과 아키텍처, Codex 앱 버전, 개인 계정 사용 여부를 기록한다. 이메일·토큰·쿠키는 보고서에 넣지 않는다.
2. 검증할 패키지 버전과 배포 파일 해시를 기록한다. 한글과 공백이 있는 일반 사용자 폴더에 압축을 해제한다. 기존 Excel·미디어·DB가 없는 새 검증 폴더를 쓴다.
3. Codex 앱에서 Plugins 화면이 보이는지 확인한다. CLI가 없으면 그 사실을 기록하고 중단한다. 관리자 권한 부여, 전역 PATH·보안 설정 변경, 다른 런타임 수동 설치로 문제를 숨기지 않는다.
4. 개발 담당자가 manifest의 marketplace·plugin 식별자와 상대 경로를 확인한다. 동일 marketplace 식별자가 이미 등록되어 있으면 기존 소스와 비교한 뒤 진행 여부를 판단한다. 다른 패키지의 설정을 교체하지 않는다.
5. 해당 Windows 사용자가 설치를 진행하기로 한 뒤 개발 담당자가 아래 등록 단계를 실행한다. 실제 개인 설정과 캐시에 영향을 주는 단계이므로 검증 전 자동 실행하지 않는다.
6. Codex 앱을 재시작하고 Plugins에서 해당 marketplace와 플러그인을 찾는다. 표시 이름·버전·포함 스킬이 준비한 패키지와 일치하면 설치한다. CLI 등록 성공만으로 설치 완료라고 기록하지 않는다.
7. 새 대화를 열고 설치 점검만 요청한다. 현재 대화의 플러그인·스킬 이름과 패키지 버전의 확인 근거, 브라우저 도구 노출 여부를 기록한다. 아래 점검 프롬프트를 사용한다.
8. 실제 수집·다운로드가 실행되지 않았음을 실행 기록으로 확인한다. 성공 기록의 범위는 `Windows 설치·새 대화 로드·도구 노출 확인`까지다.

개발 담당자용 PowerShell 예시다. 처음 두 명령은 버전과 도움말 확인이다. 마지막 등록 명령은 위 5단계에서만 실행한다. `<패키지 루트>`는 `.agents/plugins/marketplace.json`이 들어 있는 폴더이며 파일 자체의 경로가 아니다.

```powershell
codex --version
codex plugin marketplace add --help

$tmmPackageRoot = Read-Host '압축을 해제한 패키지 루트의 전체 경로'
$tmmPackageRoot = (Resolve-Path -LiteralPath $tmmPackageRoot).Path
$tmmCatalogPath = Join-Path $tmmPackageRoot '.agents/plugins/marketplace.json'
$tmmCatalog = Get-Content -LiteralPath $tmmCatalogPath -Raw | ConvertFrom-Json
$tmmCatalog | ConvertTo-Json -Depth 8

# 표시된 소스와 식별자를 검토하고 설치를 진행하기로 한 후 실행한다.
codex plugin marketplace add "$tmmPackageRoot" --json
codex plugin marketplace list
codex plugin list --marketplace "$($tmmCatalog.name)" --available --json
```

현재 로컬 CLI 도움말에는 `codex plugin add <PLUGIN@MARKETPLACE> --json`도 제공된다. 첫 Windows 검증에서는 앱 설치 화면을 확인하여 사용자가 겪는 경로를 검증한다. CLI 설치를 사용하더라도 새 대화의 실제 로드 확인을 생략하지 않는다.

새 대화 점검 프롬프트:

> 설치한 Threads 플러그인의 설치 상태만 확인해줘. 수집과 다운로드는 시작하지 마. 현재 대화에 로드된 플러그인과 스킬 이름, 읽을 수 있는 해당 설치 패키지의 버전 및 확인 근거를 알려줘. 현재 사용 가능한 도구 설명에서 Codex 내부 브라우저 도구가 노출되어 있는지만 확인하고, 도구를 호출하거나 탭을 열거나 로그인 상태를 조사하지 마. 소스 폴더의 버전을 실행 중인 버전으로 대신 보고하지 말고, 확인할 수 없는 값은 미확인으로 표시해줘.

## 4. 결과 기록

이 표를 복사해 실제 Windows 실행 결과를 작성한다. 아래 기본값은 성공 결과가 아니다.

| 확인 항목 | 결과 | 근거 |
|---|---|---|
| Windows / 아키텍처 / Codex 앱 버전 | 미검증 | 실제 Windows 환경 필요 |
| 개인 계정 사용 / 기존 단독 스킬 중복 | 미검증 | 계정 유형과 스킬 목록만 기록 |
| CLI 버전 / marketplace 등록 | 미검증 | 종료 코드와 대상 소스 |
| Plugins 목록 / 설치 완료 | 미검증 | UI 표시 식별자와 버전 |
| 새 대화의 플러그인·스킬 로드 | 미검증 | 실제 로드된 항목의 이름 |
| 설치 패키지 / 현재 대화 버전 | 미검증 | 각 값과 별도 확인 근거 |
| 내부 브라우저 도구 노출 | 미검증 | 노출된 도구 이름 또는 미확인 사유 |
| 내부 브라우저 실제 동작 / Threads 로그인 | 미검증 | 이번 검증 범위 밖 |
| 한글·공백 경로 | 미검증 | 설치·로드 결과 |
| 기존 자료·설정 보존 | 미검증 | 대상 외 변경 없음 확인 |
| 수집 / CDN 다운로드 | 실행하지 않음 | 이 검증에서 시작하지 않음 |

도구가 누락되면 `플러그인 로드 성공 / 브라우저 도구 미제공`처럼 분리하여 기록한다. 외부 브라우저, 직접 HTTP 요청, 쿠키 추출 등으로 대체하지 않는다. 버전이 확인되지 않거나 이전 대화가 구버전을 쓰면 새 대화에서 다시 확인하고, 모호한 상태를 성공 처리하지 않는다.

## 5. 다음 단계 진입 기준

Mac의 각 개발 단계 완료는 Mac 검증으로 판단한다. Windows 개인 계정에서 설치 경로와 새 대화 로드가 확인되어야 최종 1G의 배포 경로 검증을 통과한다. 내부 브라우저의 실제 가용성, 초기 설정·Excel 저장·수집·다운로드·Electron 화면도 1G의 Windows 전체 기능 검증에서 확인한다. Mac의 패키지 형식 검증 결과로 Windows 결과를 대체하지 않는다.

이번 검증에서는 업데이트·자동 설치 도우미·다운로드 실행기를 통과 처리하지 않는다. 임시 설치 제거가 필요하면 대상 식별자를 확인하여 Plugins UI에서 해당 패키지만 제거한다. 기존 단독 스킬, 개인 Excel·미디어·상태 파일, 다른 marketplace를 함께 지우지 않는다.
