# 수집 원본 helper

최종 원본은 `results/YYYY/MM/threads-YYYY-MM-DD.xlsx` 하나다. JSONL은 수집 중 `_work/<실행ID>/0001.jsonl`에 쓰는 임시 복구 기록이다. 앱은 Excel을 읽고 다운로드 작업·파일 연결·요청 소비는 SQLite에 보관한다. 수집 플러그인은 SQLite·미디어·네트워크 다운로드에 접근하지 않는다.

Python 3.11 이상 표준 라이브러리로 호출한다.

```text
python <plugin>/scripts/collection_source.py --collection-root <root> inspect
python <plugin>/scripts/collection_source.py --collection-root <root> commit-source --input <root>/_work/<실행ID>/normalized.json --journal <root>/_work/<실행ID>/0001.jsonl
```

`inspect`는 Excel의 게시글·미디어·실행기록을 검증하고 계정별 최신 완료 기준과 최근 시도를 반환한다. `accounts[].next_anchor`는 완료 실행의 기준이고 `last_attempt`·`last_attempt_run`·`last_result`에는 partial도 포함한다. 하루 한 번 판정은 실제 시도의 KST 날짜다. errors가 있으면 원본을 보존하고 복구 전 수집하지 않는다. 계정 파일의 기준·실행 열은 결과 Excel에서 복구할 수 있는 표시 사본이다.

`commit-source` 입력은 [daily-v1 필드](../skills/threads-collect/references/excel-contract.md)의 `{posts, media, run}`이다. 중복 관찰을 메모리에서 정규화하고 하나의 실제 종료 상태로 전달한다. run.실행ID·계정명은 종료된 임시 journal과 같아야 한다. running·불완전 tail·다른 실행·충돌은 확정하지 않는다.

1. 수집 종료 후 JSONL 정규화를 끝낸 입력으로 호출하고, helper가 Excel 반영 구간의 공통 잠금을 획득한다. 기존 Excel·계정·관찰 연결을 확인한다.
2. 새 결과를 같은 디렉터리의 임시 Excel에 작성하고 다시 열어 검증한다. 사용자 추가 열·메모·서식·이전 실행을 보존하고 변경 전 파일은 `backups/excel/<SHA256>-<이름>`에 백업한다.
3. 일별 Excel을 원자적으로 교체한 뒤 accounts의 기준·최근 시도·완료·실행 표시를 갱신하고 재검증한다. partial은 완료 기준과 최근 완료 시각을 갱신하지 않는다.
4. 두 Excel의 검증이 끝난 뒤 전달한 journal과 normalized 입력만 지운다. 다른 파일·폴더는 재귀 삭제하지 않는다. helper가 획득한 공통 잠금은 성공·실패 모두 종료 시 해제한다.

Excel 실행기록의 추가 열 `수집입력SHA256`으로 같은 실행의 정확한 재시도를 확인한다. Excel 저장 뒤 accounts 갱신이 실패해도 재수집하지 않는다. 남은 입력과 journal로 같은 명령을 다시 실행하면 결과 Excel을 다시 쓰지 않고 계정 표시부터 복구한다. 실패 시 임시 기록을 남기며 후속 계정을 중단한다. `--journal` 생략은 오프라인 저장/진단용으로 입력을 정리하지 않는다. 정상 수집은 반드시 종료 journal을 전달한다.

탐색·JSONL 기록·정규화 중에는 `_work/collector.lock`을 생성하지 않는다. 수집이 끝나면 `commit-source`를 `--lock-token` 없이 호출하여 **Excel 저장·검증 동안만** helper의 기존 자체 잠금을 사용한다. 수집 도중 로컬 앱은 기존 Excel·다운로드 파일로 편집·작성을 계속한다. 잠금이 이미 있으면 확보한 JSONL·입력을 보존하고 해당 로컬 작업이 끝난 뒤 같은 확정 명령을 실행한다. `--lock-token`은 이전 실행 복구 호환용이며 신규 수집에는 사용하지 않는다. 다른 실행의 잠금을 제거하거나 우회하지 않는다. Excel의 `~$`/LibreOffice 잠금이 있으면 파일을 닫은 뒤 같은 저장을 재시도한다.

기존 daily-v1 Excel은 변환 없이 읽는다. `import-excel`과 영구 JSONL 쓰기는 제거했다. 이전 JSONL은 정상 흐름에서 읽지 않는다. Excel과 모든 원문·미디어·실행의 의미가 같은지 확인된 과거 JSONL만 별도 백업으로 옮길 수 있다. 불일치·Excel 누락은 원본을 보존하고 명시적 복구가 필요하다. `threads_source/legacy_jsonl.py`는 이 확인용 읽기 전용 도구다.

새 Excel이 앱의 다운로드 중단·요청 소비·대기를 초기화하지 않는다. 수집 완료 보고는 Excel 경로와 수량·기준·미완료 상태를 안내한다. 실제 다운로드는 별도 앱 요청이다.
