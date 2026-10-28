# 게시 대기 전송용 S3 설정

2026-10-19 결정: 기존 버킷을 사용하고 **개발 `threads/dev/`, 운영 `threads/prod/`**를 별도로 사용한다. `marketo-sync`의 파일·환경·정리 규칙과 Lambda는 변경하지 않는다.

## 요청 경로

1. Electron이 로그인한 사용자와 선택 계정, 캡션·댓글·파일 크기·SHA-256을 중앙 API에 보낸다.
2. API가 파일별 짧은 S3 서명 PUT URL을 발급한다. AWS 키는 API 서버에만 있다.
3. Electron main이 준비한 파일을 S3로 직접 전송한다. API 서버에는 파일 바이트를 보내지 않는다.
4. API가 S3 HEAD로 저장된 크기·종류·SHA-256을 확인하고 S3 내부 복사로 새 게시용 객체를 만든다. 최종 HEAD 확인 후 DB에서 게시 대기로 확정한다.
5. 게시는 모바일 웹이, 토큰 확인·갱신은 2026-10-28부터 PC 프로그램 main이 Meta로 직접 요청한다. 이 S3 전송으로 Threads에 게시되지는 않는다.

참조 프로젝트의 SDK v3 서명 PUT 방식을 재사용하되 `public-read` ACL은 복제하지 않는다. S3 버킷 정책이 이미 익명 읽기를 허용한다면 ACL을 생략하는 것만으로 비공개가 되지 않으므로 아래 확인이 필요하다.

## 서버 환경파일

개발 파일은 `/Users/xofl/IdeaProjects/threads-admin-api/.env.development.local`이다. 운영에서는 별도 서버의 `.env.production` 또는 컨테이너 런타임 설정을 사용한다. Electron 저장소·배포 앱·`NEXT_PUBLIC_`·Docker 빌드 인수에 넣지 않는다.

```dotenv
S3_UPLOADS_ENABLED=false
AWS_REGION=실제_기존_버킷의_리전
AWS_ACCESS_KEY_ID=Threads_전용_권한의_액세스_키
AWS_SECRET_ACCESS_KEY=해당_시크릿_키
S3_BUCKET_NAME=기존_버킷_이름
S3_PREFIX=threads/dev/
S3_UPLOAD_URL_TTL_SECONDS=900
```

설정과 권한 확인을 마친 뒤 `S3_UPLOADS_ENABLED=true`로 바꾸고 API 서버를 다시 실행한다. 운영은 `S3_PREFIX=threads/prod/` 및 별도 운영 자격증명을 사용한다. 비활성화 상태에서도 서비스 로그인과 계정 관리는 동작하고 실제 전송 시작만 제한한다. 비밀값은 채팅으로 전달하지 않는다.

이 단계는 기존 단일 PUT 흐름으로 이미지 JPEG/PNG 8 MiB 이하, 영상 MP4/MOV 1 GiB 이하, 게시본당 1~20개를 처리한다. PC의 기존 변환·검증을 거친 최종 바이트를 해시한다. multipart 재개는 구현 범위가 아니며 실패한 파일은 명시적 재시도 때 다시 전송할 수 있다. 이미 게시 대기로 확정한 객체를 재업로드하지 않는다.

## 기존 버킷에서 확인할 항목

- **경로 분리:** 새 서비스는 위 prefix 안의 staging·published 경로만 사용한다. 기존 서비스 경로와 Lambda 트리거·정리 규칙이 겹치지 않아야 한다.
- **권한:** 서버 자격증명에는 대상 환경 prefix의 `s3:PutObject`, `s3:GetObject`를 부여한다. 버전 관리가 켜져 있으면 복사 결과의 특정 버전을 HEAD로 확인하므로 같은 prefix의 `s3:GetObjectVersion`도 필요하다. HEAD는 읽기 권한을 사용하고 S3 내부 복사는 원본 읽기·대상 쓰기 권한을 사용한다. 이 전송 흐름에 버킷 전체 읽기, ACL 변경, 버킷 정책 변경, Lambda 권한은 필요하지 않다.
- **비공개:** 버킷 정책의 `Principal: "*"` 및 넓은 `Resource`가 `threads/`도 공개하지 않는지 확인한다. 기존 서비스가 공개 파일을 사용하므로 버킷 전체 공개 설정을 임의로 끄지 않는다. 필요한 경우 기존 공개 허용 범위를 기존 경로로 한정하는 정책을 먼저 검토한다.
- **암호화:** 기본 SSE-S3 구성을 기준으로 한다. SSE-KMS 강제 정책이면 별도 키 사용 권한과 checksum HEAD 권한을 함께 검토해야 한다. 서비스 키에 불필요한 전체 KMS 권한을 주지 않는다.
- **Lifecycle:** 사용자 설정으로 환경별 새 prefix에 7일 보관을 적용한다. 임시 업로드와 게시용 최종 객체 모두 포함하되 기존 서비스의 규칙은 변경하지 않는다. 버전 관리가 켜져 있으면 과거 버전 정리도 별도로 검토한다.
- **CORS:** Electron main의 직접 PUT은 브라우저 CORS에 의존하지 않는다. 나중에 모바일 웹이 S3 파일을 fetch해서 표시해야 하는 경우 정확한 모바일 HTTPS origin의 GET/HEAD 허용을 추가한다. 모바일의 Meta API CORS와 S3 CORS는 별개의 검증이다.

개발용 최소 IAM 정책 예시다. `YOUR_BUCKET`을 실제 버킷 이름으로 바꾸고 기존 권한과 별도로 검토한다. 운영에는 dev 대신 prod만 허용하는 별도 정책을 사용한다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/threads/dev/*"
    }
  ]
}
```

## 실제 확인 순서

AWS 설정은 사용자가 적용한다. 에이전트는 AWS 서버 접속·정책 변경·실제 미디어 업로드를 검증 명목으로 실행하지 않는다.

1. 위 환경값과 전용 경로의 권한·공개 범위·Lifecycle을 확인한다.
2. 개발 DB migration과 API·Electron 버전이 일치하는지 확인한다.
3. 사용자가 작은 이미지 하나의 등록 글과 대상 계정 하나를 선택해 **모바일로 보내기**를 누른다.
4. API에는 JSON만 전달되고 파일 전송 목적지가 S3인지 확인한다. S3 저장만 성공했을 때와 서버가 게시 대기를 확정했을 때를 구분한다.
5. 게시 대기의 대상 계정·캡션·댓글·첨부 순서·서버 기준 기한을 확인한다. 이 단계에서 Meta 요청은 없어야 한다.
6. 회수 후 로컬 수정·재전송, 네트워크 중단 후 같은 전송 재시도, 로컬 삭제 전 대기 취소를 소량으로 확인한다. 새 전송으로 자동 복제하거나 실제 Threads 게시를 실행하지 않는다.

서명 URL은 유효기간 동안 재사용 가능한 권한이다. 로그·스크린샷·관리자 응답에 URL을 남기지 않는다. 완료 전에 업로드할 임시 key와 게시용 key를 분리하고 최종 key를 재발급하지 않는 이유다. [AWS 서명 URL 업로드 설명](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html), [CopyObject 조건부 복사](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html), [S3 체크섬 검증](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html)을 참고한다.

서버 게시 기한은 확정 시각부터 7일이고 S3 Lifecycle은 객체 생성일·UTC 날짜 경계·비동기 삭제를 따른다. 두 시각이 같다고 표현하지 않는다. HEAD에서 더 이른 객체 만료를 알면 확정을 거절하며, 운영 규칙과 실제 보관 결과를 확인하기 전에는 파일의 7일 잔존을 보장하지 않는다.
