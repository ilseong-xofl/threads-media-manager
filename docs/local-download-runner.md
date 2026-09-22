# 로컬 앱용 다운로드 실행기

최신 역할 구분은 플러그인 수집 완료 → 로컬 앱 Excel 읽기·다운로드·관리다. 이 문서는 `local-runtime/`으로 분리한 기존 검증 코드의 현재 범위를 설명한다. 플러그인에는 이 코드를 배포하지 않는다.

## 현재 검증된 코드

파일 하나의 순차 HTTPS GET, 허용 CDN·DNS·TLS 검증, 저장·파일 검증, 단일 SQLite 상태, 소비 기록, 첫 오류 전체 중단과 로컬 저장 복구를 포함한다. 기존 오프라인 테스트와 실제 이미지19개·영상1개 전체 저장 기록은 [진행 기록](progress.md)에 있다. Electron 연결은 [1D](phase-1d-download.md)에서 구현했고 배치 회차와 비정상 종료 후 재개는 [1E](phase-1e-download.md)에서 구현했다. 아래 단일 파일 설명보다 최신 1E 계약이 우선한다.

사용자 결정으로 개발용24시간1회 상한을 제거했다. 현재 `local-download-v2`에는 일일 횟수 제한이 없으며 redirect0회·파일 사이 대기·첫 오류 중단은 유지한다. 기존 `one-file-pilot-v1` DB는 첫 쓰기 때 정책과 이관 기록만 하나의 트랜잭션으로 변경한다. 요청·작업·UUID·완료 파일·중단·대기와 기타 메타데이터는 보존한다. 읽기 전용 준비 단계는 기존 정책도 인식하며 DB를 변경하지 않는다. 과거90회 제안은 적용하지 않는다.

```text
python <project>/local-runtime/download_runner.py --collection-root <root> inspect
python <project>/local-runtime/download_runner.py --collection-root <root> status
python <project>/local-runtime/download_runner.py --collection-root <root> plan-one --account <account>
python <project>/local-runtime/download_runner.py --collection-root <root> download-one --job-id <job-id>
python <project>/local-runtime/download_runner.py --collection-root <root> recover
```

이 CLI는 기존 개발 인터페이스다. Electron은 stdin 요청과 JSONL 진행 이벤트를 사용하는 download_ui.py worker를 호출하며 수집 스킬에서는 호출하지 않는다. 앱 CLI는 수집 원본 commit/import 명령을 제공하지 않는다. 사용자에게 명령을 입력하도록 하는 배포 절차도 아니다.

## 데이터와 오류

입력은 `results/YYYY/MM/threads-YYYY-MM-DD.xlsx`의 확정 기록이다. 원문 캡션·날짜·서명 URL은 Excel에서 읽고 DB에 복제하지 않는다. 다운로드 상태는 `<root>/state/state.db`, 파일은 `media/files/<postUUID>/<mediaUUID>.<ext>`, 미완료 파일은 `media/.partial/`에 둔다. 기존 DB와 library UUID·완료 파일을 그대로 사용한다.

활성 수집·다운로드는 `_work/collector.lock`으로 겹치지 않게 한다. 앱 다운로드 오류는 앱 다운로드 큐 전체 중단이며 플러그인의 별도 수집 요청을 금지하지 않는다. 새 Excel·서명 URL이 생겨도 앱의 중단·요청 이력·대기는 초기화하지 않는다. 진행 중 고정한 원본이 변경되면 중단하고 확인한다.

모든 오류는 첫 발생에 멈춘다. 자동 재시도·HEAD·쿠키 복사·URL 변조·주소 추측·원격 페이지 재수집은 하지 않는다. recover는 이미 받은 로컬 파일의 저장 근거만 복구하며 중단 해제나 재전송 기능이 아니다. 정상 저장된 파일을 누락/변경된 것으로 확인하면 새로 받지 않고 확인 필요로 남긴다.

## 앱에서 이어갈 기능

[다운로드 정책](download-queue-policy.md)에 따라 게시글 단위35–45첨부 묶음(마지막 잔여 예외), 파일 저장·검증 완료 후3–10초, 회차1–2분, 계정10–30초를 구현한다. 초기 화면에서 게시글·남은 파일·회차·보류와 대기를 안내하고 사용자의 다운로드 시작 동작으로 진행한다. 앱 실행/새로고침만으로 CDN 요청을 시작하지 않는다.

원본은 날짜별 Excel을 계속 보관한다. 앱의 새로고침은 새 확정 기록을 읽는 동작이며 활성 다운로드 계획을 자동 확대하는 동작이 아니다. 전체 관찰 첨부 다운로드 완료와 실제 캐러셀 전체 수 확인은 구분한다.

제공 Python의 Pillow로 이미지를 검증하고 영상은 PATH의 ffprobe가 필요하다. 기존 Mac 검증은 Python3.12.14/Pillow12.3.0/ffprobe9.0.2 기준이다. ffprobe는 개발 PC의 외부 실행 파일이며 배포물에 복사하지 않았다. Windows의 런타임·패키징·라이선스와 실제 기능 검증은 최종 배포 단계다.
