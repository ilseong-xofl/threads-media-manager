# Windows 자동 검증과 설치 후보

GitHub Actions의 `CI`는 push·PR·수동 실행에서 Mac과 Windows Server 2022 x64를 각각 검사한다. 설치 후보는 GitHub Actions artifact로 14일 보관한다. 버전은 `0.1.0`이며 자동 업데이트·공개 Release 배포와 분리한다.

## 자동으로 확인하는 범위

1. 고정 Node·pnpm으로 lint, TypeScript, 전체 TypeScript/Python 테스트, 포맷 검사.
2. Windows에서는 앱에 포함할 Python 3.13.15·Pillow 12.3.0·ffmpeg/ffprobe로 검사한다. 영상 도구가 없어서 관련 테스트를 건너뛰지 않도록 먼저 실행을 확인한다.
3. Electron Forge와 Squirrel.Windows로 `ThreadsMediaManager-win32-x64-Setup.exe`, `RELEASES`, `*-full.nupkg` 생성.
4. 패키지의 ASAR 밖 `resources/runtime`에서 Python·Pillow·SQLite·pHash·영상 생성/검증·한글/일본어/공백 경로를 오프라인 합성 자료로 확인한다. 이 검사는 개발 PC용 Python·ffmpeg를 PATH에서 제외한다.
5. 산출물 SHA-256과 `verification.json`을 저장한다. 검사 결과에는 설치 파일 실제 실행 및 자동 업데이트가 미검증임을 별도로 기록한다.

워크플로: [CI](../.github/workflows/ci.yml). GitHub 저장소 **Actions → CI → 성공한 실행 → Artifacts**에서 같은 커밋의 설치 후보를 받는다. 기존 자료·토큰 없이 생성하며 서명하지 않은 내부 검수용이다.

## 런타임 포함 방식

[고정 버전과 해시](../scripts/windows-runtime.json)에 있는 공식 Python embeddable ZIP, Pillow wheel, 영상 바이너리를 빌드 중에만 내려받고 SHA-256을 검증한다. Python/Pillow 라이선스와 ffmpeg LICENSE·README를 보관한다. Windows 설치 앱은 내장 실행기를 절대 경로로 실행하고 `TMM_PYTHON`이나 사용자 Python 설치에 의존하지 않는다. Python·Pillow·ffmpeg·ffprobe는 사용자가 터미널에서 설치할 필요가 없다. 기존 AI 캡션용 Codex CLI 연결은 별도이며 이번 런타임 번들에 포함하지 않는다.

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
- Windows OS 암호화 저장, Codex CLI 로그인/캡션 생성, 사용자 승인에 따른 실제 API 동작.
- 자동 업데이트 구현, 서로 다른 버전 간 갱신과 사용자 데이터 보존, 코드 서명 및 정식 Release.

자동 테스트·설치 파일 생성 성공을 실제 설치·UI·업데이트 통과로 보고하지 않는다.

## Windows CI에서 확인한 호환성 보정

- Windows에 없는 `O_NOFOLLOW`만으로 파일 서버 업로드를 보호하지 않도록, 파일을 열기 전후의 `lstat`와 열린 파일 정보를 비교한다.
- Python의 Windows `stat`/`fstat` ctime 의미 차이는 파일 생성 시각을 공통 비교값으로 사용하고, 열린 파일의 읽기 전후 change time은 별도로 검증한다. 파일 ID·크기·수정 시각·SHA-256 검사도 유지한다. [CPython 이슈](https://github.com/python/cpython/issues/157671)를 참고한다.
- 모든 앱 Python 명령의 JSON 출력은 UTF-8로 고정한다. 한글 파일명·오류 메시지를 Windows 기본 코드페이지에 맡기지 않는다.
- 테스트용 SQLite 연결을 명시적으로 닫고 경로 구분자와 영상 실행 파일의 `.exe` 차이를 반영했다.
- POSIX SIGTERM 전달 검증은 Windows에서 실행하지 않는다. Windows의 직접 취소·인코더 정리는 별도 공통 테스트로 검사하지만, 설치 앱에서 종료·강제 종료 시 전체 프로세스 정리는 여전히 실기 검증 대상이다. POSIX 전용 파일 형식 검증도 Windows에서는 제외한다.
