> Historical architecture proposal. The [PRD v1.4](PRD.md) supersedes its per-bot computer, three-preset and serial execution assumptions. Current requirements use one shared computer per user, at least ten presets, custom bots, durable memory and parallel bot collaboration. This document is not current implementation guidance for those decisions.

## 1. Executive verdict

**A ideia é tecnicamente viável, e E2B Desktop é uma boa escolha para esta V0.**
Eu manteria Next.js, Vercel, Supabase e OpenAI.
Acrescentaria **Trigger.dev como executor dos trabalhos**, independente das requisições HTTP.
A abstração correta é **“1 bot = 1 workspace durável + 1 computador exclusivo, retomável e substituível”**.
Na prática, começaria reutilizando o mesmo sandbox por bot, criado apenas quando necessário.
Usaria **Responses API diretamente**, com um loop pequeno e explícito.
Surf serviria como referência de implementação, não como fundação do backend público.
Para assistir ao trabalho, começaria com screenshots frequentes e acesso autenticado pelo app.
O maior risco é lançar um computador autônomo irrestrito antes de controlar autorização, execução e gasto.

**Base da análise:** documentação consultada em **6 de setembro de 2026** e inspeção do Surf no commit [`d2a98aa`](https://github.com/e2b-dev/surf/tree/d2a98aa9d0cd67db5146bec843a296f132d443f5), de 10 de julho de 2026. Não executei sandboxes pagos nem benchmarks; metas de desempenho, limites de produto e projeções de consumo abaixo são propostas minhas.

---

## 2. Arquitetura recomendada

```text
                            USER'S BROWSER
                  +--------------------------------+
                  | Messenger UI                   |
                  | Contacts / Chat / Watch / Stop |
                  +-------------+------------------+
                                |
                      HTTPS: short requests
                                |
                  +-------------v------------------+
                  | Next.js on Vercel              |
                  |                                |
                  | Validate session and ownership |
                  | Validate task and quota        |
                  | Persist message + queued run   |
                  | Dispatch work                  |
                  +-------+----------------+-------+
                          |                |
                          |                | Trigger(run_id)
                          v                v
                +----------------+  +--------------------------+
                | Supabase       |  | Trigger.dev Cloud        |
                |                |  |                          |
                | Auth           |  | Durable task execution   |
                | Postgres       |<-| Agent loop               |
                | Private Storage|  | Budget + cancellation    |
                | Realtime       |  | Sandbox lifecycle        |
                +-------+--------+  | Recovery / reconciliation |
                        ^           +------+------------+------+
                        |                  |            |
                        |                  v            v
                        |           +-------------+ +----------------+
                        |           | OpenAI      | | E2B Desktop    |
                        |           | Responses   | |                |
                        |           | API         | | Exclusive bot  |
                        |           +------+------+ | computer       |
                        |                  |        | Browser        |
                        |                  |        | Filesystem     |
                        |                  |        | Controlled tools|
                        |                  |        +-------+--------+
                        |                  |                |
                        |                  +----------------+
                        |                     Worker executes
                        |                     model tool calls;
                        |                     sends observations
                        |
          Persisted messages, run state, selected events,
          exported artifacts and temporary desktop frames
                        |
                        v
                  Supabase Realtime
                   private channels
                        |
                        v
                    Messenger UI

WATCH PATH:
E2B screenshot -> worker -> private Storage -> authenticated browser

RECOVERY PATH:
Scheduled reconciler -> queued/stale runs -> dispatch or safe failure
                                         -> pause orphaned sandboxes
```

**Quem coordena é o worker.** OpenAI decide quais ferramentas solicitar. E2B executa as operações que seu código encaminha. Supabase registra a verdade do produto.

O E2B não precisa receber sua chave OpenAI, credenciais de banco ou chave administrativa do Supabase.

Também não existe um processo permanentemente ligado para cada personalidade. O bot existe no banco; o trabalho existe em um `run`; o computador existe quando necessário.

### A promessa de produto que eu assumiria

> Cada bot tem seu próprio espaço de trabalho e computador. Seus arquivos permanecem disponíveis entre tarefas; o computador pode dormir quando não está trabalhando.

Eu evitaria prometer que processos, conexões e sessões de terceiros funcionarão eternamente sem interrupção.

---

## 3. Decisões técnicas

| Decision | Choice | Why | Alternative rejected |
|---|---|---|---|
| Frontend | Next.js + TypeScript + CSS/Tailwind | Rapidez para construir a experiência Messenger | Framework próprio de janelas |
| Hosting | Vercel | Publicação simples e bom encaixe com Next.js | Hospedar tudo em uma VM |
| Auth | Supabase Auth, inicialmente Google OAuth | Login pronto; dispensa montar entrega de e-mail no primeiro dia | Autenticação própria |
| DB | Supabase Postgres | Transações, constraints, RLS e consulta operacional | Estado apenas em Redis ou na memória |
| Agent framework | SDK oficial OpenAI + Responses API diretamente | Um loop, um agente por execução e controle explícito | Agents SDK nesta V0 |
| Modelo inicial | `gpt-5.6-sol`, esforço `medium` | Suporta computer use; ponto de partida para medir qualidade e custo | Seleção automática entre vários modelos |
| Computer runtime | E2B Desktop | Desktop, ferramentas e persistência já integrados | Infraestrutura própria |
| Eventos do produto | Supabase Realtime Broadcast privado | Independente do worker e da conexão HTTP original | Servidor WebSocket próprio |
| Watch Bot Work | Screenshots de aproximadamente 1 fps | Visualização real com autorização simples e sem controle remoto exposto | noVNC público diretamente |
| Background jobs | Trigger.dev Cloud | Execução gerenciada, concorrência, cancelamento e tarefas de reconciliação | Temporal, Redis + BullMQ |
| Persistência | Mesmo sandbox retomável + arquivos importantes no Storage | Preserva a experiência e permite recuperação parcial | Sandbox como única fonte dos dados |
| Observabilidade | Logs estruturados, painel Trigger.dev e registros de runs | Suficiente para encontrar falhas e medir custo | Plataforma própria de tracing |

A documentação atual mostra suporte a computer use no Sol. A escolha de modelo é uma hipótese inicial de engenharia, não um resultado de comparação executada neste produto. [Modelo GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol).

### E2B versus alternativas para este produto

As avaliações de esforço e adequação são meu julgamento; as capacidades e preços têm fontes oficiais.

| Opção | Desktop, browser, terminal e arquivos | Persistência e retomada | Visualização | Custo e conclusão para esta V0 |
|---|---|---|---|---|
| **E2B Desktop** | Ambiente desktop integrado | Pause/resume preserva disco e RAM | noVNC e screenshots | Melhor encaixe inicial. Com 2 vCPU e 4 GiB: **US$0,1656/h** de compute |
| **Daytona** | Computer Use, VNC, terminal e filesystem | Containers preservam disco; VMs também oferecem pause/resume de memória | VNC/noVNC | Concorrente direto. Mesmo preço nominal de CPU/RAM usado acima, com cobrança de disco conforme estado |
| **Modal** | Sandbox forte para código; desktop exige montagem | Volumes e snapshots; snapshots de memória têm restrições | Exige configurar desktop e transporte visual | Bom para agentes de código/data. Menos direto para esta demo |
| **Fly Machines** | VM Linux; você configura o desktop | Volumes e estados de stop/suspend | Você configura e protege | Viável, mas aumenta trabalho operacional |
| **Railway** | Bom para hospedar serviços e workers; desktop é customizado | Volumes persistentes | Você implementa | Alternativa ao hosting do worker, pouco atraente como frota de PCs por usuário |
| **Browserbase** | Browser gerenciado; não substitui o computador desktop completo proposto | Contextos de browser, não RAM e filesystem de um PC geral | Live View embutível | Excelente se o produto virar “cada bot tem um browser” |
| **Browser Use Cloud** | Agente web hospedado ou browser acessível por CDP | Persistência orientada ao browser | Recursos de acompanhamento do browser | Muito atraente para automação web, mas muda a abstração central |
| **Playwright + Browserless** | Browser remoto; Playwright é biblioteca de automação | Sessões conforme o provedor | Streaming de páginas/replays | Bom para browser, não resolve sozinho terminal e desktop |
| **Docker/Firecracker próprios** | Flexibilidade total | Você implementa volumes, snapshots e recuperação | Você implementa | Rejeitado para amanhã: operação e isolamento viram seu produto |
| **Cloud VMs, como EC2** | Computador completo | Disco durável; hibernação em configurações compatíveis | Você configura | Funciona, mas provisionamento, imagens e segurança custam tempo |
| **Vercel Sandbox** | MicroVM para execução isolada | Imagens e mecanismos de persistência do serviço | Desktop não vem como a integração E2B Desktop | Candidato futuro; não confundir com Vercel Functions |

Fontes: [E2B pricing](https://e2b.dev/pricing), [Daytona Computer Use](https://www.daytona.io/docs/en/computer-use/), [persistência Daytona](https://www.daytona.io/docs/en/persistence/), [billing Daytona](https://www.daytona.io/docs/en/billing/), [Modal Sandboxes](https://modal.com/docs/guide/sandboxes), [Fly Machines](https://fly.io/docs/machines/machine-states/), [Railway volumes](https://docs.railway.com/volumes/reference), [Browserbase Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view), [Browser Use Cloud](https://docs.browser-use.com/cloud/quickstart), [Browserless](https://www.browserless.io/pricing), [Firecracker](https://firecracker-microvm.github.io/), [EC2 hibernation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Hibernate.html), [Vercel Sandbox](https://vercel.com/docs/sandbox).

Algumas diferenças relevantes de preço:

- **Daytona:** US$0,0504/vCPU/h e US$0,0162/GiB/h; disco publicado a US$0,000108/GiB/h após a franquia indicada. [Preços](https://www.daytona.io/pricing).
- **Modal Sandbox:** US$0,00003942 por core físico/segundo, equivalente a 2 vCPU, mais US$0,00000667/GiB/segundo. Com essa configuração nominal e 4 GiB, aproximadamente **US$0,238/h**. Isso não é uma comparação de desempenho equivalente. [Preços](https://modal.com/pricing).
- **Browserbase Developer:** US$20/mês, 100 horas de browser incluídas, depois US$0,12/h. [Preços](https://www.browserbase.com/pricing).
- **Browser Use:** browser a US$0,02/h; proxy gerenciado a US$5/GB ou egress sem esse proxy a US$0,20/GB. O agente hospedado tem cobrança adicional. [Preços](https://browser-use.com/pricing).
- **Fly:** volumes custam US$0,15/GB/mês provisionado, inclusive com a máquina parada. [Preços](https://fly.io/docs/about/pricing/).

**Minha escolha continua sendo E2B**, pela combinação de desktop pronto e retomada. Isso não significa que tenha superioridade comprovada em confiabilidade ou performance.

Para reduzir dependência do fornecedor, concentraria a integração em um único módulo com operações concretas: `ensureComputer`, `executeAction`, `captureFrame`, `pauseComputer`, `exportWorkspace`. Não criaria um framework universal de sandboxes.

---

## 4. Fluxo end-to-end

### Da mensagem até a conclusão

1. O navegador envia a mensagem com uma chave de idempotência.
2. A API valida a sessão e confirma que o bot pertence ao usuário.
3. Em uma transação, verifica crédito e concorrência, persiste a mensagem e cria um `run` em `QUEUED`.
4. A API solicita execução no Trigger.dev usando o identificador do run como parte da chave de idempotência.
5. Retorna `202 Accepted`. A página não precisa continuar conectada.
6. O worker reivindica o run e registra sua concessão de execução, com prazo de validade.
7. Carrega instruções do bot, conversa relevante e informações do workspace.
8. Quando necessário, cria ou retoma o computador exclusivo do bot.
9. Verifica desktop, browser, filesystem e políticas de rede.
10. Chama a Responses API.
11. Para cada ferramenta solicitada, valida a operação, orçamento e cancelamento antes de executar.
12. Executa a ação no E2B, captura o resultado e registra um checkpoint.
13. Devolve a observação à OpenAI e continua.
14. Ao terminar, exporta os arquivos entregáveis e persiste a resposta.
15. Marca o run como `SUCCEEDED`. O computador fica `READY`; a presença mostra **Available**.
16. Após uma pequena janela ociosa, pausa o computador; a presença passa a **Away — PC pausado**.

Conversas que não exigem ferramentas podem terminar sem criar ou acordar um sandbox.

### O loop de computer use

```text
Worker -> OpenAI: instructions + task + context + tools

OpenAI -> Worker:
  computer_call {
    call_id,
    actions: [click, type, scroll, ...]
  }

Worker:
  validate permissions and limits
  execute allowed actions, sequentially, in E2B
  capture screenshot
  persist confirmed step

Worker -> OpenAI:
  computer_call_output {
    call_id,
    output: computer_screenshot
  }

Repeat until:
  final answer / clarification / cancellation / limit / failure
```

A API atual usa o tool `computer` e pode retornar uma sequência de ações em `actions`. Seu programa executa essas ações. A documentação também apresenta computer use por execução de código, recomendado para Astra; para esta V0, prefiro ações estruturadas por serem mais simples de inspecionar e limitar. [Computer use](https://developers.openai.com/api/docs/guides/tools-computer-use).

Além disso, exporia poucas funções próprias:

```text
list_workspace_files
read_workspace_file
write_workspace_file
export_artifact
```

Se houver comandos de terminal na V0 pública, começaria com operações predefinidas e argumentos validados. Não exporia uma ferramenta irrestrita `run_any_shell_command`.

**Atenção:** retirar a ferramenta de shell não impede o agente de abrir um terminal pela GUI. A política do ambiente e os limites externos precisam assumir que o guest pode acabar executando código.

### Responses API, Agents SDK ou implementação própria?

Essas opções não estão no mesmo nível:

| Opção | O que resolve |
|---|---|
| Responses API | Interação com o modelo, respostas e ferramentas |
| Agents SDK | Loop, ferramentas, handoffs, estado e outros recursos sobre as APIs |
| Seu código | Regras do produto, autorização, limites, execução e persistência |

O Agents SDK atual já tem **Sandbox Agents em beta**, inclusive integrações com E2B e outros provedores. Portanto, seria errado descrevê-lo como incapaz de trabalhar com ambientes persistentes. [Sandbox Agents](https://developers.openai.com/api/docs/guides/agents/sandboxes).

**Escolha para esta V0: Responses API diretamente.** Você tem um loop simples, sem handoffs nem coordenação entre agentes. Implementaria apenas esse loop e suas regras, não um framework de agentes.

Usar `previous_response_id` pode simplificar a continuação dentro de um run. Isso não substitui seu histórico no banco, nem torna gratuito o contexto anterior. Mantenha também um checkpoint recuperável e envie as instruções apropriadas em cada chamada. [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state).

### Jobs de 2 minutos a 1 hora

| Duração | Responsável recomendado |
|---|---|
| 2 minutos | Trigger.dev |
| 10 minutos | Trigger.dev |
| 30 minutos | Trigger.dev, se o produto permitir |
| 1 hora | Trigger.dev + limites adequados do E2B; fora da V0 inicial |

A Vercel documenta até 300 segundos no Hobby e extensão beta até 1.800 segundos para Pro/Enterprise em runtimes compatíveis com Fluid Compute. Isso continua sendo uma execução HTTP com duração limitada, não sua estratégia de recuperação de agentes. [Limites atuais](https://vercel.com/docs/functions/configuring-functions/duration).

Trigger.dev permite tarefas longas e oferece `maxDuration` configurável. **Eu configuraria um limite**, mesmo que o serviço permita execução indefinida. [Tasks](https://trigger.dev/docs/tasks/overview).

Não usaria:

- **Temporal:** desproporcional ao fluxo atual.
- **Inngest:** alternativa válida, mas não há motivo para adotar dois executores; seu modelo de execução também precisa respeitar onde os steps rodam. [Inngest Functions](https://www.inngest.com/docs/learn/inngest-functions).
- **Cloud Tasks sozinho:** entrega trabalho a um handler; não fornece seu computador nem remove os limites do handler. HTTP tasks têm deadline máximo documentado de 30 minutos. [Cloud Tasks](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks).
- **OpenAI background mode como substituto do worker:** mantém geração assíncrona do modelo, mas seu programa continua responsável pelas ferramentas externas. [Background mode](https://developers.openai.com/api/docs/guides/background).
- **E2B “rodando sozinho”:** processos podem continuar dentro dele, mas alguém ainda precisa coordenar o agente. Colocar esse coordenador no ambiente controlado pelo modelo mistura confiança e execução.

---

## 5. Bot state machine

**Não usaria um único enum para representar bot, tarefa e máquina.** São três entidades diferentes.

### Estado do bot

```text
ENABLED <-> DISABLED
```

Identidade e disponibilidade administrativa.

### Estado do run

```text
QUEUED
  |
  v
STARTING
  |
  v
RUNNING <------------------+
  |                        |
  +--> WAITING_FOR_USER ----+
  |
  v
FINALIZING
  |
  v
SUCCEEDED

Any active state:
  -> CANCELLED
  -> FAILED
  -> TIMED_OUT
  -> BUDGET_EXCEEDED
```

`WAITING_FOR_USER` salva o ponto de continuação e libera compute. Na V0, pode ser implementado como encerramento do job atual e novo dispatch do mesmo run, com um número de continuação.

### Estado do computador

```text
NOT_CREATED -> CREATING -> READY
                            |
                            v
                         PAUSING -> PAUSED
                            ^          |
                            |          v
                            +------ RESUMING -> READY

Any applicable state -> UNAVAILABLE
UNAVAILABLE -> recovery -> READY or replacement computer

Existing computer -> DESTROYING -> DESTROYED
```

### Projeção para o Messenger

Aplicar as regras em ordem de prioridade:

| Condição real | Presença | Subtexto |
|---|---|---|
| Bot desabilitado ou computador indisponível sem recuperação em curso | Offline | Indisponível |
| Run `QUEUED` | Busy | Na fila |
| Run `STARTING`, computador criando ou retomando | Busy | Ligando o computador |
| Run `RUNNING` | Busy | Trabalhando |
| Run `FINALIZING` | Busy | Salvando o resultado |
| Run `WAITING_FOR_USER` | Away | Preciso da sua resposta |
| Sem run ativo, computador `READY` | Available | Pronto |
| Computador `PAUSING` ou `PAUSED` | Away | PC pausado |
| Computador `NOT_CREATED` | Away | PC inicia na primeira tarefa |

Um run com falha não implica necessariamente um computador offline. O modelo pode falhar enquanto a máquina continua saudável.

Também separaria **Busy** de **typing**. Busy cobre todo o trabalho; typing aparece apenas quando há composição de uma mensagem destinada ao usuário.

---

## 6. Sandbox lifecycle

### Create

Criar apenas na primeira tarefa que precisa de computador.

Usar um template versionado contendo:

- Desktop Linux.
- Chrome em modo visível.
- Diretório `/home/user/workspace`.
- Ferramentas estritamente necessárias.
- Usuário sem privilégios administrativos.
- Configuração de segurança já aplicada.
- Nenhuma credencial ou dado de usuário.

O banco associa o computador ao bot. O cliente nunca escolhe o `sandbox_id`.

### Resume

Retomar sob exclusão mútua por bot e verificar:

1. A máquina corresponde ao bot esperado.
2. Desktop e browser respondem.
3. Diretório de trabalho existe.
4. As políticas de rede continuam corretas.
5. Não existe outra execução controlando mouse e teclado.

A documentação afirma que pause/resume salva filesystem e memória. Também informa aproximadamente um segundo para retomada e quatro segundos por GiB de RAM para pausar. Esses números não garantem que Chrome e sites estarão prontos nesse tempo. [Persistência E2B](https://docs.e2b.dev/sandbox/persistence).

### Run

Durante a execução:

- Atualizar heartbeat.
- Renovar o timeout do sandbox pelo worker.
- Conferir orçamento e cancelamento entre operações.
- Registrar progresso confirmado.
- Nunca executar dois controladores simultaneamente no mesmo desktop.

### Idle e pause

Após finalizar, manter uma janela ociosa curta, por exemplo **15 segundos**, e pausar.

Configurar explicitamente:

```ts
lifecycle: {
  onTimeout: "pause",
  autoResume: false
}
```

O comportamento padrão de timeout é `kill`, não pause. `autoResume: false` evita que uma requisição incidental acorde a máquina fora do fluxo autorizado. A documentação atual informa retenção indefinida para sandboxes pausados, sem cobrança enquanto pausados; os limites de 1 hora/Hobby e 24 horas/Pro se referem à execução contínua. [Lifetime](https://docs.e2b.dev/faq/sandbox-lifetime.md), [cobrança](https://docs.e2b.dev/faq/calculate-sandbox-price.md).

O temporizador de idle precisa revalidar o estado antes de pausar. Caso contrário, um cleanup atrasado pode pausar uma tarefa recém-iniciada.

### Destroy

Destruir apenas em:

- Exclusão ou reset solicitado.
- Recuperação de máquina comprovadamente irrecuperável.
- Incidente de abuso.
- Política de retenção explicitamente comunicada.

Antes de substituir, recuperar o que for possível e registrar a perda de estado. Não trocar silenciosamente o computador e fingir continuidade completa.

### O que exatamente persiste?

| Camada | Onde fica | O que garante |
|---|---|---|
| Identidade e instruções | Postgres | Quem é o bot |
| Histórico de conversa | Postgres | Mensagens e resumo relevante |
| Execução do agente | Run + checkpoint privado | Última etapa confirmada e contexto de continuação |
| Filesystem do computador | E2B pausado | Arquivos e ambiente preservados na retomada normal |
| RAM e processos | Estado pausado do E2B | Continuidade local, sujeita a falhas externas e reconexões |
| Browser profile | Disco/RAM do computador | Cookies e dados locais, conforme o próprio browser |
| Entregáveis importantes | Supabase Storage privado | Recuperação independente do sandbox |
| Estado operacional do produto | Postgres | Ownership, quotas, runs e referências |

### Segunda-feira → terça-feira

Na segunda:

1. O bot salva `research.md` no workspace.
2. O worker exporta esse arquivo e um manifesto para Storage.
3. Persiste resposta, resumo e conclusão do run.
4. Pausa o computador.

Na terça:

1. Retoma o mesmo sandbox.
2. Confere os arquivos.
3. Carrega a conversa relevante.
4. Verifica se o browser ainda está autenticado.
5. Continua ou informa que o site exige novo login.

**Preservar um cookie não garante uma sessão válida.** O site pode expirar ou revogar a sessão; conexões de rede precisam ser restabelecidas. Isso é independente da qualidade da persistência da VM.

Para a V0, backup externo cobre os entregáveis, não uma restauração perfeita de todo o PC. Snapshots reutilizáveis do E2B podem ampliar a recuperação depois, mas ainda permanecem dependentes do fornecedor. [Snapshots E2B](https://docs.e2b.dev/sandbox/snapshots).

Não montaria o perfil de Chrome sobre um volume S3/FUSE sem validar suas necessidades de locking e consistência.

---

## 7. Schema de dados

Usaria **sete tabelas de aplicação**, além de `auth.users`. `run_events` é a única adição à lista pedida: ela permite recuperar progresso e diagnosticar execuções.

Abaixo está a especificação do schema, não uma migration completa de produção.

```text
public.users
  id                  uuid PK -> auth.users.id
  created_at          timestamptz NOT NULL
  disabled_at         timestamptz NULL
  credit_balance_usd  numeric(12,6) NOT NULL DEFAULT 0
  reserved_usd        numeric(12,6) NOT NULL DEFAULT 0

bots
  id                  uuid PK
  user_id             uuid NOT NULL -> users.id
  kind                text NOT NULL
  name                text NOT NULL
  avatar_key          text NOT NULL
  instructions        text NOT NULL
  instructions_version integer NOT NULL DEFAULT 1
  enabled             boolean NOT NULL DEFAULT true
  created_at          timestamptz NOT NULL
  updated_at          timestamptz NOT NULL
  UNIQUE (user_id, kind)
  UNIQUE (id, user_id)

conversations
  id                  uuid PK
  bot_id              uuid NOT NULL
  user_id             uuid NOT NULL
  summary             text NULL
  created_at          timestamptz NOT NULL
  UNIQUE (bot_id)
  UNIQUE (id, user_id)
  UNIQUE (id, bot_id, user_id)
  FK (bot_id, user_id) -> bots(id, user_id)

messages
  id                  uuid PK
  conversation_id     uuid NOT NULL
  user_id             uuid NOT NULL
  role                message_role NOT NULL
  content             text NOT NULL
  idempotency_key     uuid NULL
  run_id              uuid NULL
  created_at          timestamptz NOT NULL
  UNIQUE (id, conversation_id, user_id)
  UNIQUE (user_id, idempotency_key)
  FK (conversation_id, user_id)
    -> conversations(id, user_id)

runs
  id                  uuid PK
  bot_id              uuid NOT NULL
  user_id             uuid NOT NULL
  conversation_id     uuid NOT NULL
  input_message_id    uuid NOT NULL
  status              run_status NOT NULL
  job_id              text NULL
  continuation        integer NOT NULL DEFAULT 0
  model               text NOT NULL
  instructions_version integer NOT NULL
  budget_usd          numeric(12,6) NOT NULL
  estimated_cost_usd  numeric(12,6) NOT NULL DEFAULT 0
  input_tokens        bigint NOT NULL DEFAULT 0
  cached_input_tokens bigint NOT NULL DEFAULT 0
  output_tokens       bigint NOT NULL DEFAULT 0
  tool_calls          integer NOT NULL DEFAULT 0
  checkpoint_key      text NULL
  result_manifest     jsonb NOT NULL DEFAULT '[]'
  cancel_requested_at timestamptz NULL
  heartbeat_at        timestamptz NULL
  lease_expires_at    timestamptz NULL
  execution_version   integer NOT NULL DEFAULT 0
  error_code          text NULL
  created_at          timestamptz NOT NULL
  started_at          timestamptz NULL
  finished_at         timestamptz NULL
  UNIQUE (id, user_id)
  UNIQUE (id, conversation_id, user_id)
  FK (bot_id, user_id) -> bots(id, user_id)
  FK (conversation_id, bot_id, user_id)
    -> conversations(id, bot_id, user_id)
  FK (input_message_id, conversation_id, user_id)
    -> messages(id, conversation_id, user_id)

sandboxes
  id                  uuid PK
  bot_id              uuid NOT NULL UNIQUE
  user_id             uuid NOT NULL
  provider            text NOT NULL DEFAULT 'e2b'
  provider_id         text NULL UNIQUE
  template_version    text NOT NULL
  generation          integer NOT NULL DEFAULT 0
  status              sandbox_status NOT NULL
  workspace_backup_key text NULL
  last_verified_at    timestamptz NULL
  paused_at           timestamptz NULL
  watch_until         timestamptz NULL
  created_at          timestamptz NOT NULL
  updated_at          timestamptz NOT NULL
  FK (bot_id, user_id) -> bots(id, user_id)

run_events
  seq                 bigint GENERATED ALWAYS AS IDENTITY PK
  run_id              uuid NOT NULL
  user_id             uuid NOT NULL
  type                text NOT NULL
  summary             text NULL
  metadata            jsonb NOT NULL DEFAULT '{}'
  created_at          timestamptz NOT NULL
  FK (run_id, user_id) -> runs(id, user_id)
```

Adicionar também a FK composta de `messages.run_id`, conversa e usuário para o run correspondente, após a criação das tabelas. `run_id` fica nulo para a mensagem inicial, evitando um ciclo na inserção.

Enums:

```text
message_role:
  user, assistant, system

run_status:
  queued, starting, running, waiting_for_user, finalizing,
  succeeded, failed, cancelled, timed_out, budget_exceeded

sandbox_status:
  not_created, creating, ready, pausing, paused, resuming,
  unavailable, destroying, destroyed
```

Índices principais:

```sql
CREATE INDEX messages_history
  ON messages (conversation_id, created_at, id);

CREATE INDEX runs_history
  ON runs (user_id, created_at DESC);

CREATE INDEX runs_dispatch
  ON runs (created_at)
  WHERE status = 'queued';

CREATE INDEX runs_recovery
  ON runs (lease_expires_at)
  WHERE status IN ('starting', 'running', 'finalizing');

CREATE INDEX run_events_replay
  ON run_events (run_id, seq);

CREATE UNIQUE INDEX one_open_run_per_bot
  ON runs (bot_id)
  WHERE status IN (
    'queued', 'starting', 'running',
    'waiting_for_user', 'finalizing'
  );

CREATE UNIQUE INDEX one_executing_run_per_user
  ON runs (user_id)
  WHERE status IN (
    'queued', 'starting', 'running', 'finalizing'
  );

CREATE UNIQUE INDEX one_final_answer_per_run
  ON messages (run_id)
  WHERE role = 'assistant' AND run_id IS NOT NULL;
```

Nesta V0, perguntas intermediárias podem ser eventos do run; `messages.run_id` identifica a resposta final.

Regras adicionais:

- Orçamento, reservas e contadores não podem ficar negativos.
- Reservar gasto em transação, com lock na linha do usuário.
- Chaves compostas impedem associações entre entidades de usuários diferentes.
- Ativar RLS nas tabelas expostas.
- Clientes não alteram runs, saldo, estado de sandbox ou eventos.
- `sandboxes`, checkpoints e campos operacionais têm acesso apenas pelo servidor.
- Respostas da API usam listas explícitas de campos; nunca `SELECT *` serializado.

RLS é uma segunda barreira. A chave de serviço pode contorná-la, portanto o worker continua precisando de verificações de ownership. [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

Não colocaria screenshots, vídeos ou grandes transcrições de ferramentas no Postgres.

---

## 8. API e eventos

### Endpoints mínimos

| Endpoint | Função |
|---|---|
| `GET /api/bots` | Lista contatos e presença derivada |
| `GET /api/bots/:botId/messages?cursor=...` | Histórico paginado |
| `POST /api/bots/:botId/messages` | Persiste mensagem e cria run |
| `GET /api/runs/:runId` | Estado atual e resultado |
| `GET /api/runs/:runId/events?after=...` | Recuperação de eventos persistidos |
| `POST /api/runs/:runId/cancel` | Solicita parada |
| `POST /api/runs/:runId/reply` | Responde a uma pergunta pendente |
| `POST /api/bots/:botId/watch` | Autoriza e renova visualização temporária |
| `DELETE /api/bots/:botId/watch` | Encerra visualização |
| `GET /api/runs/:runId/artifacts/:artifactId` | Autoriza download de entregável |

Os três bots são criados idempotentemente no onboarding. **Não precisa de `POST /bots`** se o usuário ainda não pode criar bots.

Também retiraria endpoints públicos de pause/resume. O lifecycle é uma consequência de enviar trabalho, cancelar e ficar ocioso.

Exemplo:

```json
{
  "message": "Compare these three tools and save a report.",
  "idempotency_key": "client-generated-uuid"
}
```

Resposta:

```json
{
  "message_id": "uuid",
  "run_id": "uuid",
  "status": "queued"
}
```

### Eventos

```text
run.queued
run.starting
run.started
activity.updated
run.waiting_for_user
artifact.created
run.completed
run.failed
run.cancelled
bot.presence_changed

desktop.frame_available  // transient, not persisted per frame
```

Envelope:

```json
{
  "version": 1,
  "event_id": "uuid",
  "seq": 42,
  "bot_id": "uuid",
  "run_id": "uuid",
  "type": "activity.updated",
  "timestamp": "ISO-8601",
  "data": {
    "summary": "Comparando as fontes encontradas"
  }
}
```

### SSE, WebSocket ou Supabase Realtime?

**Escolha: Supabase Realtime Broadcast privado para mensagens, presença e atividade.**

O worker persiste a mudança e a aplicação publica uma notificação sanitizada. A documentação recomenda Broadcast para escalabilidade e segurança; Postgres Changes é mais simples, mas tem limitações maiores de escala. [Database changes](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes).

O canal pode ser `user:<auth.uid()>`, com autorização que exija a correspondência exata. Não basta “qualquer usuário autenticado pode entrar”. [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization).

Na reconexão:

1. Reabrir a assinatura.
2. Buscar estado atual e eventos posteriores ao último `seq`.
3. Deduplicar eventos.
4. Tratar notificações como sinais, não como a única cópia do estado.

Não criaria SSE próprio na V0. Streaming entre OpenAI e worker pode existir independentemente do transporte entre seu app e o navegador.

### Watch Bot Work: implementação escolhida

O E2B Desktop atual usa **x11vnc + noVNC/websockify**, com uma página HTTPS e conexão WebSocket. Não é, por padrão, um stream WebRTC de vídeo. O SDK oferece autenticação do stream e `viewOnly`; no código inspecionado, `viewOnly` configura a página cliente. [SDK Desktop](https://github.com/e2b-dev/E2B/blob/main/packages/desktop-js/src/sandbox.ts).

**Para esta V0 pública, eu escolheria screenshots aproximadamente uma vez por segundo:**

1. Usuário abre Watch.
2. API verifica dono do bot e run em execução.
3. Registra uma autorização de visualização por 60 segundos, renovada enquanto a janela estiver visível.
4. Worker captura o desktop, comprime uma cópia para JPEG e salva em Storage privado.
5. Reutiliza dois objetos temporários alternados, sem guardar uma gravação.
6. Publica `desktop.frame_available` com sequência e timestamp.
7. Cliente baixa o frame autenticado e substitui a imagem.
8. Ao fechar ou expirar a autorização, parar capturas extras e limpar os frames.

A screenshot enviada ao modelo segue as necessidades da API; a versão comprimida de visualização é um caminho separado.

**Trade-off assumido:** o usuário verá o desktop verdadeiro quase em tempo real, mas sem fluidez de vídeo. Uma meta inicial de atualização percebida em 1–3 segundos precisa ser medida.

Vantagens:

- Nenhum iframe de computador exposto.
- Nenhuma credencial E2B no cliente.
- Nenhum canal de teclado ou mouse.
- Nenhum custo de gravação.
- Funciona sem construir um gateway WebSocket.

Se o vídeo fluido se provar decisivo para conversão, a evolução é noVNC com **restrição de leitura imposta no servidor**, autenticação curta e gateway apropriado. Apenas adicionar `viewOnly: true` não resolve isso.

---

## 9. Segurança

### Controles obrigatórios para V0

| Risco | Controle mínimo |
|---|---|
| Acesso entre usuários | Ownership em todas as rotas, FKs compostas, RLS e canais privados |
| Controle do sandbox por ID vazado | SDK/template atuais com secured access; IDs não usados como autorização |
| Serviços públicos no PC | `allowPublicTraffic: false`; não expor VNC, terminal ou CDP diretamente |
| Credenciais da plataforma | Apenas no servidor/worker; nunca no guest |
| Prompt injection | Conteúdo de sites, arquivos e screenshots tratado como entrada não confiável |
| Comandos arbitrários | Validar ferramentas, argumentos, caminhos, duração e tamanho de saída; ambiente sem sudo |
| SSRF | Validar URLs e redirects do backend; não encaminhar headers ou credenciais internos |
| Exfiltração | Sem contas privadas na V0; rede limitada e nenhum segredo de plataforma no computador |
| Abuso financeiro | Reserva atômica, limites por run/usuário/projeto e interruptor global |
| Loops | Limite de tempo, chamadas, ações e repetições sem progresso |
| Malware e uploads | Uploads fora da V0; downloads restritos e sem execução automática |
| XSS em resultados | Markdown sanitizado; arquivos HTML/SVG não executados no domínio principal |
| Vazamento por logs | Redação de tokens, cookies, URLs sensíveis, texto digitado e conteúdo de documentos |

O E2B documenta secured access por padrão em SDKs 2.x e autenticação do controller. Isso é distinto da proteção dos serviços publicados pelo sandbox. Configure também a restrição de tráfego público. [Secured access](https://docs.e2b.dev/sandbox/secured-access), [public access](https://docs.e2b.dev/network/restrict-public-access).

### O que E2B resolve e o que continua sendo seu

E2B fornece isolamento do ambiente e mecanismos externos de controle de rede. A documentação também informa bloqueio obrigatório de saída para ranges privados e link-local. Isso ajuda a proteger infraestrutura, mas **não verifica se o usuário pode operar o bot nem se a tarefa é legítima**. [Restrições de acesso](https://docs.e2b.dev/network/restrict-public-access).

Você continua responsável por:

- Fraude, spam e automação abusiva.
- Quantidade de requisições produzidas.
- Dados enviados aos modelos.
- Credenciais de terceiros.
- Autorização das ações.
- Custos e limites.
- Atualização do template e dependências.

Também não existe uma garantia absoluta de “isolamento completo” dada apenas pelo diagrama. É preciso testar isolamento entre tenants, reduzir privilégios e manter o runtime atualizado.

### A rede da V0 pública

Eu começaria com **destinos suportados e aprovados pelo produto**, não internet irrestrita para qualquer script.

O E2B suporta allowlists de domínios, mas a própria documentação alerta que elas são controle de roteamento e não uma fronteira estrita em infraestrutura compartilhada. Filtragem por domínio também tem limitações de protocolo. Para uma fronteira forte com código hostil, use destinos dedicados ou um proxy que imponha a política. [Internet access](https://docs.e2b.dev/network/internet-access).

Portanto:

- Não permita ao modelo expandir sua própria allowlist.
- Não use curingas amplos em serviços de upload ou infraestrutura compartilhada.
- Limite requisições nas ferramentas que você controla.
- Restrinja workloads públicos e monitore os primeiros usuários.
- Não anuncie que isso “impede todo abuso”.

**Não lançaria shell arbitrário com internet irrestrita em 24 horas.** Isso é uma restrição explícita da V0, preservando computadores próprios e tarefas úteis.

### Crypto mining, proxy, spam e exploração de sites

A combinação mínima é:

- Usuário autenticado.
- Poucos runs gratuitos.
- Um run executando por usuário.
- Limite global de concorrência.
- Nenhuma porta pública de proxy.
- Egress limitado.
- Sem GPU.
- Limites de CPU, memória, processos, tempo e arquivos.
- Sem criação automática de contas, disparos de mensagens, exploração ou resolução de bloqueios antibot.
- Suspensão de conta e pausa/destruição do ambiente em caso de abuso.

Um atacante ainda pode desperdiçar parte da cota. O objetivo realista da V0 é **reduzir capacidade de abuso e limitar seu prejuízo**, não provar impossibilidade de uso indevido.

### Credenciais futuras

A arquitetura proposta não cria um beco sem saída.

```text
User OAuth consent
        |
        v
Encrypted token store
        |
        v
Trusted integration tools
        |
        v
Gmail / Drive / GitHub / Notion APIs
```

O agente solicita operações como `search_email` ou `read_document`; um serviço confiável aplica escopos, ownership, limites e auditoria.

- Refresh tokens ficam criptografados fora do sandbox.
- Access tokens são usados no servidor ou por ferramentas com escopo curto.
- O modelo não recebe tokens.
- Publicar, enviar ou apagar exige autorização correspondente.
- Revogação remove o acesso e invalida material persistido relacionado.

A regra “nenhuma credencial pode existir no filesystem” é absoluta demais: um browser autenticado normalmente armazena cookies ou outros dados de sessão. Por isso, quando essa função chegar, **o perfil e o estado de memória do browser passam a ser material sensível**, com retenção, revogação e backup compatíveis.

Eu adiaria login em sites e integrações privadas.

---

## 10. Custos

### Premissas

Os números abaixo são **cenários mensais por usuário ativo**, não por cadastro.

Assumo:

- Sol, processamento Standard.
- Tokens de entrada **acumulados em todas as chamadas do run**, incluindo screenshots e contexto.
- Tokens de saída incluindo raciocínio cobrado.
- Sem desconto por cache.
- Cada requisição abaixo do limite de contexto que dispara tarifa maior.
- Sandbox de 2 vCPU e 4 GiB.
- Um minuto adicional por run para preparação, exportação, idle e pausa.
- Worker Small 1x no Trigger.dev.
- Watch aberto durante 30% do trabalho, 1 fps e JPEG médio de 120 KB.
- Um único espectador por computador.
- Sem vídeos armazenados, proxies pagos ou ferramentas hospedadas adicionais.

### Preços usados

| Componente | Preço considerado |
|---|---|
| OpenAI Sol | US$4/M entrada; US$20/M saída |
| E2B compute | US$0,000014/vCPU/s + US$0,0000045/GiB/s |
| E2B Pro | US$150/mês + uso |
| Trigger Small 1x | US$0,0000338/s + US$0,000025 por run |
| Trigger Pro | US$50/mês com US$50 de créditos |
| Supabase Pro | US$25/mês, incluindo um Micro |
| Supabase Storage excedente | US$0,0213/GB/mês |
| Supabase egress não cacheado excedente | US$0,09/GB |
| Supabase Realtime excedente | US$2,50/M mensagens após 5 milhões |
| Vercel Pro | US$20/mês para a configuração inicial |

Fontes: [OpenAI](https://developers.openai.com/api/docs/pricing), [E2B](https://e2b.dev/pricing), [Trigger.dev](https://trigger.dev/pricing), [Supabase](https://supabase.com/pricing), [Vercel](https://vercel.com/pricing).

O Sol tem preço promocional indicado como disponível pelo menos até 21 de novembro de 2026. Cache writes e requisições de contexto muito longo têm tarifas diferentes; a tabela não pressupõe esses modos. [Detalhes do modelo](https://developers.openai.com/api/docs/models/gpt-5.6-sol).

### Cenários de uso

| Premissa por usuário/mês | Light | Normal | Heavy |
|---|---:|---:|---:|
| Runs | 5 | 20 | 60 |
| Trabalho médio por run | 2 min | 8 min | 20 min |
| Entrada acumulada por run | 10 mil tokens | 60 mil | 200 mil |
| Saída acumulada por run | 2 mil tokens | 10 mil | 30 mil |
| Arquivos retidos por usuário | 50 MB | 250 MB | 1 GB |
| Download/export por run | 10 MB | 25 MB | 50 MB |
| OpenAI por run | US$0,08 | US$0,44 | US$1,40 |

Fórmulas principais:

```text
model/run =
  input_tokens × 4 / 1,000,000
  + output_tokens × 20 / 1,000,000

E2B/run =
  (work_minutes + 1) × 60 × 0.000046

worker/run =
  (work_minutes + 1) × 60 × 0.0000338
  + 0.000025
```

O custo variável básico por run, antes de planos, Storage e tráfego, fica em aproximadamente **US$0,094 / US$0,483 / US$1,501**.

### Projeção mensal

Esta tabela usa uma base conservadora de produção com E2B Pro e Trigger Pro. Valores arredondados:

| Cenário | Usuários ativos | OpenAI | E2B: compute + plano | Trigger | DB, hosting, Storage e tráfego estimados | Total estimado |
|---|---:|---:|---:|---:|---:|---:|
| Light | 100 | US$40 | US$154 | US$50 | US$45 | **US$289** |
| Light | 1.000 | US$400 | US$191 | US$50 | US$45 | **US$686** |
| Light | 10.000 | US$4.000 | US$564 | US$305 | US$147 | **US$5.016** |
| Normal | 100 | US$880 | US$200 | US$50 | US$45 | **US$1.175** |
| Normal | 1.000 | US$8.800 | US$647 | US$366 | US$112 | **US$9.924** |
| Normal | 10.000 | US$88.000 | US$5.118 | US$3.655 | US$1.096 | **US$97.870** |
| Heavy | 100 | US$8.400 | US$498 | US$256 | US$77 | **US$9.231** |
| Heavy | 1.000 | US$84.000 | US$3.628 | US$2.557 | US$700 | **US$90.885** |
| Heavy | 10.000 | US$840.000 | US$35.426 | US$25.648 | US$6.984 | **US$908.057** |

Detalhes de dimensionamento:

- Para 10 mil usuários, considerei Supabase Medium: US$75/mês incluindo plano e crédito de compute. Isso é uma reserva de dimensionamento, não garantia de capacidade.
- No Heavy/10 mil, considerei E2B com capacidade de 600 sandboxes e Trigger com 600 execuções. O estimador E2B publica o adicional correspondente; Trigger cobra expansão de concorrência. [Estimador E2B](https://pricing.e2b.dev/), [Trigger pricing](https://trigger.dev/pricing).
- Realtime contabiliza uma hipótese de envio e entrega de eventos de atividade e frames. Os frames em si seguem por Storage.
- Vercel permanece na franquia assumida porque não transporta imagens do desktop nem executa o loop.
- Não incluí impostos, suporte humano, observabilidade paga ou eventuais cobranças de rede não estabelecidas nas fontes consultadas. Não encontrei tarifa pública separada suficiente para precificar todo eventual egress E2B/worker; isso permanece uma lacuna, não “rede garantidamente gratuita”.
- O Heavy é um cenário de estresse. **Não é o consumo que a V0 gratuita deveria permitir.**

### Usuários não equivalem a concorrência

Com 10 mil usuários:

- Light: aproximadamente **3,5** sandboxes ativos em média.
- Normal: aproximadamente **41,7**.
- Heavy: aproximadamente **291,7**.

Os picos podem ser muito maiores. Uma publicação viral pode gerar fila mesmo com consumo mensal pequeno. Sua aplicação precisa impor fila e informar isso.

### Custo mínimo para amanhã

Uma configuração inicial pode começar em aproximadamente:

```text
Vercel Pro       $20
Supabase Pro     $25
Trigger Hobby    $10
E2B Hobby         $0 de mensalidade
--------------------
Base             $55/mês + consumo
```

Isso exige respeitar as capacidades do Hobby e verificar a configuração real do template Desktop. Créditos promocionais não entram como economia recorrente.

**Minha conclusão econômica:** controlar o número de turnos do modelo e o contexto acumulado provavelmente produz mais economia que trocar o fornecedor do computador.

---

## 11. Implementação

### Etapa A: demo técnica mínima

**Tarefas**

- Um bot.
- Um template desktop.
- Responses API controlando o computador.
- Screenshot visível.
- Criar `research.md`.
- Pausar e retomar preservando o arquivo.

**Dependências**

- Chaves OpenAI e E2B.
- Modelo habilitado na conta.
- Template compatível com SDK atual e secured access.

**Critério de pronto**

Uma tarefa real termina, produz arquivo e pode ser continuada após pause/resume. Não vale animação simulada nem resposta sem evidência do trabalho.

### Etapa B: MVP público com capacidade limitada

**Tarefas**

- Login.
- Três bots predefinidos.
- Histórico e runs persistidos.
- Trigger.dev.
- Autorização e RLS.
- Um controlador por computador.
- Watch autenticado.
- Cancelamento.
- Limites de gasto e duração.
- Rede e ferramentas restritas.
- Exportação de entregáveis.
- Reconciliador de runs pendentes e máquinas órfãs.

**Dependências**

Etapa A funcionando, Google OAuth configurado e políticas de acesso testadas.

**Critério de pronto**

Dois usuários não conseguem acessar nada um do outro; fechar a página não interrompe o trabalho; cancelar e atingir limites interrompem execução; o resultado reaparece ao reconectar.

### Etapa C: hardening

**Tarefas**

- Testes de falha induzida.
- Recuperação de browser e sandbox.
- Checkpoints melhores.
- Comparação de modelos e redução de contexto.
- Políticas de arquivos e retenção.
- Métricas de custo por tarefa concluída.
- Ampliação cuidadosa de sites e operações suportados.
- Decidir se vídeo fluido aumenta ativação.

**Critério de pronto**

Falhas comuns têm detecção e comportamento definido; custos observados sustentam as cotas e eventual preço do produto.

### Estrutura de código

```text
src/
  app/
    (auth)/
    messenger/
    api/
      bots/
      runs/

  components/
    messenger/
      contact-list.tsx
      chat-window.tsx
      presence-badge.tsx
      desktop-viewer.tsx

  server/
    auth/
      require-user.ts
      ownership.ts
    bots/
      presets.ts
      presence.ts
    runs/
      create-run.ts
      transitions.ts
      budgets.ts
      checkpoints.ts
    agent/
      loop.ts
      computer-actions.ts
      workspace-tools.ts
      policy.ts
    computer/
      e2b.ts
      lifecycle.ts
      frames.ts
      artifacts.ts
    events/
      publish.ts
      contracts.ts
    db/
      queries.ts

  trigger/
    execute-run.ts
    reconcile-runs.ts
    cleanup-computers.ts

supabase/
  migrations/

sandbox/
  template/

tests/
  authorization/
  lifecycle/
  recovery/
```

Um repositório, com deploy do app e deploy do worker. Isso é uma separação operacional necessária, não uma arquitetura de microservices.

### Observabilidade desde o primeiro dia

Registrar:

```text
user_id, bot_id, run_id
provider sandbox id (server-only)
job_id, execution_version
model, template_version, instructions_version
input/cached/output tokens
tool name, action count, duration
sandbox active seconds
estimated cost
status transition, error_code
artifact metadata
```

Identificadores pessoais ficam restritos ao ambiente operacional, não em analytics públicos.

Métricas:

- Envio → primeira ação.
- Percentual de tarefas concluídas.
- Custo por tarefa concluída.
- Pause/resume bem-sucedido.
- Runs presos.
- Cancelamentos.
- Abertura do Watch.
- Retorno do usuário para continuar um trabalho anterior.

Não mostraria “raciocínio interno” na interface. Mostraria ações confirmadas e mensagens de progresso destinadas ao usuário. Também não copiaria os logs de previews de texto do Surf para produção.

### Failure modes

| Falha | Impacto | Detecção | Fallback |
|---|---|---|---|
| Sandbox não sobe | Run não começa | Timeout de provisionamento | Retry limitado; depois erro explícito |
| Create ocorreu, resposta se perdeu | Risco de sandbox duplicado | Metadata e reconciliação | Procurar recurso antes de criar outro |
| Sandbox morreu | Perda do estado não exportado | Erro do SDK + consulta ao provedor | Recriar com template e entregáveis salvos |
| Browser travou | Sem progresso | Falhas repetidas e health check | Reiniciar browser uma vez |
| Modelo entrou em loop | Gasto sem resultado | Limite de passos e repetição de observações | Parar com resultado parcial |
| OpenAI retornou 429/5xx | Interrupção temporária | Código de erro | Backoff limitado, sem repetir ações já executadas |
| Worker morreu | Run preso | Heartbeat vencido | Pausar computador e avaliar checkpoint |
| Página foi fechada | Usuário deixa de acompanhar | Desconexão do cliente | Trabalho continua |
| Realtime caiu | UI desatualizada | Erro de assinatura | Reassinar e buscar estado persistido |
| Vercel morreu antes do dispatch | Run fica na fila | Reconciliador encontra `QUEUED` antigo | Dispatch idempotente |
| Cancelamento chegou durante ação | Ação pode já ter ocorrido | Flag entre etapas | Interromper próximas ações e reportar estado real |
| Storage falhou | Entregável sem cópia externa | Erro de exportação | Manter arquivo no sandbox e indicar falha parcial |
| Site exige CAPTCHA/login | Tarefa bloqueada | Página/estado identificado | Informar limitação; não contornar |
| Orçamento acabou | Tarefa incompleta | Reserva e contador | Parar e devolver o que foi feito |
| Cleanup atrasado | Pode pausar tarefa nova | Versão/lock de execução | Revalidar antes de pausar |
| Ação externa teve resultado incerto | Retry pode duplicar efeito | Timeout após envio | Não repetir automaticamente |

**Idempotência do job não produz “exactly once” para cliques em sites.** Depois de uma falha entre clicar e registrar o resultado, pode ser impossível saber automaticamente o que aconteceu.

### Do not build this for the MVP

- Multi-agent orchestration.
- Marketplace.
- Bots conversando entre si.
- Group chat.
- Organizações e permissões corporativas.
- Criação livre de bots.
- Vários modelos e roteamento dinâmico.
- Vector database.
- Memória semântica.
- Agendamentos de tarefas do usuário.
- MCP marketplace.
- Terminal interativo para o usuário.
- Instalação livre de software.
- Uploads arbitrários.
- Login em contas pessoais.
- Envios, compras e publicações autônomas.
- Gravação e replay de todos os desktops.
- Streaming WebRTC próprio.
- Kubernetes, Redis, Temporal ou Firecracker autogerenciado.
- Compatibilidade com todos os sites.
- Runs gratuitos de uma hora.
- Clonagem pixel-perfect de cada detalhe do Messenger.

O diferencial visual precisa aparecer cedo. A infraestrutura precisa fazer apenas o suficiente para sustentar uma demonstração verdadeira.

---

## 12. Plano das primeiras 24 horas

### Horas 0–2: provar o caminho crítico

- Criar um projeto pequeno.
- Instalar SDKs atuais e fixar versões no lockfile.
- Subir um E2B Desktop.
- Fazer uma tarefa curta por Responses API.
- Capturar screenshot.
- Criar um arquivo.
- Pausar e retomar.

**Saída:** demonstração técnica executável. Se esse caminho não funcionar, adiar a UI detalhada.

### Horas 2–5: criar o estado do produto

- Supabase Auth.
- Schema inicial.
- Três presets: **Chat Bot, Research Bot e Computer Bot**.
- Uma conversa por bot.
- Endpoint de mensagem com idempotência.
- Checks de ownership.

Eu renomearia “Grok Bot” enquanto o motor for OpenAI. Um prompt com outra personalidade não transforma o modelo em Grok.

### Horas 5–9: executar fora da requisição

- Mover loop para Trigger.dev.
- Persistir run e eventos principais.
- Implementar orçamento e cancelamento.
- Configurar `onTimeout: pause`.
- Salvar os arquivos entregáveis.
- Implementar reconciliador mínimo.

**Limites iniciais propostos:**

```text
1 run executing per user
1 open run per bot
10 runs executing globally
10 minutes maximum execution
40 model turns maximum
150 computer actions maximum
$1 estimated maximum per run
3 free runs per user per day
```

O orçamento não é apenas um contador consultado depois da chamada: reservar margem para a próxima chamada e limitar seus tokens de saída. Ainda pode existir diferença entre estimativa e cobrança; reconciliar posteriormente.

### Horas 9–13: construir a experiência Messenger

- Contact list.
- Avatar e nome.
- Conversa.
- Presença derivada.
- Botão Stop.
- Botão Watch.
- Mensagem final com download.

Começar com uma janela de conversa ativa. Arrastar, minimizar e abrir dez janelas simultâneas pode esperar.

### Horas 13–16: Watch e reconexão

- Captura de frames com autorização temporária.
- Storage privado.
- Canal Realtime privado.
- Timestamp da última imagem.
- Recuperação de estado após reload.
- Interromper capturas quando ninguém assiste.

### Horas 16–20: testar os riscos que bloqueiam lançamento

Executar testes reais com:

1. Usuário A tentando ler bot, run, eventos e arquivos de B.
2. Mensagem enviada duas vezes.
3. Duas tarefas simultâneas para o mesmo bot.
4. Página fechada durante execução.
5. Cancelamento.
6. Limite de gasto.
7. Worker interrompido.
8. Pause/resume.
9. Tentativa de abrir serviço público do sandbox.
10. Falha no download de um resultado.

Esses testes são mais importantes que aumentar cobertura de componentes visuais.

### Horas 20–24: publicar a V0 limitada

- Configurar produção e segredos.
- Publicar app e worker.
- Aplicar migrations.
- Conferir policies e buckets.
- Configurar orçamento global e bloqueio de novas execuções.
- Rodar o smoke test no domínio publicado.
- Liberar uma coorte pequena, com capacidade global controlada.

**O que deve funcionar no fim:**

> O usuário entra, vê três bots, conversa com um deles, envia uma tarefa suportada, vê Busy, acompanha imagens reais do desktop, recebe um arquivo e consegue continuar esse trabalho depois de o computador dormir.

“Comparar três páginas suportadas e gerar um relatório” é um bom caso inicial. “Reservar hotéis em qualquer site com minhas contas” não é.

O prazo de 24 horas é plausível para essa versão reduzida se contas e acessos estiverem disponíveis. Não é garantia de que segurança, integração e compatibilidade ficarão resolvidas sem imprevistos.

---

## 13. Código/repositórios a reutilizar

| Projeto | Licença verificada | O que reutilizar | Recomendação |
|---|---|---|---|
| [E2B Surf](https://github.com/e2b-dev/surf) | Apache-2.0 | Mapeamento de ações, screenshots e exemplo do loop | Referência; copiar seletivamente |
| [E2B Desktop](https://github.com/e2b-dev/desktop) | Apache-2.0 | Template desktop e exemplos | Dependência + template adaptado |
| [E2B monorepo](https://github.com/e2b-dev/E2B) | Apache-2.0 | SDKs atuais, inclusive Desktop | Dependência |
| [OpenAI Node SDK](https://github.com/openai/openai-node) | Apache-2.0 | Responses API e tipos atuais | Dependência |
| [OpenAI CUA sample](https://github.com/openai/openai-cua-sample-app) | MIT | Exemplos de computer use | Referência |
| [OpenAI Agents SDK JS](https://github.com/openai/openai-agents-js) | MIT | Padrões de loop e estado para evolução | Referência nesta V0 |
| [Playwright](https://github.com/microsoft/playwright) | Apache-2.0 | Verificações determinísticas e futura automação do browser | Dependência quando houver caso concreto |
| [Trigger.dev](https://github.com/triggerdotdev/trigger.dev) | Apache-2.0 | SDK e tarefas | Serviço gerenciado + dependência |
| [Browser Use](https://github.com/browser-use/browser-use) | MIT | Padrões de agentes web | Referência, sem adicionar outro runtime |

Preservar avisos de licença nos trechos reutilizados. A licença de um repositório não substitui termos do serviço hospedado nem cobre automaticamente todos os assets e componentes distribuídos.

### Avaliação concreta do Surf

**Reaproveitaria:**

- Tradução de ações do modelo para Desktop SDK.
- Captura de screenshots após ações.
- Tratamento da sequência `computer_call` → observação.
- Ideias visuais de mostrar atividade.

**Substituiria:**

- Route HTTP que executa todo o loop.
- Recebimento de `sandboxId` do cliente.
- Lifecycle conduzido pela página.
- Histórico mantido como estado principal do frontend.
- Streaming que mistura execução e conexão do usuário.
- Prompt que minimiza riscos por estar em sandbox.
- Logs que incluem previews de instruções e texto digitado.

A rota e as server actions inspecionadas não fazem checagem de dono antes de conectar, estender ou encerrar o sandbox indicado. O stream é iniciado sem autenticação explícita. Isso exige reescrita antes de uso multiusuário. [Rota](https://github.com/e2b-dev/surf/blob/d2a98aa9d0cd67db5146bec843a296f132d443f5/app/api/chat/route.ts), [ações](https://github.com/e2b-dev/surf/blob/d2a98aa9d0cd67db5146bec843a296f132d443f5/app/actions.ts).

Também não é correto dizer que o Surf atual só usa `computer-use-preview`: o commit inspecionado configura **`gpt-5.4`** e usa `computer`, com suporte a batches. Porém, conserva dependências de gerações antigas, incluindo `openai` 4.87.2 e E2B 1.x. Não carregaria esse manifesto inteiro para um projeto novo. [Configuração](https://github.com/e2b-dev/surf/blob/d2a98aa9d0cd67db5146bec843a296f132d443f5/lib/config.ts), [dependências](https://github.com/e2b-dev/surf/blob/d2a98aa9d0cd67db5146bec843a296f132d443f5/package.json).

**Veredito sobre maturidade:** exemplo útil de integração. A inspeção não demonstrou uma base pronta para multi-tenancy, execução durável e controle financeiro.

**Eu criaria um projeto novo e portaria os trechos úteis.**

---

## 14. Pontos onde sua arquitetura original estava errada

1. **A sequência “backend → OpenAI → E2B” atribui coordenação ao lugar errado.** Seu worker conversa com ambos e executa as decisões permitidas.

2. **Falta um executor que sobreviva à requisição.** SSE, Vercel e um sandbox aberto não resolvem isso automaticamente.

3. **`bot_id` e `sandbox_id` não devem ter o mesmo ciclo de vida.** O bot precisa sobreviver à substituição de uma máquina.

4. **Um campo `status` é insuficiente.** Run, computador, presença e disponibilidade administrativa divergem em situações normais.

5. **Pause/resume não equivale a confiabilidade completa.** Preserva estado local; não garante sessões remotas, conexões ou recuperação após toda falha.

6. **O timeout padrão é perigoso para sua promessa.** Sem configuração explícita de pause, você pode destruir o estado que prometeu preservar.

7. **Surf não entrega a infraestrutura pública pronta.** Ele demonstra a integração principal; autorização, lifecycle robusto e execução independente continuam faltando.

8. **“View only” na URL não é controle de acesso.** Um cliente pode modificar parâmetros.

9. **Isolamento do sandbox não torna ações externas seguras.** Spam, exfiltração e fraude acontecem mesmo dentro de uma microVM bem isolada.

10. **Browser autenticado muda completamente a sensibilidade do computador.** Cookies e memória podem permitir acesso às contas.

11. **Número de usuários é uma métrica insuficiente para dimensionar custo.** Precisamos de runs, tokens acumulados, tempo ligado, viewers e picos.

12. **Não manter VM permanentemente ligada está correto.** Também está tecnicamente correto reaproveitar um E2B pausado por bot; o erro seria tratá-lo como identidade imutável e única cópia dos dados.

13. **“Sem filas sofisticadas” é um bom corte; “sem dispatch confiável” não é.** Um run persistido, Trigger.dev e um reconciliador pequeno resolvem o necessário.

14. **Trocar a UI do Surf não elimina as decisões de backend.** A maior parte das mudanças críticas está fora dos componentes visuais.

15. **“Grok Bot” com OpenAI é uma representação enganosa do motor.** Use um nome próprio de personagem ou integre o provedor correspondente depois.

---

## 15. Recomendação final

**Para esta V0, eu construiria exatamente assim:**

**Next.js na Vercel, Supabase Auth/Postgres/Storage/Realtime, Trigger.dev Cloud, Responses API com GPT-5.6 Sol e E2B Desktop.**

Três bots predefinidos, cada um com conversa, instruções e workspace exclusivos. Um sandbox criado sob demanda e retomado entre tarefas. Entregáveis copiados para Storage. Um único run controlando cada computador. Presença derivada do estado real.

Watch Bot Work por screenshots autenticadas de aproximadamente 1 fps. Cancelamento, cotas, teto de gasto e reconciliação desde o primeiro lançamento.

**Lançaria tarefas curtas em sites suportados, sem contas pessoais e sem shell irrestrito.** A primeira validação é descobrir se as pessoas querem voltar a conversar com “aquele bot e seu computador”, depois que a surpresa da interface Messenger passa.
