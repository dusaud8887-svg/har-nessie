<p align="center">
  <img src="docs/screenshots/banner.png" alt="Har-Nessie — Surfacing your deep issues." width="100%">
</p>

# Har-Nessie

한국어 · [English](./README.md)

**세션이 끝나면 AI는 당신 프로젝트를 잊어버린다. Har-Nessie는 안 그래.**

다 겪어봤을 거다. 1번 세션: 한 시간 써서 AI에 프로젝트 설명. 2번 세션: 처음부터 다시 설명. 3번 세션: 또. 실패한 시도? 흔적 없음. 열심히 쌓은 맥락? 증발. 매번 제로에서 시작.

이건 모델 문제가 아니다. **하네스 문제다.**

폴더 하나 줘라 — 코드, 노트, 계획서, PDF, 뭐든. 그리고 뭘 하고 싶은지 말해라. Har-Nessie가 전부 읽고, 계획 짜고, 실제로 하고, *무슨 일이 있었는지 기억한다*. 다음 세션은 직전 세션이 끝난 지점부터 시작된다.

```
문서 → run → 메모리 → 다음 run
```

**Codex CLI**, **Claude Code**, **Gemini CLI** 전부 지원.  
전부 로컬에서 돌아간다. 클라우드 계정 없음. npm install 없음.  
**개발자 아니어도 된다.** 노트 폴더 주면 알아서 한다.

---

## "하네스"라고 부르는 데 이유가 있다

Anthropic이 [이걸 연구로 발표](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)하면서 *하네스 엔지니어링*이라고 불렀다 — 모델을 감싸는 루프가 모델 자체만큼 중요하다는 것. 같은 AI, 더 나은 하네스 = 완전히 다른 결과.

대부분의 도구는 모델을 준다. Har-Nessie는 하네스다.

실제로 뭐가 다르냐면:

- **run 전** — preflight가 *실제로 얼마나 안전하게 맡길 수 있는지* 점수로 보여준다. "준비됨" 같은 말 아님. 숫자.
- **run 중** — 프롬프트만 보는 게 아니라 실제 문서와 저장소를 읽는다. 추측이 아닌 근거.
- **run 후** — 검증 근거를 눈으로 확인할 수 있다: `TEST / STATIC / BROWSER / MANUAL`. **vibes가 아닌 proof.**
- **뭔가 실패하면** — 왜 실패했고 뭘 시도했고 다음엔 뭘 해야 하는지 맥락 통째로 보여준다. 끊긴 세션 앞에서 멍 때리는 일 없음.
- **다음번엔** — 5번째 세션이 1~4번째 세션에서 발견한 걸 알고 있다. 하네스가 쌓인다. 모델이 매번 다시 배울 필요 없다.

<p align="center">
  <img src="docs/screenshots/screenshot-project-board.png" alt="Project board — 다음 run 초안, 장기 헬스 체크, 연속성 신호" width="100%">
  <br><em>프로젝트 보드 — 다음 run이 이미 초안 잡혀 있고, 헬스 신호, 연속성 한 눈에</em>
</p>

---

## 빠른 시작

```sh
# macOS / Linux
./harness.sh

# Windows
harness.cmd
```

브라우저에서 로컬 주소를 열어라.  
저장소나 문서 폴더가 있으면: **새 프로젝트 → 프로젝트 분석**.

<p align="center">
  <img src="docs/screenshots/screenshot-home.png" alt="홈 — 프로젝트 분석 진입점" width="80%">
  <br><em>폴더 하나 주면 나머지는 알아서.</em>
</p>

## 필요 조건

- Node.js 22 이상
- 아래 CLI 중 하나 이상 설치 및 인증 완료
- 하네스 자체에 별도 npm install이나 클라우드 계정 불필요

## CLI 지원

세 가지 주요 에이전트 CLI 전부 지원. 이미 있는 걸 쓰면 된다.

| CLI | 설치 방법 |
|-----|----------|
| [Codex CLI](https://github.com/openai/codex) | `npm i -g @openai/codex` — ChatGPT Plus/Pro |
| [Claude Code](https://github.com/anthropics/claude-code) | `npm i -g @anthropic-ai/claude-code` — Anthropic 구독 |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm i -g @google/gemini-cli` — Google 계정 |

같은 run 안에서 계획은 하나, 구현은 다른 CLI로 섞어 쓸 수도 있다.

전역 설정에서 Codex 기본 모델을 `GPT-5.4`로 유지하면서 필요할 때 `GPT-5.3-Codex-Spark`로 바꾸고, Codex fast mode도 설정 파일을 직접 열지 않고 켜고 끌 수 있다.

<p align="center">
  <img src="docs/screenshots/screenshot-create-run.png" alt="run 만들기 — 폴더, 목표, 선택적 제약" width="80%">
  <br><em>폴더 + 목표. 하네스가 나머지를 처리한다.</em>
</p>

## 이게 맞는 경우

- AI가 세션마다 처음부터 다시 시작하는 데 지쳤다면
- 코드가 아니어도 — 노트, 기획서, 논문, 매뉴얼 폴더도 OK. **코딩 몰라도 됨.**
- 한 번에 끝나지 않는 작업
- "모델이 완료라고 했는데" 믿었다가 데인 적 있다면
- 실제로 무슨 일이 있었는지 보고 싶다면 — AI가 자신 있어 보였는지 말고

## 저장 경로 (전부 로컬)

```
runs/<run-id>/
projects/<project-id>/
memory/projects/<project-key>/
.harness-web/settings.json
```

전부 로컬. 기본적으로 gitignore에 포함됨.

선택한 Codex 모델과 Codex fast mode 설정도 이 로컬 설정 파일에 저장된다.

## 문서

- [사용자 가이드](./USER_GUIDE.kr.md)
- [구조 설명](./ARCHITECTURE.kr.md)
- [운영 가이드](./OPERATIONS.kr.md)
- [배포 가이드](./DEPLOYMENT.kr.md)

## 개발 확인

```sh
npm run validate
```
