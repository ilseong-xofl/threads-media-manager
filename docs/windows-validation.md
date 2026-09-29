# Windows 자동 검증과 설치 후보

GitHub Actions의 `CI`는 push·PR·수동 실행에서 Mac과 Windows Server 2022 x64를 각각 검사한다. 설치 후보는 GitHub Actions artifact로 14일 보관한다. 현재 버전은 `0.1.1`이며 자동 업데이트 코드를 포함한다. 후보 artifact와 공개 Release 게시는 구분하며 [Release 계약](windows-release.md)을 따른다.

## 자동으로 확인하는 범위

1. 고정 Node·pnpm으로 lint, TypeScript, 전체 TypeScript/Python 테스트, 포맷 검사.
2. Windows에서는 앱에 포함할 Python 3.13.15·Pillow 12.3.0·ffmpeg/ffprobe로 검사한다. 영상 도구가 없어서 관련 테스트를 건너뛰지 않도록 먼저 실행을 확인한다.
3. Electron Forge와 Squirrel.Windows로 `ThreadsMediaManager-win32-x64-Setup.exe`, `RELEASES`, `*-full.nupkg` 생성.
4. 패키지의 ASAR 밖 `resources/runtime`에서 Python·Pillow·SQLite·pHash·영상 생성/검증·한글/일본어/공백 경로를 오프라인 합성 자료로 확인한다. 이 검사는 개발 PC용 Python·ffmpeg를 PATH에서 제외한다.
5. 산출물 SHA-256과 `verification.json`을 저장한다. 검사 결과에는 설치 파일 실제 실행 및 자동 업데이트가 미검증임을 별도로 기록한다.

워크플로: [CI](../.github/workflows/ci.yml). GitHub 저장소 **Actions → CI → 성공한 실행 → Artifacts**에서 같은 커밋의 설치 후보를 받는다. 기존 자료·토큰 없이 생성하며 서명하지 않은 내부 검수용이다.

## 2026-09-29 자동 업데이트 포함: 0.1.1

- LVM과 같은 update-electron-app 3.3.0 + ElectronPublicUpdateService + 공개 GitHub Releases를 사용한다. Windows 설치 앱만 시작 10초 후 및 1시간 간격으로 확인한다.
- 백그라운드 다운로드 후 나중에/지금 재시작을 선택한다. 다운로드·등록 저장·게시·댓글·캡션·DB 관리·열린 작성/설정 화면이 있으면 보류하고 재시작 직전 다시 확인한다.
- `verify:windows`가 RELEASES SHA-1/size, full.nupkg 앱 ID/버전/x64, ASAR 내부 버전·GitHub 업데이트 대상과 알려진 인증/사용자 파일명을 검사한다. 배포에 필요한 5개 파일을 함께 게시한다.
- Mac 개발 앱은 업데이트 네트워크 요청을 하지 않는다. Windows는 서명 없이 배포하며 설치 경고가 나올 수 있다. 코드 서명을 기능 구현의 필수 조건으로 두지 않는다.
- 최초 자동 업데이트 지원 설치본은 0.1.1이다. 기존 0.1.0은 한 번 새 Setup.exe로 설치해야 한다. 0.1.1보다 높은 버전과의 실제 교체·재실행·자료 보존은 Windows 사용자 시험으로 확인한다. 최신 실행 결과는 체크포인트와 GitHub Actions에서 확인한다.

## 2026-09-29 이전 설치 후보: 앱 전용 Codex 포함

- 검증 소스: `6a355572dcea4a3d6ff12d54d27f9a1ccfa2ebc9`, 앱 버전 **0.1.0 / Windows x64**.
- [수동 CI 실행](https://github.com/ilseong-xofl/threads-media-manager/actions/runs/36528830606): Windows·Mac 모두 성공. 양쪽 TypeScript **36개 파일 / 1,084개**, 린트·타입·포맷 통과.
- Python: Windows **524개 통과·4개 제외**(전체 528개), Mac **528개 통과**. Windows에서 제외한 것은 기존 POSIX 신호 테스트 2개와 Mac 실행 권한 테스트 2개다.
- 설치 파일 생성과 패키지 내부 Python·Pillow·SQLite·pHash·영상 처리·다국어 경로 검사를 통과했다. 새 Codex CLI **0.158.0**의 포함 파일 **48개**를 검증하고, 사용자 Node/Python/Codex 경로·인증을 제외한 환경에서 버전 실행과 새 전용 홈의 미로그인 상태를 확인했다. 모델 요청은 하지 않았다.
- [최신 설치 후보](https://github.com/ilseong-xofl/threads-media-manager/actions/runs/36528830606/artifacts/11016097568): Setup.exe, RELEASES, full.nupkg, SHA256SUMS.txt, verification.json. **2026-10-13**까지 보관한다. 이전 후보 대신 이 커밋의 파일을 사용한다.
- Windows job **15분 3초**: 설치 파일 생성 **3분 2초**, 패키지 검사 **2초**, Python 전체 검사 약 **10분**. Mac job **1분 48초**.
- 다음은 사용자의 Windows PC에서 진행하는 설치·실제 로그인·캡션 생성·자료 이전·재실행 확인이다. [터미널 없이 진행하는 설치 테스트](windows-install-test.md)를 따른다. 이 후보는 서명 없는 내부 검수용이며 자동 업데이트는 아직 미구현이다. 공개 Release를 만들지 않았다.

## 2026-09-29 이전 검증 결과

- 검증한 소스 커밋: `b1f9f87ad571a1b4c071bd1cdb8096b2cba00c1a`.
- [GitHub CI 실행](https://github.com/ilseong-xofl/threads-media-manager/actions/runs/36523558901)에서 Windows와 Mac 모두 성공했다.
- Windows: TypeScript **1,042개 통과**, Python **521개 통과·POSIX 종료 신호 테스트 2개 제외**(총 523개). Mac: TypeScript **1,042개**, Python **523개** 통과. 양쪽 린트·타입·포맷 검사 통과.
- 내장 Python **3.13.15**, Pillow **12.3.0**, SQLite **3.50.4**로 pHash·영상 처리·한글/일본어/공백 경로 검사를 통과했다.
- [설치 후보 artifact](https://github.com/ilseong-xofl/threads-media-manager/actions/runs/36523558901/artifacts/11013967009): Setup.exe, RELEASES, full.nupkg, SHA256SUMS.txt, verification.json. 2026-10-13까지 보관한다. 공개 Release는 생성하지 않았다.
- Windows job **18분 51초**: 설치 후보 생성 **2분 9초**, 패키지 실행기 검사 **2초**, Python 전체 검사 **14분 45초**. Mac 전체 검사는 **1분 38초**다.
- Setup.exe 실제 실행·UI 조작·OS 암호화·설치/제거·자동 업데이트는 이 결과에 포함하지 않는다. 자동 업데이트 코드는 아직 미구현이다.

### local-video-manager와 비교한 운영 차이

2026-09-09의 [일반 CI](https://github.com/ilseong-xofl/local-video-manager/actions/runs/34299695084)와 [설치 후보 실행](https://github.com/ilseong-xofl/local-video-manager/actions/runs/34299713332)을 확인했다. 기준 프로젝트는 push/PR의 검사·앱 패키지 생성과 수동 실행의 설치 후보 생성을 분리한다. 일반 Windows `pnpm check`는 17초, 수동 설치 후보 job은 5분 57초였으며 별도 Python 테스트가 없다. 두 프로젝트 모두 CI에서 Setup.exe를 설치하거나 GUI를 조작하는 방식은 아니다.

현재 이 프로젝트의 CI는 매 push에서 전체 검사와 설치 후보 생성을 함께 실행하므로 기준 프로젝트와 구성이 완전히 같지는 않다. 이번 최초 Windows 검증에서 발견한 호환성 오류 수정은 필요했지만, 수정마다 전체 Windows Python 검사를 재실행한 과정은 비효율적이었다. 향후 일반 CI·설치 후보 실행 분리, 실패한 테스트 우선 재검증, Python 테스트별 실행 시간 기록이 개선 후보이며 이번 비교 요청에서는 해당 구조를 추가 변경하지 않았다.

## 런타임 포함 방식

[고정 버전과 해시](../scripts/windows-runtime.json)에 있는 공식 Python embeddable ZIP, Pillow wheel, 영상 바이너리를 빌드 중에만 내려받고 SHA-256을 검증한다. Python/Pillow 라이선스와 ffmpeg LICENSE·README를 보관한다. Windows 설치 앱은 내장 실행기를 절대 경로로 실행하고 `TMM_PYTHON`이나 사용자 Python 설치에 의존하지 않는다. Python·Pillow·ffmpeg·ffprobe는 사용자가 터미널에서 설치할 필요가 없다. 2026-09-29 추가 구현으로 AI 캡션용 Codex CLI 0.158.0과 필요한 보조 실행 파일·라이선스를 원래 배포 구조 그대로 포함하도록 구성했다. 공식 압축파일과 라이선스 SHA-256, 패키지 내부 전체 파일 해시를 검사한다. 설정의 ChatGPT 로그인 버튼으로 인증하며 사용자가 Codex·Node/npm을 설치하지 않는다. 이 추가 변경은 위의 최신 `6a35557` CI에서 포함·기본 실행을 확인했다. 실제 Windows 브라우저 로그인과 캡션 생성은 사용자 PC에서 확인한다. [연결 계약](chatgpt-connection.md)을 따른다.

- [Python 배포 파일](https://www.python.org/downloads/release/python-31315/)
- [Python 앱 내장 배포 방식](https://docs.python.org/3.13/using/windows.html#the-embeddable-package)
- [ffmpeg/ffprobe 바이너리·라이선스 출처](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1)
- [Squirrel.Windows maker](https://www.electronforge.io/config/makers/squirrel.windows)

Windows 개발 환경에서 재현:

```powershell
pnpm install --frozen-lockfile
python scripts/prepare-windows-runtime.py
$env:TMM_PYTHON = (Resolve-Path build/runtime/python/python.exe).Path
$env:PATH = "$(Resolve-Path build/runtime/bin);$env:PATH"
pnpm check
pnpm make --arch=x64
pnpm verify:windows
```

## 별도로 남는 실제 설치 검증

- Node·Python·Pillow·ffmpeg 없는 Windows 사용자 환경에서 설치·최초 실행·재실행·제거/재설치.
- 원본 Excel 읽기, 다운로드·중복 정리·편집·등록·ZIP과 파일 잠금/강제 종료 복구.
- 폴더 전체와 DB 백업을 다른 PC에 옮기고 재연결·복원 후 파일 재다운로드 없이 사용. 토큰·파일 서버 코드는 새 PC에서 재입력.
- Windows OS 암호화 저장, 설정의 ChatGPT 브라우저 로그인/실제 캡션 생성, 앱 재실행·업데이트 후 인증 유지, 기존 Codex와 인증 분리, 사용자 승인에 따른 실제 API 동작.
- 자동 업데이트의 서로 다른 버전 간 실제 갱신·사용자 데이터 보존, 서명 없는 설치 경고 확인. 코드·릴리스 구조 구현과 실제 사용자 PC 검증을 구분한다.

자동 테스트·설치 파일 생성 성공을 실제 설치·UI·업데이트 통과로 보고하지 않는다.

## Windows CI에서 확인한 호환성 보정

- Windows에 없는 `O_NOFOLLOW`만으로 파일 서버 업로드를 보호하지 않도록, 파일을 열기 전후의 `lstat`와 열린 파일 정보를 비교한다.
- Python의 Windows `stat`/`fstat` ctime 의미 차이는 파일 생성 시각을 공통 비교값으로 사용하고, 열린 파일의 읽기 전후 change time은 별도로 검증한다. 파일 ID·크기·수정 시각·SHA-256 검사도 유지한다. [CPython 이슈](https://github.com/python/cpython/issues/157671)를 참고한다.
- 모든 앱 Python 명령의 JSON 출력은 UTF-8로 고정한다. 한글 파일명·오류 메시지를 Windows 기본 코드페이지에 맡기지 않는다.
- DB 백업·복원의 완성된 임시 파일은 내용을 자르지 않는 쓰기 가능 핸들로 디스크에 확정 저장한다. Windows의 읽기 전용 핸들 `fsync` 오류를 방지한다.
- 손상된 DB를 여는 초기 설정에서 오류가 나도 SQLite 연결을 즉시 닫는다. Windows 파일 잠금 때문에 검증된 백업으로 교체하지 못하던 문제를 수정했다.
- 업로드용 복사본을 만든 뒤 SHA-256이 불일치하면 해당 임시 복사본을 정리한다. 기존 목적지 파일은 변경하지 않는다.
- 테스트용 SQLite 연결을 명시적으로 닫고 경로 구분자·줄바꿈·영상 실행 파일의 `.exe` 차이를 반영했다.
- ZIP 내보내기·영상 인코딩의 POSIX SIGTERM 전달 테스트 2개는 Windows에서 실행하지 않는다. Windows의 직접 취소·인코더 정리는 별도 공통 테스트로 검사하지만, 설치 앱에서 종료·강제 종료 시 전체 프로세스 정리는 여전히 실기 검증 대상이다.
