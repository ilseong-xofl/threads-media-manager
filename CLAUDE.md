# Claude 인수인계 진입점

현재 프로젝트는 `threads-media-manager`입니다. 작업 전에 이 프로젝트의 `AGENTS.md`와 [세 프로젝트 통합 인수인계](docs/claude-handoff-2026-10-19.md)를 읽으세요.

- 통합 문서의 로컬 원본: `/Users/xofl/IdeaProjects/threads-media-manager/docs/claude-handoff-2026-10-19.md`
- 다른 프로젝트를 내려받지 않았다면 [GitHub 통합 문서](https://github.com/ilseong-xofl/threads-media-manager/blob/main/docs/claude-handoff-2026-10-19.md)를 확인하세요.
- 모바일 컨테이너 상태 조회 연결 실패의 원인은 2026-10-20에 **CORS로 확정**했습니다. Meta의 컨테이너 상태·게시 링크 GET 응답에 `Access-Control-Allow-Origin`이 없어 브라우저가 읽지 못하므로, 모바일은 상태·링크를 조회하지 않고 단계 사이에 60초를 기다립니다. 실제 계정 요청(토큰 확인·갱신·원글·댓글 등록)은 사용자가 승인한 테스트 범위에서만 실행하고, 이전 승인을 다음 실행에 재사용하지 않습니다.
- Meta 게시(원글·댓글)는 휴대폰 브라우저가 직접 호출합니다. 토큰 확인(`debug_token`)·갱신(`refresh_access_token`)은 2026-10-28부터 이 PC 프로그램의 main 프로세스가 직접 호출합니다(`src/main/meta-token-client.ts`). Electron은 S3에 직접 업로드합니다. 서버 Meta 대리 호출은 계속 금지합니다.
- `marketo-sync`, `local-video-manager`, `local-video-manager-service`는 읽기 전용입니다. AWS 서버에 직접 접근하지 않습니다.
- 실제 환경파일·키·토큰·사용자 자료를 Git/로그/채팅에 넣지 않습니다. 코드 보관 완료와 실등록/배포 완료를 구분하세요.
