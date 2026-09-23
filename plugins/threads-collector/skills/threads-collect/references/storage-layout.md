# 저장 위치와 날짜별 운영

명시한 `accounts.xlsx`의 부모를 우선하고, 없으면 [로컬 설정](../../../references/local-settings.md)의 `collection_root`를 사용한다. 최초 설정에서만 위치를 선택한다. 사용자 파일·기존 설정을 빈 양식으로 초기화하지 않는다.

```text
<collection-root>/
  accounts.xlsx                       계정 입력과 수집 기준 표시
  results/YYYY/MM/
    threads-YYYY-MM-DD.xlsx            유일한 최종 원본
  backups/excel/                      변경 전 Excel 백업
  backups/legacy-jsonl/               검증 후 보관한 이전 형식(활성 원본 아님)
  _work/
    collector.lock                    Excel 최종 반영/로컬 작업 공통 잠금 (탐색 중 생성하지 않음)
    <실행ID>/0001.jsonl                수집 중 임시 기록
    <실행ID>/normalized.json           저장·복구용 임시 입력
  state/state.db                      앱 전용 작업 상태
  media/                              앱 전용 파일
```

폴더 이동·백업 시 accounts·결과 Excel·정상 백업한 DB·미디어를 함께 보존한다. 설치 캐시와 사용자 자료를 분리하고 다른 실행의 잠금을 제거하지 않는다. 기존 JSONL이나 손상 자료는 자동 삭제하지 않는다.

## 날짜·기준·재실행

- 시작 KST 수집일과 실행ID를 고정한다. 자정을 넘어도 시작일 결과에 저장하고 실제 관찰·시작·종료 시각은 그대로 기록한다.
- 하루 한 번 판정은 `inspect.accounts[].last_attempt`의 실제 KST 시도일이다. partial도 시도에 포함한다. 재실행·재개에는 명시 요청과 새 실행ID가 필요하다.
- 다음 기준은 결과 Excel의 최신 완료 실행에서 읽는다. accounts의 기준·실행·경로 열은 표시 사본이다. 불일치하면 새 탐색 전에 저장 복구를 수행한다. 행 순서로 기준을 추정하지 않는다.
- 최초 10건·증분 최대 10건·cap_reached의 첫 ID·possible_gap·partial의 기존 기준 유지 규칙은 같다. 새로운 성공으로 과거 누락 경고를 지우지 않는다.
- 같은 날짜의 게시글·첨부는 논리 키로 갱신하고 실행 이력은 누적한다. 이후 날짜에는 새 Excel을 만들며 과거 날짜 원본을 수정하지 않는다.

## 저장·복구

계정 접속 전 start를 기록하고, 탐색 중 [journal-contract.md](journal-contract.md)의 batch만 append한다. 탐색 중 Excel import/export·재열기·렌더·accounts 갱신은 하지 않는다.

종료 후 end를 기록하고 완전한 관찰을 한 번 정규화한다. [helper 계약](../../../references/collection-source.md)의 `commit-source --input ... --journal ...`이 결과 Excel 작성·검증·교체, accounts 갱신·검증, 전달한 임시 두 파일 정리를 담당한다. 토큰 없이 호출한 helper가 Excel 반영 구간에만 잠금을 잡고 종료 시 해제한다. 탐색·JSONL 쓰기·정규화 중에는 공통 잠금을 잡지 않는다. 별도 보고서를 다시 만들지 않는다. 사용자 열·메모·서식은 보존한다.

저장 실패 시 전체 수집을 중단하고 임시 기록을 남긴다. 다음 실행은 같은 입력으로 저장부터 복구한다. 결과 Excel만 저장된 상태는 실행기록의 입력 해시로 확인해 accounts만 복구한다. 재수집하거나 새 실행ID로 덮어쓰지 않는다.

end 없이 종료된 임시 기록은 완전한 줄만 해석하고 partial로 정리한다. 종료 시각을 만들지 않는다. 불완전 tail은 원본을 잘라내거나 이어쓰지 않고 보존한다. 복구 내용을 별도의 종료된 recovery journal과 정규화 입력으로 만들고 그 파일만 helper에 전달한다. 원래 손상 파일은 검증 전 삭제하지 않는다. 복구는 브라우저 재수집 권한이 아니다.

기존 daily-v1 Excel은 그대로 사용한다. 이전 통합 `threads-collection.xlsx`나 Excel 없는 JSONL 자료는 자동 추정·변환하지 않는다. 기존 JSONL은 Excel과 동등성 검증 후 백업으로 이동할 수 있으며 앱과 수집기는 활성 원본으로 읽지 않는다.

플러그인은 다운로드 DB·미디어·앱 중단 상태를 열지 않는다. 공통 잠금은 Excel 최종 반영 때만 사용하며, 별도로 요청한 수집이나 새 Excel이 다운로드의 중단·대기·소비량을 초기화하지 않는다.
