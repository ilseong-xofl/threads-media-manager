# Threads Collector 배포 저장소

이 저장소는 수집 플러그인의 검증된 배포본이다. 작성 원본은 threads-media-manager 저장소의 plugins/threads-collector이며 scripts/export-collector-repo.py가 명시적 파일 목록으로 이 저장소를 갱신한다. 수정은 원본에 반영하고 내보내어 두 소스를 일치시킨다. DISTRIBUTION.json은 배포 파일별 무결성 기록이다.

플러그인은 초기 설정·계정 Excel·Codex 내부 브라우저 수집·Excel 원본 저장·플러그인 갱신만 담당한다. 앱 다운로드·SQLite·미디어·사용자 토큰·로그인은 복제하지 않는다. 계정당 기본 최대 2개와 기존 대기 정책을 유지한다. 수집과 실제 파일 다운로드를 구분한다.

사용자 설치·업데이트 안내는 README.md를 따른다. marketplace threads-collector, plugin threads-collector@threads-collector, GitHub의 main만 정상 배포 경로다. 기존 personal/testing 설치를 임의 삭제·변경하지 않는다. GitHub 목록 갱신·설치본 갱신·새 대화 스킬 로드·Windows 실제 사용 성공을 별도로 확인한다.

이 저장소의 tests는 합성 자료만 사용한다. 실제 수집·게시·사용자 자료 변경은 명시적 요청이 있을 때만 진행한다. Python 테스트·manifest 검증과 Windows UI 설치 성공은 다르다.
