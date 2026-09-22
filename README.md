# Threads Media Manager

Codex 플러그인으로 Threads 게시글 정보를 수집하고, 별도 Electron 앱에서 첨부를 다운로드·관리하는 로컬 도구다. 기존 threads-bot·threads-web과 독립적이다.

**2026-09-22 소스 체크포인트:** Phase 1의 남은 작업은 사용자 요청으로 모두 보류한다. 현재 소스를 GitHub에 보관하는 범위이며, 설치 파일·Release·Windows 배포 준비 완료를 의미하지 않는다. [현재 구현과 보류 목록](docs/checkpoint-2026-09-22.md), [인계 문서](docs/handoff-local-app.md)를 먼저 확인한다.

저장소 대상은 공개 `ilseong-xofl/threads-media-manager`다. local-video-manager와 같이 소스와 향후 Releases를 같은 공개 저장소에서 관리하고, Windows 설치 앱의 자동 업데이트를 제공할 계획이다. 현재 updater 코드는 미구현이며 설치 파일·업데이트 구현·Windows 검증은 배포 단계에서 진행한다.

## 역할과 데이터

- **수집 플러그인:** accounts.xlsx → 로그인된 내부 브라우저 → 임시 JSONL → 날짜별 Excel 원본. 수집 완료에서 종료한다.
- **로컬 앱:** 영구 Excel 읽기 → 남은 첨부 다운로드 → 이미지·영상 표시·관리. 다운로드 코드와 상태 DB는 앱이 소유한다.
- **Excel:** `results/YYYY/MM/threads-YYYY-MM-DD.xlsx`이 최종 원본이다. 다음 수집 기준과 원문 정보는 이 파일에서 읽는다.
- **임시 JSONL:** 수집 중 복구용으로만 사용하고 Excel·계정 상태 저장 검증 후 정리한다. accounts.xlsx는 계정 등록 입력이다.
- **앱 상태:** `state/state.db`와 `media/`. 다운로드 이력, 편집본, 삭제 기록, 사용자 댓글 정보를 저장한다. 원문·서명 URL의 별도 사본 DB를 만들지 않으며 수집 플러그인은 이 DB를 열거나 만들지 않는다.

다운로드에는 일일 횟수 제한이 없다. 파일 사이 대기와 첫 오류 중단은 유지한다. 수집/다운로드의 활성 작업은 같은 자료 폴더 잠금을 존중한다. 앱 다운로드 오류는 앱 다운로드를 중단하며 별도 수집 요청을 금지하지 않는다. 새 Excel이 생겨도 앱의 중단·요청 소비·대기는 초기화하지 않는다.

## 현재 범위

[수집 플러그인](plugins/threads-collector/README.md)은 초기 설정·설치 점검·수집·영구 원본 저장을 제공한다. 다운로드 스킬은 제공하지 않는다.

- **다운로드:** 한 번 클릭으로 현재 미완료 게시글을 회차별 순차 처리한다. 파일·회차·계정 대기와 첫 오류 중단을 유지한다. [다운로드 계약](docs/phase-1e-download.md).
- **목록과 상세:** 완료 게시글 그리드, 이미지·영상 캐러셀, 계정·검색·등록일 필터, 12개/24개 페이지와 이어 보기. 상세에서 선택한 영상만 자동재생한다.
- **편집:** 이미지 크롭, 현재 영상 프레임 캡처, 영상 구간 자르기. 원본을 보존하고 편집본을 캐러셀에 추가한다. [편집 계약](docs/media-editing.md).
- **삭제:** 확인 후 편집본 하나 또는 게시글의 원본·편집본을 삭제한다. 게시글 삭제는 Excel에 표시하며 중단된 삭제 작업을 복구할 수 있다. [삭제 계약](docs/media-deletion.md).
- **댓글 정보:** 게시글별 캡션·링크를 로컬에 등록·수정한다. 원문·댓글 링크는 클릭 시 기본 브라우저로 연다. 실제 Threads 답글은 전송하지 않는다. [댓글 정보 계약](docs/post-comments.md).
- **ZIP:** 원본·편집본과 계정명·수집일·원문 주소·캡션을 담은 `게시글정보.txt`를 **`게시글ID.zip`**으로 내보낸다. [ZIP 계약](docs/post-export.md).

수동 중지·오류 후 다운로드 재개, 원본 변경 후 재계획, 라이브러리 이동·재연결의 완성 흐름과 Windows 검증·배포는 미완료이며 보류한다. Phase 2·3은 미구현이고, 댓글 정보와 일부 편집만 Phase 4·5에서 앞당겨 구현했다.

## Mac 개발 실행

Node 24.18.0 / pnpm 10.28.1 / Python 3.11 이상을 사용한다. 이미지 처리는 Pillow, 영상 검증·구간 편집은 PATH에서 실행 가능한 ffprobe·ffmpeg가 필요하다.

```sh
nvm use
pnpm install --frozen-lockfile
python3 -m venv .venv
.venv/bin/python -m pip install -r local-runtime/requirements.txt
pnpm start
```

앱에서 수집 폴더를 연결하거나 홈의 `.threads-media-manager/settings.json`에 저장된 위치를 읽는다. `TMM_PYTHON` 또는 프로젝트 `.venv`로 Python 실행 파일을 지정할 수 있다. 개발 검사에는 같은 Python·Pillow·ffprobe·ffmpeg 환경을 준비한 뒤 `pnpm check`를 사용한다. 자세한 격리 실행은 [앱 환경 문서](docs/phase-1c-app.md)를 참고한다.

개발과 단계별 테스트는 Mac에서 한다. 기능은 Windows도 지원하도록 구현하고, 설치 파일·자동 업데이트 배포는 최종 Windows 검증 후 진행한다. Mac 설치 파일은 배포하지 않는다.

## 문서

1. [체크포인트와 보류 범위](docs/checkpoint-2026-09-22.md)
2. [제품과 단계](docs/product-plan.md)
3. [Phase 1 설계](docs/phase-1-design.md)
4. [구현 순서](docs/implementation-plan.md)
5. [수집 원본 계약](plugins/threads-collector/references/collection-source.md)
6. [로컬 앱 다운로드 정책](docs/download-queue-policy.md)
7. [플러그인 배포](docs/plugin-distribution.md)

GitHub 소스 업로드와 설치 파일·Release·멤버 배포는 구분한다. 개인 수집 Excel·DB·미디어·세션·설정은 저장소에 포함하지 않는다.
