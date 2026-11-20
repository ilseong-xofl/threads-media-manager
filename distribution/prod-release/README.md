# 운영용 릴리스 작업 원본

운영용 PC 프로그램(`prod` 벌)은 운영 저장소 `ilseong-xofl/threads-media-manager-prod`에서 릴리스한다. 그 저장소에는 릴리스 작업 파일과 릴리스만 있고, 소스는 `ilseong-xofl/threads-media-manager`에 있다. 이 폴더의 `release.yml`이 그 작업 파일의 원본이다. 고칠 때는 여기서 고치고 운영 저장소의 `.github/workflows/release.yml`로 복사한다.

## 처음 한 번 (운영 개시 때)

1. 공개 저장소 `ilseong-xofl/threads-media-manager-prod`를 만든다. 업데이트 서비스(update.electronjs.org)는 공개 저장소만 쓸 수 있다.
2. `release.yml`을 그 저장소의 `.github/workflows/release.yml`로 넣는다.
3. 저장소 이름을 바꾸려면 첫 운영 릴리스 전에 `variants.json`의 `prod.updateRepository`와 함께 바꾼다. 설치된 운영용 프로그램은 빌드에 들어간 저장소만 본다.

## 릴리스할 때

1. 소스 저장소에서 그 버전을 개발용으로 먼저 릴리스한다(태그 `v<버전>`). 테스터 확인이 끝났는지는 실행하는 사람이 판단한다.
2. 운영 저장소의 Actions → **Release production Windows app** → Run workflow에 버전(`0.1.12`처럼 `v` 없이)을 넣고 실행한다.

작업이 하는 일:

- 소스 저장소에 그 버전의 공개된 개발용 릴리스가 있는지, 버전이 운영 저장소의 기존 릴리스보다 큰지 확인한다. 아니면 멈춘다.
- 소스 저장소의 태그 `v<버전>`을 받아, 개발용 릴리스가 같은 커밋에서 만들어졌는지와 `variants.json`의 운영 저장소가 이 저장소인지 확인한다.
- `windows-2022`에서 `TMM_VARIANT=prod`로 빌드하고 소스 저장소의 `pnpm verify:windows`를 그대로 돌린다.
- 검증된 다섯 파일(`IlsSocialManager-win32-x64-Setup.exe`, `RELEASES`, `ils_social_manager-<버전>-full.nupkg`, `SHA256SUMS.txt`, `verification.json`)로 이 저장소에 정식 릴리스를 만든다.

다른 저장소에 쓰는 토큰은 쓰지 않는다. 이 저장소 자신의 `github.token`으로 소스 저장소(공개)를 읽고 이 저장소에만 쓴다.

## 확인하지 못한 것

2026-11-20 현재 운영 저장소가 없어 이 작업은 한 번도 실행하지 않았다. 판정 단계(버전·릴리스 조건, 게시 전 검사)는 가짜 GitHub 응답으로만 확인했다. 첫 실행은 [설계 문서 5장의 예행](../../docs/dev-prod-split.md)대로 사용자 PC에서 설치·자동 업데이트까지 본 뒤 직원에게 링크를 준다.
