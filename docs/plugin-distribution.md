# 수집 플러그인 GitHub 배포

2026-09-29. 수집 플러그인은 **[ilseong-xofl/threads-collector](https://github.com/ilseong-xofl/threads-collector)** 전용 공개 저장소로 배포한다. 앱은 별도 Setup.exe를 사용한다. 아무것도 설치되지 않은 Windows 최종 시험 → 실제 사용자 1명 라이브 시험 → 일반 배포 순서이며, 실제 Windows 설치·수집·파일럿 시험은 아직 남아 있다.

## 설치와 업데이트

- 고정 주소: `https://github.com/ilseong-xofl/threads-collector`
- Git 추적 브랜치: `main`
- marketplace: `threads-collector`
- plugin ID: `threads-collector@threads-collector`
- 현재 버전: `0.1.0+codex.20260929065345`

사용자는 Codex 대화에 GitHub README를 확인하고 설치해 달라고 요청한다. Codex가 앱 제공 실행기로 공식 Git marketplace 등록과 플러그인 설치를 수행한다. 사용자가 터미널·Git·Node·Python·Excel 프로그램을 설치하거나 저장소를 clone하는 절차는 없다. 기존 개인 목록은 보존하고 새 대화에서 실제 로드 경로와 버전을 확인한다. 명령과 사용자 복사 문장은 [배포 README](../distribution/github/README.md)에 있다.

`수집 플러그인 업데이트해줘` 요청에는 새 `threads-update` 스킬을 사용한다. 같은 Git 원본·main·사용자 Codex 홈을 확인한 뒤 해당 목록만 upgrade하고 해당 플러그인만 add한다. 설치 캐시와 현재 대화 버전을 구분하며 완료 후 새 대화가 필요하다. 개인 계정의 즉시 자동 업데이트를 보장하지 않는다. 로컬 앱 업데이트와는 별개다.

수집·다운로드가 실행 중이면 갱신하지 않는다. 수집 위치 설정·accounts.xlsx·결과 Excel·임시 기록·앱 DB·미디어·토큰은 갱신 대상이 아니다. 이전 personal/threads-collector-testing 또는 다른 Git 원본을 임의로 제거하거나 전환하지 않는다. 최초 설치도 같은 저장소인지와 main 추적을 함께 확인한다.

## 개발과 배포

플러그인 원본은 이 프로젝트의 `plugins/threads-collector/`에서 관리한다. 전용 배포 저장소를 별도의 개발 원본으로 동시에 수정하지 않는다. 배포 README·marketplace·CI 템플릿은 `distribution/github/`에 둔다.

개발자 절차:

1. 원본 플러그인을 수정하고 Plugin Creator의 cachebuster로 버전을 갱신한다.
2. manifest·스킬 형식과 관련 수집 테스트를 검사한다.
3. `python3 -B scripts/export-collector-repo.py /별도/threads-collector`로 명시적 파일 목록만 내보낸다.
4. 배포 저장소의 `python3 -B scripts/verify-distribution.py`와 `python3 -B -m unittest discover -s tests`를 실행하고 Git diff를 검토한다.
5. 배포 저장소 main에 커밋·push하고 해당 버전 태그를 남긴다. Mac·Windows CI를 확인한다.
6. 서로 다른 두 버전으로 설치 캐시 갱신과 사용자 자료 보존을 확인하고 새 대화 적용은 별도 확인한다.

배포에는 플러그인·빈 Excel 양식·설치 안내·검증 코드·56개 합성 테스트와 파일별 해시만 들어간다. 실제 계정 목록·수집 Excel·JSONL·미디어·DB·토큰·앱 런타임·개발 저장소 Git 이력을 복사하지 않는다. exporter는 알 수 없는 기존 파일이 있으면 중단하고, 검증 스크립트는 누락·변경·추가 파일을 검사한다. 배포 저장소에 사용자 자료를 넣지 않는다.

`scripts/package-collector.py`와 `distribution/collector/`는 이전 오프라인 ZIP 형식 확인용으로 보존한다. 현재 최종 설치 경로는 GitHub이며 ZIP의 `threads-collector-testing`은 업데이트 스킬 대상이 아니다.

## 검증 범위

실제 검증 결과와 커밋·CI 링크는 [최신 체크포인트](checkpoint-2026-09-29.md)의 GitHub 배포 항목을 따른다. Mac CLI 설치·업데이트, Mac/Windows 합성 테스트와 깨끗한 Windows 실제 설치·새 대화 로드·수집은 각각 다른 확인 항목이다. 필요한 Codex 제공 Python·Git 기능·내부 브라우저가 없는 경우 최종 시험 실패로 기록하며 수동 개발 도구 설치로 감추지 않는다.

## 사용자 가이드

1. [최종 테스트 1 — Codex·플러그인 설치·설정·계정 등록·수집·업데이트](windows-collector-test.md)
2. [최종 테스트 2 — 로컬 앱 설치·세 연결 설정·다운로드·등록·원글·댓글 업로드](windows-install-test.md)

계정당 최신 적격 미디어 원글 최대 2개와 기존 대기는 유지한다. 수집 플러그인은 Excel 원본 저장까지 담당하며 다운로드·SQLite·Pillow는 앱이 소유한다. 공통 공개 README에는 실제 수집 계정을 넣지 않는다. 내부 시험용 네 프로필은 담당자의 최종 시험 가이드에만 둔다.

현재 앱 후보는 `6a35557` 소스의 0.1.0이며 자동 업데이트는 미구현이다. 플러그인 GitHub 갱신과 앱 자동 업데이트를 혼동하지 않는다. [Windows 앱 검증 기록](windows-validation.md)을 따른다.
