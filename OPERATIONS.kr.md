# Operations

한국어 · [English](./OPERATIONS.md)

## run 시작 전 체크

- Node.js 22 이상 사용 가능
- CLI 중 하나 이상 설치 및 인증 완료 (Codex CLI, Claude Code, Gemini CLI 중 하나)
- 프로젝트 폴더가 신뢰 가능한 로컬 폴더
- git 저장소라면 working tree가 깨끗한지 확인

## preflight는 이렇게 읽으면 됩니다

- `안전 자동화`
  - 지금 맡겨도 되는 상태
- `주의 자동화`
  - 실행은 가능하지만 경고를 먼저 보는 편이 좋음
- `사람 확인 필수`
  - 아직 자동화에 바로 맡길 상태는 아님

`blocker`는 시작을 막는 항목이고,  
`warning`은 시작은 가능할 수 있지만 신뢰도를 떨어뜨리는 항목입니다.

## 자주 보는 문제

### Node가 없음

- Node.js 22 이상 설치
- 터미널을 다시 열기
- 런처를 다시 실행

### CLI가 없거나 인증되지 않음

CLI가 하나 이상 설치되어 있어야 합니다.
가지고 있는 것을 설치하세요:

- Codex CLI: `npm i -g @openai/codex` — ChatGPT Plus 또는 Pro 필요
- Claude Code: `npm i -g @anthropic-ai/claude-code` — Anthropic 구독 필요
- Gemini CLI: `npm i -g @google/gemini-cli` — Google 계정 필요

설치 후 해당 CLI의 로그인 명령으로 인증하고, 진단을 다시 실행하세요.

### 폴더 선택 창이 열리지 않음

- 경로를 직접 입력
- Linux라면 `zenity`, `qarma`, `kdialog` 존재 여부 확인
- macOS라면 `osascript` 사용 가능 여부 확인

### `harness.sh` 권한 오류

- `chmod +x harness.sh`
- 다시 실행

### dirty repo

영향:

- worktree 격리가 안 될 수 있음
- shared workspace에서 바로 실행될 수 있음
- 병렬 실행 기본값이 있어도 실제 run은 안전하게 1개씩으로 내려갈 수 있음
- 최근 drift, retry, verification 실패가 쌓이면 adaptive parallelism이 현재 배치를 1개씩으로 더 줄일 수 있음

권장 조치:

- 먼저 커밋하거나 stash 하거나 작업을 정리

### preset보다 병렬이 적게 도는 것처럼 보임

이건 보통 세 가지 중 하나입니다.

- preset 또는 계획 패턴 자체가 순차
- shared workspace fallback 때문에 병렬이 꺼짐
- adaptive parallelism이 최근 실패, 재시도, scope drift를 보고 현재 배치 폭을 임시로 줄임

먼저 run 상세의 안내 문구를 보면 지금 어떤 이유인지 바로 확인할 수 있습니다.

### settings의 strategy template

settings modal에는 preset 기준 strategy template 채우기 기능이 있습니다.

- `customConstitution`, `plannerStrategy`, `teamStrategy` 3칸을 한 번에 채움
- 이 PC 로컬 설정에만 적용됨
- repo 파일을 직접 바꾸지는 않음

### 경로가 너무 김

이건 주로 Windows에서 생깁니다.
worktree나 patch apply에 영향을 줄 수 있습니다.

권장 조치:

- `C:\work\repo` 같은 짧은 경로로 옮기기

### 텍스트가 깨져 보임

현재 지원하는 텍스트 인코딩:

- UTF-8
- UTF-8 BOM
- UTF-16 LE / BE

PDF intake는 OCR이 아니라 텍스트 추출 기반입니다.
스캔본 PDF는 제대로 읽히지 않을 수 있습니다.

### run이 입력 대기 상태임

`needs_input`이면:

- 짧게 답해도 충분하고
- 목표, 제한, 문서도 같이 바꿀지 정도만 적으면 됩니다

### run이 승인 대기 상태임

`needs_approval`이면:

- 목표와 첫 작업이 맞으면 승인
- 범위나 변경 금지 영역이 틀렸으면 조정 요청

### task가 실패함

이 순서로 보는 편이 좋습니다.

1. `Proof of Work`
2. 런타임 관측
3. 검토 요약

그다음 선택:

- 같은 계획으로 다시 시도
- 범위를 줄여 다시 계획
- 이번 목표에서 제외

### 프로젝트에 다음 run이 필요함

이럴 때는:

- `권장 다음 작업 초안`
- 문서가 많이 바뀌었으면 `재분석 후 첫 작업 초안`
- `장기 운영 체크`에서 drift와 반복 실패 먼저 확인

## 알아두면 좋은 로컬 경로

- run 상태: `runs/<run-id>/state.json`
- run 로그: `runs/<run-id>/logs.ndjson`
- task 산출물: `runs/<run-id>/tasks/<task-id>/`
- 프로젝트 메모리: `memory/projects/<project-key>/`
- 이 PC 전용 설정: `.harness-web/settings.json`
- 런타임 관찰 로그: `.harness-web/runtime-events.ndjson`
- Supervisor 런타임 스냅샷: `.harness-web/supervisors.json`

런타임 이벤트와 run 로그의 공통 추적 필드:

- `projectId`
- `runId`
- `taskId`
- `correlationId`

하나의 run 또는 task 흐름을 `logs.ndjson`, `trace.ndjson`, `.harness-web/runtime-events.ndjson` 사이에서 따라갈 때는 `correlationId`를 먼저 보면 됩니다.

## 실행 프로필

- `즉시 진행`
  - 가장 빠른 로컬 기본 경로
- `승인 요청`
  - 더 보수적인 경로
- `읽기 전용`
  - 수정 전에 먼저 둘러보고 싶을 때

Codex 전용 설정:

- 모델 선택: 기본은 `GPT-5.4`, 필요하면 `GPT-5.3-Codex-Spark`
- fast mode 토글: 켜면 fast service tier, 끄면 default service tier

추가 메모:

- `문서 / 명세 먼저` preset은 clean git 저장소라면 제한적으로 병렬 실행(`한 번에 2개`)을 쓸 수 있습니다.
- 저장소가 dirty 상태면 shared workspace fallback 때문에 같은 preset이어도 순차 실행으로 자동 다운그레이드됩니다.
- Supervisor 런타임은 `.harness-web/supervisors.json`에 저장되어, 재시작 후에도 paused/running 자동화 상태를 복원합니다.
