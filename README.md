# Threads Media Manager

Codex 플러그인으로 Threads 게시글 정보를 수집하고, Electron 앱에서 다운로드·편집·등록 및 Threads API 게시를 처리하는 로컬 도구다. 기존 threads-bot·threads-web과 독립적이다.

**2026-09-29 기능 개발 완료:** Threads 계정·파일 서버 연결, 게시글·텍스트 댓글 API 업로드, 최신 5개 게시글 통계, 수집·등록 독립 삭제와 영상 음소거를 구현했다. Mac에서 실제 영상·이미지 혼합 게시글 1건과 직접 답글 1건의 등록, 통계 수신을 확인했다. 전체 검증 결과와 남은 Windows 설치·자동 업데이트 작업은 [최신 체크포인트](docs/checkpoint-2026-09-29.md)에 정리한다.

저장소 대상은 공개 `ilseong-xofl/threads-media-manager`다. local-video-manager와 같이 소스와 향후 Releases를 같은 공개 저장소에서 관리하고, Windows 설치 앱의 자동 업데이트를 제공할 계획이다. Windows 설치 후보는 GitHub Actions에서 런타임을 포함해 생성·검사한다. 자동 업데이트는 아직 미구현이다. [Windows 자동 검증과 잔여 실기 항목](docs/windows-validation.md)을 따른다.

## 역할과 데이터

- **수집 플러그인:** accounts.xlsx → 로그인된 내부 브라우저 → 임시 JSONL → 날짜별 Excel 원본. 수집 완료에서 종료한다.
- **로컬 앱:** 영구 Excel 읽기 → 남은 첨부 다운로드 → 이미지·영상 표시·관리. 다운로드 코드와 상태 DB는 앱이 소유한다.
- **Excel:** `results/YYYY/MM/threads-YYYY-MM-DD.xlsx`이 최종 원본이다. 다음 수집 기준과 원문 정보는 이 파일에서 읽는다.
- **임시 JSONL:** 수집 중 복구용으로만 사용하고 Excel·계정 상태 저장 검증 후 정리한다. accounts.xlsx는 계정 등록 입력이다.
- **앱 상태:** `state/state.db`와 `media/`. 다운로드 이력, 편집본, 삭제 기록, 사용자 댓글 정보, 등록 게시글의 캡션·선택 미디어·순서를 저장한다. 원문·서명 URL의 별도 사본 DB를 만들지 않으며 수집 플러그인은 이 DB를 열거나 만들지 않는다.

다운로드에는 일일 횟수 제한이 없다. 파일 사이 대기와 첫 오류 중단은 유지한다. 수집/다운로드의 활성 작업은 같은 자료 폴더 잠금을 존중한다. 앱 다운로드 오류는 앱 다운로드를 중단하며 별도 수집 요청을 금지하지 않는다. 새 Excel이 생겨도 앱의 중단·요청 소비·대기는 초기화하지 않는다.

## 현재 범위

[수집 플러그인](plugins/threads-collector/README.md)은 초기 설정·설치 점검·수집·영구 원본 저장을 제공한다. 다운로드 스킬은 제공하지 않는다. 설치·업데이트는 [전용 GitHub 저장소](https://github.com/ilseong-xofl/threads-collector)를 사용한다. 깨끗한 Windows의 최종 시험은 [수집 가이드](docs/windows-collector-test.md)와 [로컬 앱 가이드](docs/windows-install-test.md) 순서로 진행한다.

- **다운로드:** 한 번 클릭으로 현재 미완료 게시글을 회차별 순차 처리한다. 파일·회차·계정 대기와 첫 오류 중단을 유지한다. [다운로드 계약](docs/phase-1e-download.md).
- **목록과 상세:** 완료 게시글 그리드, 이미지·영상 캐러셀, 계정·검색·등록일 필터, 12개/24개 페이지와 이어 보기. 상세에서 선택한 영상만 자동재생한다.
- **편집:** 이미지 크롭, 현재 영상 프레임 캡처, 영상 구간 자르기와 음소거. 원본을 보존하고 편집본을 캐러셀에 추가한다. [편집 계약](docs/media-editing.md).
- **삭제:** 수집과 등록을 개별 삭제한다. 어느 한쪽에 남아 있으면 선택하지 않은 원본을 포함한 전체 미디어를 유지하고, 양쪽 모두 없어지는 마지막 삭제에서 파일을 정리한다. 중단된 삭제는 저널로 복구하며 실제 Threads 게시글과 API 이력은 유지한다. [삭제 계약](docs/media-deletion.md).
- **댓글 정보:** 등록 게시글의 상세 화면에서 댓글 캡션·링크를 로컬에 등록·수정한다. 원문·댓글 링크는 클릭 시 기본 브라우저로 연다. 저장한 댓글은 별도 API 업로드 버튼으로 앱에서 게시한 원글의 직접 답글로 전송한다. [댓글 정보 계약](docs/post-comments.md).
- **ZIP:** 원본·편집본과 계정명·수집일·원문 주소·캡션을 담은 `게시글정보.txt`를 **`게시글ID.zip`**으로 내보낸다. [ZIP 계약](docs/post-export.md).
- **게시글 등록:** 한 원글에서 미디어를 선택·정렬하고 캡션과 함께 등록한다. 원글당 한 개를 계속 수정하며 설정의 ChatGPT 로그인 후 캡션 제안을 만들 수 있다. Windows 앱은 필요한 실행기를 포함하므로 사용자 터미널 설정이 없다. [등록 계약](docs/phase-2-registration.md).

- **API 게시:** 설정에서 API 토큰과 파일 서버 연결 코드를 OS 암호화 저장한다. 등록 상세에서 확인 후 게시하며 진행 중에는 화면을 잠근다. 원격 ID를 저장하고 성공 시 목록·상세의 등록 완료·댓글 완료 배지를 즉시 갱신한다. 결과 불명 요청은 자동 재전송하지 않는다. [API 계약](docs/phase-3-threads-api.md).
- **통계:** 앱에서 현재 계정으로 게시한 최신 5개 원글의 조회·좋아요·댓글 수를 확인한다. 앱 시작 시 오늘 미조회이면 백그라운드에서, 계속 켜져 있으면 오전 10시에 조회한다. 설정에서 수동 조회할 수도 있으며 게시 직후에는 조회하지 않는다.
- **알림:** 성공·실패·입력 오류는 중앙 상단 토스트로 표시한다. 게시글·댓글 업로드와 수동 통계 조회 중에는 잠금 레이어로 중복 조작을 막는다.

비정상 종료 후 다운로드 복구·재개, 라이브러리 재연결과 DB 백업·복원도 제공한다. [다운로드 검증 기록](docs/download-recovery-verification.md)을 참고한다. 영상 비율 크롭·댓글 이미지·자동 응답은 현재 기능에 포함하지 않는다. Windows 설치 파일·의존성 번들은 자동 검증 대상으로 구성했다. 자동 업데이트와 실제 설치·UI 검증은 남아 있다.

## ChatGPT 연결과 AI 캡션

설정 → **ChatGPT 로그인**을 누르고 기본 브라우저에서 본인 계정으로 로그인한다. 연결 후 앱에서 AI 캡션을 생성한다. 로그인 취소·로그아웃·연결 상태 재확인은 같은 설정 화면에서 제공한다. 계정의 Codex 사용 권한과 사용량 한도가 적용된다.

Windows 설치 앱에는 검증 버전의 실행기를 함께 포함하며 Node/npm이나 터미널 설치를 요구하지 않는다. Mac 개발 앱도 전역 Codex 대신 앱 전용 실행기를 사용하며 `pnpm start`가 고정 버전의 공식 Mac 파일을 자동 준비한다. 인증정보는 앱 전용 위치에서 OS 보안 저장소를 사용해 관리하고 작업 폴더·DB 백업에 넣지 않는다. 새 PC에서는 다시 로그인한다. 기존 ChatGPT/Codex 로그인과 분리한다. 구현 및 검증 경계는 [ChatGPT 연결 계약](docs/chatgpt-connection.md)을 따른다.

## Mac 개발 실행

Node 24.18.0 / pnpm 10.28.1 / Python 3.11 이상을 사용한다. 이미지 처리는 Pillow, 영상 검증·구간 편집은 PATH에서 실행 가능한 ffprobe·ffmpeg가 필요하다.

```sh
nvm use
pnpm install --frozen-lockfile
python3 -m venv .venv
.venv/bin/python -m pip install -r local-runtime/requirements.txt
pnpm start
```

앱에 기억된 작업 폴더가 없으면 최초 실행 때 폴더 선택창이 자동으로 열린다. 수집 플러그인의 `.threads-media-manager/settings.json`은 선택창의 기본 위치로만 참고하며, 선택한 경로는 앱의 `view-settings.json`에 기억한다. 이후 변경은 **설정 → 폴더 재연결**에서 처리한다. 처음 선택을 취소하면 빈 화면의 설정 열기로 다시 선택할 수 있다. `TMM_PYTHON` 또는 프로젝트 `.venv`로 Python 실행 파일을 지정할 수 있다. 개발 검사에는 같은 Python·Pillow·ffprobe·ffmpeg 환경을 준비한 뒤 `pnpm check`를 사용한다. 자세한 격리 실행은 [앱 환경 문서](docs/phase-1c-app.md)를 참고한다.

개발과 단계별 테스트는 Mac에서 한다. 기능은 Windows도 지원하도록 구현하고, 설치 파일·자동 업데이트 배포는 최종 Windows 검증 후 진행한다. Mac 설치 파일은 배포하지 않는다.

## 문서

1. [현재 소스 체크포인트](docs/checkpoint-2026-09-29.md) / [다운로드 복구 계약](docs/download-completion-plan.md)
2. [제품과 단계](docs/product-plan.md)
3. [Phase 1 설계](docs/phase-1-design.md)
4. [구현 순서](docs/implementation-plan.md)
5. [수집 원본 계약](plugins/threads-collector/references/collection-source.md)
6. [로컬 앱 다운로드 정책](docs/download-queue-policy.md)
7. [플러그인 배포](docs/plugin-distribution.md)

GitHub 소스 업로드와 설치 파일·Release·멤버 배포는 구분한다. 개인 수집 Excel·DB·미디어·세션·설정은 저장소에 포함하지 않는다.
