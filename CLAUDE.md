# Claude 인수인계 진입점

현재 프로젝트는 `threads-media-manager`입니다. 작업 전에 이 프로젝트의 `AGENTS.md`와 [세 프로젝트 통합 인수인계](docs/claude-handoff-2026-10-19.md)를 읽으세요.

- 통합 문서의 로컬 원본: `/Users/xofl/IdeaProjects/threads-media-manager/docs/claude-handoff-2026-10-19.md`
- 다른 프로젝트를 내려받지 않았다면 [GitHub 통합 문서](https://github.com/ilseong-xofl/threads-media-manager/blob/codex/phase-2-registration/docs/claude-handoff-2026-10-19.md)를 확인하세요.
- 모바일 컨테이너 상태 조회 연결 실패는 **원인 미확정**입니다. 실제 계정 요청·갱신·등록 재시도는 중단 상태이며 직전 제한 조회 승인을 재사용하지 않습니다.
- Meta는 브라우저에서 직접 호출하고, Electron은 S3에 직접 업로드합니다. 서버 Meta 대리 호출은 금지합니다.
- `marketo-sync`, `local-video-manager`, `local-video-manager-service`는 읽기 전용입니다. AWS 서버에 직접 접근하지 않습니다.
- 실제 환경파일·키·토큰·사용자 자료를 Git/로그/채팅에 넣지 않습니다. 코드 보관 완료와 실등록/배포 완료를 구분하세요.
