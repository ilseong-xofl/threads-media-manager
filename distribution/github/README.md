# Threads 수집 플러그인

Codex 내부 브라우저에서 Threads 게시글 정보를 수집하고 날짜별 Excel 원본으로 저장합니다. 기본 수집량은 **요청마다 활성 계정당 최신 적격 미디어 원글 최대 2개**입니다. 이미지·영상 다운로드와 게시글·댓글 업로드는 별도 **Threads Media Manager** 앱에서 진행합니다.

배포 주소는 **https://github.com/ilseong-xofl/threads-collector** 입니다. 같은 주소에서 설치와 업데이트를 제공합니다. 현재는 깨끗한 Windows PC에서 최종 검증하는 단계입니다.

## 처음 설치하기

1. [공식 Windows 설치 안내](https://learn.chatgpt.com/docs/windows/windows-app)를 따라 데스크톱 앱을 설치하고 본인의 ChatGPT 계정으로 로그인합니다. 설치 화면에서는 ChatGPT 데스크톱 앱으로 표시될 수 있습니다. 앱 안의 **Codex 로컬 작업**을 사용합니다.
2. 아래 문장을 Codex의 새 대화에 붙여넣습니다. 사용자가 터미널을 열거나 GitHub 계정을 만들 필요는 없습니다.

```text
https://github.com/ilseong-xofl/threads-collector 의 README.md를 확인하고, 이 주소의 Threads 수집 플러그인을 설치해줘. 앱에서 제공하는 Codex 실행기로 threads-collector marketplace를 등록하고 threads-collector@threads-collector를 설치해줘. 기존 personal 목록·다른 플러그인·사용자 자료는 유지해줘. 내가 터미널이나 개발 도구를 직접 설치·실행하지 않는 방식으로 진행하고, 필요한 앱 제공 도구가 없으면 정확히 알려줘. 설치한 소스와 버전을 확인한 다음 새 대화를 열도록 안내해줘. 아직 수집하지 마.
```

3. 설치가 확인되면 **새 대화**를 엽니다. 다음 문장으로 초기 설정을 요청하고, 안내에 따라 수집 자료를 보관할 폴더를 선택합니다.

```text
Threads 수집 플러그인의 $threads-setup으로 처음 설정해줘. 실제 로드된 플러그인 버전과 필요한 도구를 확인하고, 수집 폴더와 accounts.xlsx를 준비해줘. 아직 수집하지 마.
```

Spreadsheets 기능이 필요합니다. 기능이 없다고 안내받으면 Codex의 Plugins에서 **Spreadsheets**를 설치하고 새 대화에서 다시 요청합니다. Microsoft Excel 프로그램 설치는 필요하지 않습니다. 제공 Python·내부 브라우저·파일 도구가 없으면 준비 미완료이며, 수동 개발 환경 설치로 우회하지 않습니다.

## 계정 등록과 수집

수집할 프로필 URL을 아래 문장 뒤에 붙여넣습니다.

```text
수집 폴더의 accounts.xlsx에서 sample 예제를 삭제하고 아래 프로필을 기존 계정과 중복 없이 순서대로 등록해줘. 기존 계정 정보와 수집 이력은 유지해줘. 활성 계정 목록을 보여주고 아직 수집하지 마.
[Threads 프로필 URL]
```

Codex 내부 브라우저에서 Threads를 열고 본인이 로그인합니다. 일반 브라우저의 로그인과 다를 수 있습니다. 비밀번호·인증번호·쿠키를 채팅에 입력하지 않습니다. 로그인 후 다음처럼 요청합니다.

```text
Threads 수집 플러그인의 $threads-collect로 수집 시작해줘.
```

4계정이면 최대 8개입니다. 기존 수집 글, 대상 부족, 제한 또는 불완전 첨부 때문에 결과는 더 적을 수 있습니다. 계정 사이·탐색 대기는 유지합니다. 완료 후 계정별 저장 수와 결과 Excel을 확인하고, 같은 수집 폴더를 로컬 앱에서 선택합니다.

## 업데이트하기

수집과 다운로드가 끝난 상태에서 Codex에 **“수집 플러그인 업데이트해줘”**라고 요청합니다. `$threads-update` 스킬이 설치된 경우 이 절차를 수행합니다. 자세히 지정하려면 아래 문장을 사용합니다.

```text
https://github.com/ilseong-xofl/threads-collector 의 Threads 수집 플러그인을 업데이트해줘. threads-collector marketplace만 갱신하고 threads-collector@threads-collector를 최신 배포 버전으로 설치해줘. 기존 수집 폴더 설정·accounts.xlsx·결과 Excel·앱 자료를 유지하고 다른 플러그인은 바꾸지 마. 변경 전후 설치 버전을 알려주고, 적용 확인을 위해 새 대화를 열도록 안내해줘. 아직 수집하지 마.
```

완료 후 **새 대화**에서 다음처럼 확인합니다.

```text
$threads-plugin-check로 실제 로드된 버전을 확인하고, 기존 수집 폴더와 계정이 유지되어 있는지 확인만 해줘. 아직 수집하지 마.
```

GitHub에 새 버전을 올리는 것만으로 모든 설치본이 즉시 자동 업데이트된다고 보장하지 않습니다. 안내받은 새 버전은 위 요청으로 적용합니다. 수집 위치·계정·결과 파일은 플러그인 설치 캐시와 분리되어 보존됩니다. 기존 자료가 누락되면 새로 초기화하지 말고 담당자에게 알립니다.

## 설치를 수행하는 Codex를 위한 지침

이 절차는 위 사용자 요청을 받은 Codex가 수행합니다. 사용자에게 터미널 명령 입력을 요구하지 않습니다.

- 대상 저장소: `https://github.com/ilseong-xofl/threads-collector.git`
- marketplace: `threads-collector`
- plugin ID: `threads-collector@threads-collector`
- marketplace 파일: `.agents/plugins/marketplace.json`
- 플러그인 경로: `plugins/threads-collector`

앱이 제공하는 Codex 실행기와 현재 사용자의 Codex 설정 위치를 확인합니다. 별도 임시 설정 위치에 설치하고 사용자 설치라고 보고하지 않습니다. 설정 파일에 인증 정보가 포함될 수 있으므로 내용 전체를 출력하지 않습니다. 필요한 실행기나 내부 Git 기능이 없다면 부족한 항목을 알리고 멈춥니다. 사용자에게 Git·Python·Node·CLI 수동 설치를 요구하거나 임의의 설치 스크립트를 실행하지 않습니다.

[공식 명령 문서](https://learn.chatgpt.com/docs/developer-commands)의 다음 기능을 사용합니다. `codex`는 실제 확인한 앱 제공 실행기로 대체합니다.

```text
codex plugin marketplace list --json
codex plugin marketplace add https://github.com/ilseong-xofl/threads-collector.git --ref main --json
codex plugin add threads-collector@threads-collector --json
```

먼저 기존 목록을 확인합니다. 같은 이름이 다른 소스를 가리키면 덮어쓰지 말고 충돌을 보고합니다. 같은 저장소가 이미 등록되어 있으면 추적 ref도 `main`인지 확인한 뒤 중복 등록을 생략합니다. 다른 브랜치·태그·커밋으로 고정된 등록은 업데이트 대상과 다르므로 그대로 설치하지 말고 전환이 필요한 이유를 보고합니다. 다른 소스의 동명 플러그인이 활성화되어 있으면 중복 로드 가능성을 알리고 전환 범위를 확인합니다. 기존 `personal` 또는 시험용 목록을 통째로 삭제하지 않습니다.

업데이트는 대상 목록을 갱신한 뒤 해당 플러그인을 다시 설치합니다.

```text
codex plugin marketplace upgrade threads-collector --json
codex plugin add threads-collector@threads-collector --json
codex plugin list --marketplace threads-collector --json
```

갱신 실패 시 기존 설치본을 제거하지 않습니다. 설치/업데이트 결과에서 소스·설치 버전·활성 상태를 확인합니다. 새 대화에서 실제 로드 버전을 다시 확인하기 전에는 적용 완료로 단정하지 않습니다. GitHub 원본을 읽은 것, 목록을 등록한 것, 플러그인을 설치한 것, 새 대화에 스킬이 로드된 것을 구분해 보고합니다.

개인용 UI의 GitHub 주소 입력 버튼이나 위치를 추정하지 않습니다. [공식 Git marketplace 방식](https://developers.openai.com/plugins/build/plugins)을 사용하되, 새 Windows에서 앱 제공 실행기만으로 설치·업데이트가 되는지는 최종 시험에서 확인해야 합니다.

## 배포 순서

**깨끗한 Windows 최종 시험 → 실제 사용자 1명 라이브 시험 → 일반 사용자 배포** 순서로 진행합니다. 저장소 공개와 설치 경로 준비는 Windows 실기 통과나 파일럿 완료를 의미하지 않습니다.
