# Deployment

한국어 · [English](./DEPLOYMENT.md)

## 지원하는 배포 방식

Har-Nessie는 로컬 앱으로 쓰는 것이 기본입니다.
보통 아래 두 방식으로 전달합니다.

1. Git으로 공유
2. 폴더나 zip으로 공유

클라우드 서비스 형태 배포는 기본 모델이 아닙니다.

## Git 공유

이런 경우에 좋습니다.

- 팀이 이미 Git을 쓰고 있음
- 업데이트와 이력을 추적하고 싶음

권장 순서:

1. 저장소를 clone 또는 pull
2. Windows에서는 `harness.cmd`, macOS/Linux에서는 `./harness.sh` 실행
3. 로컬 웹 UI 열기

아래 경로는 코드 교체와 분리해서 관리하는 편이 좋습니다.

- `memory/`
- `runs/`
- `projects/`
- `.harness-web/settings.json`

## 폴더 또는 zip 전달

이런 경우에 좋습니다.

- 받는 사람이 Git을 쓰지 않음
- 그냥 실행 가능한 폴더를 넘기고 싶음

권장 순서:

1. 폴더나 zip을 전달
2. 로컬에 풀기
3. 런처 실행

macOS/Linux에서 실행 권한이 빠졌다면:

```bash
chmod +x harness.sh
```

## 안전하게 업데이트하기

새 버전으로 옮길 때는:

1. 코드와 공개 문서를 새 버전으로 교체하고
2. 로컬 상태는 따로 보존하고
3. 위험한 업데이트 전에는 로컬 상태를 백업합니다

보통 유지하는 편이 좋은 것:

- `memory/`
- `.harness-web/settings.json`

선택:

- `runs/`
- `projects/`

## CLI provider 지원

세 CLI 모두 동등하게 지원합니다. 기본값은 없습니다.

| CLI | 설치 방법 |
|-----|-----------|
| Codex CLI | `npm i -g @openai/codex` — ChatGPT Plus 또는 Pro 필요 |
| Claude Code | `npm i -g @anthropic-ai/claude-code` — Anthropic 구독 필요 |
| Gemini CLI | `npm i -g @google/gemini-cli` — Google 계정 필요 |

설치된 CLI 중 하나를 쓰면 됩니다. 같은 run 안에서 계획과 구현에 서로 다른 CLI를 쓸 수도 있습니다.
배포 패키지 자체는 특정 CLI를 요구하지 않으며, 사용하기로 선택한 CLI만 있으면 됩니다.

## 공개 문서 세트

- [README.kr.md](./README.kr.md)
- [USER_GUIDE.kr.md](./USER_GUIDE.kr.md)
- [OPERATIONS.kr.md](./OPERATIONS.kr.md)
- [ARCHITECTURE.kr.md](./ARCHITECTURE.kr.md)
