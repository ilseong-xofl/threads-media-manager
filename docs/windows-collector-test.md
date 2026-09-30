# 수집 플러그인 사용 가이드

## 1. Codex 설치·로그인

[Codex 설치 파일 다운로드](https://get.microsoft.com/installer/download/9PLM9XGG6VKS?cid=website_cta_psi)를 눌러 설치하고, 본인의 ChatGPT 계정으로 로그인합니다.

## 2. 수집 플러그인 설치

Codex 대화에 아래 내용을 복사해서 보냅니다.

```text
아래 GitHub 주소의 README.md를 보고 Threads 수집 플러그인을 설치해줘. 아직 수집하지 마.
https://github.com/ilseong-xofl/threads-collector
```

설치가 끝나면 **새 대화**를 엽니다.

## 3. 수집 폴더 설정

아래 내용을 보내고, 안내에 따라 수집 자료를 보관할 폴더를 선택합니다. **이 폴더는 로컬 앱에서도 사용합니다.**

```text
$threads-setup으로 초기 설정해줘. 아직 수집하지 마.
```

Spreadsheets 설치 안내가 나오면 **Plugins에서 Spreadsheets를 설치**하고, 새 대화에서 위 내용을 다시 보냅니다.

## 4. 수집 계정 등록

아래 예제의 주소를 수집할 계정의 주소로 바꿔서 보냅니다. 계정이 여러 개면 주소를 한 줄에 하나씩 추가합니다. 계정은 **10개 이하**로 유지합니다.

```text
예제 계정은 지우고, 아래 Threads 계정을 중복 없이 등록해줘. 아직 수집하지 마.
https://www.threads.com/@계정이름
...
```

## 5. Threads 로그인·수집

아래 내용을 보내고, 열린 브라우저에서 **Threads에 직접 로그인**합니다. Chrome의 로그인 정보는 가져오지 않습니다.

```text
Codex 내부 브라우저에서 Threads 로그인 화면을 열어줘. Chrome 로그인 정보는 가져오지 말고, 내가 직접 로그인할 때까지 기다려줘.
```

로그인을 마치면 아래 내용을 보냅니다.

계정별 기본 수집 개수는 **2개**입니다. `$threads-collect로 수집해줘`라고 요청하면 계정마다 최신 글을 최대 2개씩 수집합니다. 개수를 바꾸려면 `$threads-collect로 계정마다 5개씩 수집해줘`처럼 원하는 개수를 함께 적습니다.

```text
Threads 로그인 완료했어. $threads-collect로 수집해줘.
```

수집이 끝나면 **로컬 앱 가이드**로 넘어갑니다.

## 6. 다음 수집·플러그인 업데이트

다음에 수집할 때는 아래 내용만 보냅니다.

```text
$threads-collect로 수집해줘.
```

플러그인을 업데이트할 때는 아래 내용을 보내고, 완료 후 **새 대화**를 엽니다.

```text
$threads-update로 수집 플러그인을 업데이트해줘.
```
