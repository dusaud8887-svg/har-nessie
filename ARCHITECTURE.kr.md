# Architecture

한국어 · [English](./ARCHITECTURE.md)

## 제품 구조

Har-Nessie는 장기 프로젝트 작업을 위한 로컬 웹 하네스입니다.
한 번의 프롬프트보다, 작업이 이어지는 구조를 기준으로 설계했습니다.

작동 모델은 이렇습니다.

`project -> phase -> run -> task`

## 핵심 원칙

1. 사람은 목표와 승인 지점을 맡습니다.
2. 하네스는 상태, 범위, 검증, 복구를 맡습니다.
3. 문서와 저장소 문맥은 다음 run으로 이어져야 합니다.
4. 로컬 머신 설정은 저장소를 바꾸지 않고도 하네스를 안내할 수 있어야 합니다.

## 하네스 엔지니어링 관점

Har-Nessie는 모델을 제품 전체로 보지 않고, 더 큰 제어 루프 안의 한 요소로 봅니다.
실제로 중요한 건 모델 바깥의 루프입니다.

- 실행 전 preflight와 신뢰도 계산
- 실행 전후 문서와 저장소 상태를 구조화해 읽는 것
- 실행 뒤 기계적 검증을 남기는 것
- 실패했을 때 복구와 다음 run 연결을 함께 다루는 것

즉 `에이전트가 답했다`보다 `run이 운영 가능하게 남았다`를 더 중요하게 둡니다.

## 런타임 구성

```text
User
  -> Local Web UI
  -> 프로젝트 분석 / run 생성
  -> clarify / 승인 / 재시도 / 재개

Web app
  -> app/server.mjs
  -> app/orchestrator.mjs
  -> app/project-workflow.mjs
  -> app/project-health.mjs
  -> app/project-intel.mjs
  -> app/memory-store.mjs

Filesystem
  -> runs/<run-id>/*
  -> projects/<project-id>/*
  -> memory/projects/<project-key>/*
```

## 주요 런타임 계층

- `server.mjs`
  - 로컬 HTTP API와 UI 진입점
- `orchestrator.mjs`
  - run 루프 조율과 런타임 호출
- `project-workflow.mjs`
  - intake와 preflight 보조 로직
- `project-health.mjs`
  - 프로젝트 건강도, 연속성, 장기 운영 체크
- `project-intel.mjs`
  - 프로젝트 분석과 문서 탐색
- `memory-store.mjs`
  - 장기 메모리와 검색

## run 안에서 일어나는 일

1. 사용자가 목표와 프로젝트 경로를 정합니다.
2. preflight가 환경과 신뢰도를 확인합니다.
3. Har-Nessie가 문서, 저장소 상태, 로컬 설정에서 문맥을 모읍니다.
4. 범위가 느슨하면 clarify가 먼저 돌고
5. 계획이 만들어지고
6. 사람이 승인하거나 조정하고
7. task가 실행되고
8. 검증이 돌고
9. 검토와 목표 확인이 다음 진행 여부를 정하고
10. 남길 가치가 있는 문맥은 프로젝트 메모리에 들어갑니다

## 왜 프로젝트가 중요한가

프로젝트 컨테이너가 있어야 장기 작업이 현실적으로 굴러갑니다.
여기에 이런 것이 남습니다.

- 기본값
- 단계
- 이어받기 정책
- 프로젝트 메모리
- 다음 run을 위한 연속성 신호

이 레이어가 없으면 매 run이 같은 문맥을 처음부터 다시 찾게 됩니다.

## 검증 모델

Har-Nessie는 모델 판단만 믿지 않습니다.
아래를 같이 씁니다.

- 에이전트 검토
- 하네스 강제 규칙
- 기록되는 검증 근거

그래서 UI도 단순한 의도가 아니라 실제 근거를 보여줄 수 있습니다.

## 연속성 모델

장기 작업을 서로 끊긴 프롬프트 묶음으로 보지 않습니다.
하네스는 아래를 통해 연속성을 유지합니다.

- 프로젝트 메모리
- 이어받을 작업
- 문서 drift 신호
- 권장 다음 작업 초안
- 단계 및 프로젝트 건강도 화면
