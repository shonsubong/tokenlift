# 16. GLM-5.2 멀티 양자화 · 멀티유저 온프렘 셋업

GLM-5.2 의 **여러 양자화 tier**(품질/속도/메모리 트레이드오프)를 사내에 서빙하고, **여러
TokenLift 사용자**가 공유 엔드포인트로 쓰게 만든다. NemoClaw 는 GLM-5.2 를 직접 호스팅하지
않고, **당신이 llama.cpp/vLLM 로 띄운 GLM-5.2 서버로 라우팅**(`compatible-endpoint`)한다 —
즉 [14. GLM-5.2 × llama.cpp](./14-glm-llamacpp.md) 로 서버를 띄우고 그 앞에 NemoClaw
게이트웨이가 서는 구조다.

> 출처: [Unsloth GLM-5.2 GGUF](https://huggingface.co/unsloth/GLM-5.2-GGUF) ·
> [Unsloth: GLM-5.2 Run Locally](https://unsloth.ai/docs/models/glm-5.2) ·
> [NemoClaw: Use a Local Inference Server](https://docs.nvidia.com/nemoclaw/user-guide/openclaw/inference/use-local-inference) ·
> [NemoClaw Inference Options](https://docs.nvidia.com/nemoclaw/user-guide/openclaw/inference/inference-options)

## 16.1 양자화 tier (Unsloth Dynamic GGUF)

`unsloth/GLM-5.2-GGUF` 는 1~8bit 전 범위를 imatrix 로 양자화해 제공한다. 전체는 ~1.51TB.

| tier(alias) | quant 폴더 | 크기(근사) | 정확도 | 용도 |
|---|---|---|---|---|
| `glm-5.2-q1` | `UD-IQ1_S` | ~217GB | ~76% | 메모리 극한 |
| `glm-5.2-q2` | `UD-IQ2_M` | ~239GB | ~82% | **빠름/저비용**(explain/docs/fast) |
| `glm-5.2-q4` | `UD-Q4_K_XL` | ~380GB+ | 거의 무손실 | **균형 기본**(gen/edit/test) |
| `glm-5.2-q5` | `UD-Q5_K_XL` | 더 큼 | 거의 무손실 | 고품질 |
| `glm-5.2-q8` | `Q8_0` | ~801GB | 최고 | **최고품질**(reason/review/agent) |

분할 GGUF 예: `UD-IQ2_M/GLM-5.2-UD-IQ2_M-00001-of-00006.gguf`(첫 shard 지정 시 자동 이어읽기).

### ⚠️ 메모리 현실
tier 하나가 217GB~801GB다. **한 노드에 대형 tier 여러 개를 동시 적재하는 건 대개 불가능**하다.
현실적 전략:
- **노드 분산**: H200 노드A=q8, 노드B=q4, 소형 노드=q2 처럼 tier 를 노드로 나눈다.
- **메모리에 맞는 1~2개만**: 대부분은 `q4`(균형) 하나 + `q2`(빠름) 하나면 충분.
- **llama-swap**: 한 엔드포인트에서 여러 model id 를 온디맨드 로드/언로드(스왑 비용 있음).
- **멀티유저 동시성**: 큰 모델 하나를 vLLM(높은 동시성) 또는 llama-server `-np N`(병렬 슬롯)로
  여러 사용자가 공유. 처리량이 필요하면 vLLM 을 권장.

## 16.2 tier 서빙 — fleet 스크립트

[`scripts/run-glm-fleet.sh`](../scripts/run-glm-fleet.sh) 가 매니페스트
([`scripts/glm-fleet.example.conf`](../scripts/glm-fleet.example.conf))의 각 tier 를
[`run-glm-llamacpp.sh`](../scripts/run-glm-llamacpp.sh) 로 기동한다.

```conf
# alias          quant         port  ngl  n_cpu_moe  ctx
glm-5.2-q8       Q8_0          8088  99   0          16384
glm-5.2-q4       UD-Q4_K_XL    8084  99   0          16384
glm-5.2-q2       UD-IQ2_M      8082  99   24         32768
```

```bash
# 멀티유저 공유(사내망) + 공통 Bearer 토큰으로 기동
HOST=0.0.0.0 API_KEY="$TEAM_TOKEN" bash scripts/run-glm-fleet.sh start
bash scripts/run-glm-fleet.sh status      # 각 tier /health 확인
bash scripts/run-glm-fleet.sh print       # 실행 명령만 미리보기(드라이런)
bash scripts/run-glm-fleet.sh stop        # 기동한 tier 종료
```
- `alias` 는 **TokenLift onprem-glm 의 model id 와 일치**해야 한다(`glm-5.2-q8/q4/q2`).
- 노드별로 나눠 배치하면 각 노드에서 해당 tier 만 담은 매니페스트로 `start`.
- 프로덕션 상시 서빙은 systemd/k8s 로 감독하는 것을 권장(스크립트는 nohup 백그라운드).
- 멀티유저 인증: `API_KEY`(공통) 또는 `API_KEY_FILE`(줄당 토큰=사용자별) 로.

## 16.3 두 가지 배치 형태

### (A) 앞단 게이트웨이가 여러 tier 를 host 하나로 합침 (권장, 멀티유저)
NemoClaw `compatible-endpoint` 또는 `llama-swap` 이 여러 tier 를 하나의 `/v1` 엔드포인트로
노출하고 model id 로 구분한다. TokenLift 는 **단일 `onprem-glm` provider** 로 model id(=tier)만
바꿔 선택한다(기본 설정이 이 형태).

```
사용자들 → onprem-glm(host=게이트웨이) ─(model=glm-5.2-q8|q4|q2)→ 각 tier 서버
```

### (B) tier 별 포트 직결 (게이트웨이 없이)
tier 가 서로 다른 포트에 있고 앞단 라우터가 없다면, TokenLift provider 를 tier 별로 분리한다.
`~/.tokenlift/config.json` 에:

```jsonc
"providers": {
  "onprem-glm-q8": { "type": "openai-compat", "host": "http://h200a.internal:8088", "apiPath": "/v1",
                     "apiKeyEnv": "ONPREM_API_KEY", "timeoutMs": 1800000, "models": ["glm-5.2-q8"],
                     "sampling": { "temperature": 1.0, "top_p": 0.95, "top_k": 40 },
                     "routing": { "default": "glm-5.2-q8" } },
  "onprem-glm-q4": { "type": "openai-compat", "host": "http://h200b.internal:8084", "apiPath": "/v1",
                     "apiKeyEnv": "ONPREM_API_KEY", "models": ["glm-5.2-q4"],
                     "routing": { "default": "glm-5.2-q4" } },
  "onprem-glm-q2": { "type": "openai-compat", "host": "http://gpu.internal:8082", "apiPath": "/v1",
                     "apiKeyEnv": "ONPREM_API_KEY", "models": ["glm-5.2-q2"],
                     "routing": { "default": "glm-5.2-q2" } }
}
```
사용: `tokenlift gen "..." --provider onprem-glm-q4`. oracle 체인도 원하면
`["onprem-glm-q8","onprem-glm-q4",...]` 로 구성.

## 16.4 TokenLift 라우팅 (task 난도 → tier)

기본 `onprem-glm` 은 task 난도별로 tier 를 고른다:

| task | tier | 이유 |
|---|---|---|
| reason / agent / review | `glm-5.2-q8` | 최고품질(어려운 추론·검토) |
| gen / edit / test / refactor / translate | `glm-5.2-q4` | 균형(거의 무손실, 대량 생성) |
| explain / docs / fast | `glm-5.2-q2` | 빠름·저비용 |

```bash
tokenlift models --provider onprem-glm    # 서빙 중 tier + task→tier 매핑 + 존재 확인
tokenlift gen "결제 검증 로직" --provider onprem-glm            # 기본 q4
tokenlift gen "동시성 큐 알고리즘" --role oracle --think on      # reason=q8
tokenlift explain -f huge.log --provider onprem-glm -m glm-5.2-q2  # 특정 tier 강제
```
> ⚠️ `routing.byTask` 의 tier 는 **실제 서빙 중인 것**과 맞춰야 한다. q8 을 안 띄웠으면
> reason/review 를 q4 로 바꾸거나, oracle 폴백이 다음 백엔드로 강등되게 둔다.

## 16.5 멀티유저 온보딩 (각 사용자 PC)

서버 관리자는 16.2 로 tier 를 1회 서빙한다. 각 사용자는:

1. `~/.tokenlift/config.json` 에 공유 엔드포인트를 가리키게 한다(팀 기본을 덮어씀):
   ```jsonc
   { "providers": { "onprem-glm": { "host": "http://glm-gw.internal:8080" } } }
   ```
2. 발급받은 토큰을 환경변수로:
   ```bash
   export ONPREM_API_KEY="사용자토큰"     # bash / WSL2
   $env:ONPREM_API_KEY="사용자토큰"        # PowerShell
   ```
3. 점검·사용:
   ```bash
   tokenlift doctor  --provider onprem-glm     # 연결 + tier 존재 확인
   tokenlift warmup  --provider onprem-glm -m glm-5.2-q4   # 콜드 로드 미리(대형은 김)
   ```

Windows 사용자는 [15. NemoClaw 보안](./15-nemoclaw-windows-security.md) 의 `tokenlift secure`
로 Bedrock 은 게이트웨이 필터, **온프렘 GLM 엔드포인트는 `exemptHosts` 에 넣어 직결(예외)** 로
둔다. 즉 사내 GLM tier 위임은 필터 없이 빠르게, 외부 Bedrock 만 보안 필터를 거친다.

## 16.6 주의
- **콜드 로드/타임아웃**: 대형 tier 는 로드가 길다. `timeoutMs`(기본 30분) 유지, warmup 활용.
  NemoClaw `compatible-endpoint` 는 `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` 미반영 이슈(#2403)가
  있으니 스트림이 60s 로 끊기면 버전/설정 확인.
- **동시성**: llama-server `-np`(PARALLEL) 또는 vLLM 으로 사용자 수에 맞게 슬롯 확보.
- **model id 일치**: fleet alias = TokenLift model id = (게이트웨이 사용 시)라우터가 노출하는 id.
- **메모리**: 16.1 의 크기표로 노드에 맞는 tier 만 서빙. 안 맞으면 `tokenlift models` 가 ⚠️ 표시.
