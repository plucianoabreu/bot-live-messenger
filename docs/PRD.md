# Bot Messenger — Web implementation PRD

Version: 1.7 · Date: 2026-09-06 · Status: revised product requirements; implementation pending

The September 6 user feedback supersedes the previous three-preset, per-bot-computer, serial-execution scope. The initial release must include at least ten specialized presets, custom Bot creation, persistent conversations/preferences/role context, one shared computer per user, parallel Bot work, direct Bot messages, and group conversations. This revision changes requirements, not the current implementation. The exact Grok default roster remains unverified; the sourced selection below is a proposal, not a claim of exact parity.

## 1. Decision and evidence

Build a limited web V0 in a new `bot-messenger-web` project, preserving the existing `agent-messenger` prototype as the visual reference. Keep the Messenger 2009 feeling while replacing simulated accounts, replies, activity and files with durable, authorized execution.

The product is **Bot Messenger**. User-facing copy is automatically localized to the browser language. Portuguese (Brazil) is the source copy, not the only supported interface language. Use **bot/bots** for the generic entity; every preset contact name uses **AI + famous name + function**. The historical inspiration is a visual language, not Microsoft affiliation. Use original interface assets, except for the user-selected default display pictures specified below; preserve font and dependency licenses.

Primary inputs:

- Current user decisions: fullscreen Messenger-style entry screen; signed-in desktop wallpaper; movable contact and conversation windows; labeled advertising space; no Windows taskbar; nostalgic interfaces; Bot Messenger branding; bot terminology; AI-prefixed contact names.
- Existing prototype: `../../agent-messenger/index.html`, `app.js`, `auth.js`, `styles.css`, `README.md` and original assets.
- Technical review: [architecture-reference.md](architecture-reference.md), retrieved from **Revisar arquitetura de AI Bots**, thread `01a07506-c638-7cd3-a7d5-3f28526b0ad9`. Its vendor research is a September 6, 2026 snapshot, not proof of integrations working in this project.

Evidence supports the user's preferred experience and an architecture proposal. It does not establish market demand, measured retention, model availability in the deployment account, or production reliability. Targets below are hypotheses and launch criteria, not measured results.

Classification: **learning experiment**. Authentication, tenant isolation, execution durability, truthful status, cancellation and cost controls are launch blockers within that experiment. Fidelity to the approved interface is P0. Technical scope cuts do not authorize visual redesign or removal of approved local interactions.

## 2. Problem, users and promise

Early adopters who already use AI for research, planning and technical work repeatedly reconstruct context and lose track of ongoing tasks and outputs. Bot Messenger organizes that work around recognizable contacts and persistent conversations, making it easy to see which bot is working, inspect its progress and return to its files.

Primary persona: an individual product builder or knowledge worker completing short, bounded tasks. V0 is an invite-limited single-user workspace, not a shared team product.

Product promise: **Each user has a team of specialized bots with persistent conversations, preferences and role context. Bots can collaborate in parallel through direct messages and groups, sharing one user-owned computer and durable files. The computer starts when needed and can sleep when all work is idle.** Do not promise uninterrupted processes, permanent website sessions, or complete recovery of the guest computer after loss.

Core demonstration: sign in → open Chief of Staff → create a research group with Competitive Intelligence Analyst and Presentation Designer → delegate a sourced comparison and presentation → observe overlapping work on one shared computer → receive deliverables → return after sleep with preferences and group context preserved. Display names remain subject to the catalog mapping.

## 3. Goals and measurement

Evaluate after the first 20 activated users or 14 days of a limited pilot, whichever is later. Report sample size and raw numerator/denominator; do not treat a small sample as causal evidence.

| Outcome | Initial hypothesis | Measurement |
|---|---|---|
| First value | At least 60% of invited sign-ins finish a supported task within their first day | Users with a successful run and opened answer/artifact / first sign-ins |
| Reliability | At least 90% completion on the fixed supported-task benchmark | Successful runs / eligible benchmark runs; include provider failures |
| Continued use | At least 30% of activated users return to a previous bot within 7 days | Returning users / activated users with a full 7-day observation window |
| Observability | Reconnection restores authoritative state without manual recovery | Acceptance suite plus stale-state incident count |
| Sustainable execution | At least 95% of successful benchmark tasks fit the configured pilot reservation ($0.02 chat / $0.25 computer) | Reservation ledger and reconciled provider usage; show estimation error |

Guardrails: zero verified cross-tenant disclosure; zero new tool actions admitted after a worker observes cancellation; zero unbounded runs; all ambiguous external side effects stop for reconciliation. Any such security failure pauses pilot admissions.

Persist sanitized events: `signup_completed`, `conversation_opened`, `run_queued`, `run_started`, `run_completed`, `run_failed`, `run_cancelled`, `run_budget_exceeded`, `watch_opened`, `artifact_downloaded`. Include IDs, timestamps, preset, duration, usage and reason codes, not message bodies, screenshots, tokens or sensitive URLs.

## 4. V0 scope and prototype disposition

### Presets

On first authenticated entry, provision at least ten specialized contacts idempotently per user. The user requests equivalents of Grok Bot defaults, not merely generic personas with different names. Match documented responsibilities and validate actual capabilities with representative tasks; do not claim access to Grok's internal prompts or identical results.

Public evidence does not establish one universal ten-Bot default roster: Grok onboarding suggests teammates based on selected tools. The following proposed starting selection uses eight roles highlighted in the official documentation plus two roles from its official gallery. Confirm the user's intended default roster before claiming exact catalog parity. Keep the approved AI-prefixed naming convention until the exact display-name mapping is resolved.

| Official reference role | Proposed responsibility in Bot Messenger |
|---|---|
| Chief of Staff | Prioritize work and coordinate specialist handoffs |
| Sales Outbound | Research prospects and prepare outreach drafts |
| Talent Scout | Research candidates against a role brief |
| Paid Media | Analyze campaign inputs and recommend changes |
| Expense Manager | Reconcile supplied expense data and flag gaps |
| Product Performance | Investigate performance evidence and summarize findings |
| Bug Reproduction | Reproduce issues in authorized test environments |
| Account Health | Assess supplied customer signals and suggest follow-up |
| Competitive Intelligence Analyst | Compare competitors and material changes |
| Presentation Designer | Produce editable presentations from a brief |

Sources checked September 6, 2026: [onboarding](https://docs.x.ai/grok-bot/get-started), [documented roles](https://docs.x.ai/grok-bot/use-cases), [official gallery](https://x.ai/bot/use-cases). The gallery is evidence of public roles, not installed defaults. Tool integrations, private accounts and scheduled monitoring remain separate dependencies: a preset must disclose unavailable capabilities instead of simulating them. Full workflow parity for roles requiring those dependencies is unresolved, not delivered by adding profiles.

A preset is a capability and instruction bundle, not a claim about the model vendor. Models and reasoning settings remain server configuration and require verified access and tool support.

### Custom bots, memory and collaboration

- Users can create real bots with a name, role, instructions and avatar, then edit them. Provisioning is durable and subject to configured resource limits; it is not restricted to the demonstration.
- Persist conversations, explicit user preferences, role descriptions and learned working context across sessions. Separate user-wide preferences from bot-specific context; allow the user to inspect, correct and delete saved memory. Record provenance and update time, retrieve relevant context, and invalidate superseded facts. Memory never overrides policy or substitutes for fresh evidence.
- Users can create named groups, add/remove their own bots, mention participants and follow attributed messages and deliverables. Groups contain one human owner's bots in this release; this does not introduce multi-user teams.
- Bots can send durable direct messages, delegate bounded tasks and reply to groups. Show sender, recipient, task ownership, handoff status and source context. Other bots do not automatically receive an entire private conversation.
- Run independent bots in parallel. Enforce shared root-task budgets, bounded handoff depth, deduplication and cancellation propagation so bot-to-bot messages cannot create unlimited work. Waiting parents must release execution slots so child work can run.
- One resumable computer belongs to each user. Bots share files and browser sessions; per-bot folders are organizational, not security boundaries. Protect users from other users at every access path.
- Coordinate shared resources: reasoning and independent file/tool work may overlap; serialize actions on the same desktop, browser context or file. If separate displays are supported and verified, distinct displays may execute concurrently within the same computer. Do not solve contention by provisioning a computer per bot.

### Design authority

The approved `agent-messenger` HTML, CSS, assets and interactions are the starting reference. The 2009-only research in [MESSENGER-2009.md](MESSENGER-2009.md) now governs the visual source of truth. Preserve its login/signup form, compact single-column contact list, independent conversation windows, portrait rail, composer, menus and dialogs. Do not substitute a split-pane layout or a Google-only entry screen. The local demonstration retains all 13 approved contacts; the first live cohort must have at least ten specialized presets plus custom bots.

### Automatic language selection and translation

Added September 6, 2026 at the user's request. The application must automatically select the browser's preferred language and present a translated interface without requiring setup or the browser's own translation extension.

- Language precedence: explicit saved user choice, then browser preference order, then the documented fallback. Include **Automatic (browser)** in the language selector so the user can return to automatic detection. Persist explicit account preferences; before sign-in, use a local preference and reconcile it with the account setting after sign-in.
- Resolve browser language preferences on initial entry, including regional variants. Use request language preferences for the initial server render and reconcile browser preferences without resetting forms, chats or open windows. Match an exact supported locale first, then a supported base-language variant, then the next preferred language. Proposed initial complete catalogs: `pt-BR`, `en`, and `es`, with English fallback. These are a starting coverage proposal, not a user-imposed restriction; the full launch language list remains to be finalized. Do not claim translation into every language when a fallback is shown.
- Translate login/signup/recovery, desktop shortcuts, menus, tooltips, dialogs, presence and task states, validation and error messages, bot role descriptions, group controls, file actions, accessibility labels, and the welcome Notepad including its document title and numbered instructions. Localize in-app promotional text; any future fictional period advertisements must follow the same rule. Keep Bot Messenger, proper names and original uploaded filenames unchanged.
- Use complete versioned translation catalogs for product UI rather than making a paid model call per label or relying on browser page translation. Missing keys use a readable fallback and are tracked before release; raw translation keys must never be shown. Automatic means language detection and translated rendering, not unreviewed live rewriting of controls.
- Initialize bot response language from the resolved user language. An explicit request in the conversation overrides that default. Changing interface language affects future default responses, not already stored messages or files. Preserve user text and historical responses verbatim; any future translate-message action must retain the original. A language change must not erase bot memory, change task instructions mid-run or silently translate code.
- Localize dates, numbers and plural forms while keeping currency and time zone semantically correct. Browser language does not establish the user's country or time zone. Update document language and text direction for supported locales; a future right-to-left locale requires verified layout support before being advertised.
- Portuguese strings quoted elsewhere in this PRD are source-copy references. Their localized equivalents must match the actual labels shown in each locale, including guide references to **Adicionar bot**, **Criar grupo**, **Acompanhar** and **Parar**.

### Default display pictures

Added September 6, 2026 from the user's Finder screenshot and explicit request. Use the downloaded **wlm2009displaypic** collection as the default picture catalog for both bots and the human user, replacing the current placeholder portraits. This specific asset choice supersedes the prior original-only portrait requirement.

- Verified source folder: `/Users/lucianoabreu/Downloads/wlm2009displaypic`.
- Project copies: `public/assets/display-pictures/`; 30 files, comprising 25 PNGs and five GIFs. Original filenames and bytes are preserved; [asset manifest](display-pictures-manifest.json) records SHA-256 checksums. The collection is user-provided; its historical identity is user-described, not independently authenticated.
- Use this catalog for the user's initial avatar, preset bots, newly created bots and both user/bot picture pickers. Existing explicit user selections must not be overwritten by onboarding retries or catalog updates.
- Default implementation choice: use `0c5319e7147890e45265faad3b17701c1de71b12.png` (the green-person portrait selected in the supplied Finder screenshot) for a new user. Assign distinct catalog pictures deterministically to initial bots; record the mapping with the preset definitions rather than randomizing on reload.
- Users may choose any catalog picture for their own profile or bots. Persist the stable asset identifier and show the same selection in contacts, conversation portraits, group attribution and profile controls after refresh and sign-in.
- Preserve aspect ratio and image contents inside the existing Messenger portrait/presence frames. Do not redraw, recolor, or crop these images to circles. Serve them from project assets rather than referencing the Downloads folder at runtime.
- Preserve animated originals. Respect reduced-motion preferences with a still preview for GIFs; do not modify the supplied originals. Provide meaningful accessible labels and a valid catalog fallback if an asset fails to load.

Catalog files are staged locally; this PRD update does not claim that live avatar rendering or selection persistence has been implemented.

### Desktop shortcuts and welcome Notepad

Added September 6, 2026 from the user's supplied Safari screenshot and explicit interface feedback. This is a product requirement, not an implemented UI claim.

The signed-in wallpaper is the product desktop. Place two labeled application shortcuts in a vertical column at the upper left, clear of the initial windows: **Bot Messenger** and **Bloco de Notas**. Use the existing original Messenger artwork and an original notepad-style icon. Keep the existing fullscreen login and absence of an OS taskbar.

On first entry, show the contact window and the welcome Notepad together. Place Notepad beside the contact window, leaving both title bars and desktop shortcuts visible on a notebook-sized viewport. Use readable text and responsive positioning rather than shrinking the whole desktop. Both windows support dragging, resizing, focus stacking, minimize/restore and close; keep controls reachable after viewport changes.

A click/tap on a shortcut opens or restores its app and brings its existing window to the front. Repeated activation must not create duplicate windows; keyboard Tab then Enter/Space performs the same action. A desktop-like selection/focus highlight must remain visible. Single-click activation is an intentional web adaptation.

Closing Notepad hides the window without removing its shortcut. Reopening restores the guide. Closing the Messenger contact window hides it without signing out or cancelling work; its shortcut restores it. Explicit **Sair** remains the sign-out action. Minimized windows can also be restored from their shortcuts. Save Notepad open/closed state per signed-in user in the browser so a dismissed guide does not reopen on every refresh; first entry on a new browser starts with the guide open. This local presentation preference is separate from the product's durable bot memory.

#### Historical visual baseline

Use **Windows 7-era Notepad (2009 generation)** as the visual target: a compact Aero-style frame and title bar, small document icon, minimize/maximize/close controls, a light menu strip, white plain-text document area, black monospaced text, and conventional scrollbars. Title: **Como usar o Bot Messenger.txt - Bloco de Notas**. Menu labels: **Arquivo, Editar, Formatar, Exibir, Ajuda**. Reproduce the period appearance using original CSS/assets; this is a web reconstruction, not the Microsoft executable.

Research sources checked September 6, 2026:

- [Windows 7 RTM Starter gallery, August 15, 2009](https://news.softpedia.com/news/Windows-7-RTM-Starter-Edition-100-Screenshot-Gallery-119347.shtml): indexed screenshot identifies Notepad and build 7600. Starter chrome is not the target for the requested Aero appearance.
- [Windows 7 menu color, March 26, 2010](https://superuser.com/questions/124433/windows-7-menu-color): near-period first-hand Notepad menu screenshot and Aero discussion. [Image reference](https://i.sstatic.net/6G1OJ.png).
- [Portuguese Windows 7 Notepad example, December 2012](https://azugri.blogspot.com/2012/12/bloco-de-notas-do-windows-7.html): later screenshot reference for Portuguese menu labels and document layout, not a 2009-dated capture.

Image search indexed these captures; direct image fetches for the latter two failed during PRD research. Inspect full-resolution references before claiming pixel fidelity during implementation. Exclude third-party Glass Notepad variants, Windows 8 flat frames, and modern Notepad tabs/formatting toolbars from the reference set.

#### Welcome document content

The guide uses localized product copy (Portuguese source text below) and literal numbered plain-text lines, not Markdown rendering or a rich-text toolbar. This text describes the target release; demonstration mode must retain a visible simulation label and must not present unavailable capabilities as working.

```text
COMO USAR O BOT MESSENGER

1. Escolha um bot na lista e abra a conversa.
2. Diga o que você precisa e como quer receber o resultado.
3. Para criar um bot, clique em Adicionar bot e defina sua função.
4. Crie um grupo para os bots trabalharem juntos.
5. Acompanhe o andamento na conversa e o computador em Acompanhar.
6. Use Parar quando quiser interromper uma tarefa.
7. Confira a resposta e baixe os arquivos entregues.
8. Volte à conversa para continuar: seus bots guardam o contexto.

Fechou este guia? Clique em Bloco de Notas no desktop para reabrir.
```

Use **Acompanhar** as the user-facing label for the existing Watch concept wherever the guide points to it. Group creation must be discoverable from the Messenger controls and use the label **Criar grupo**. Keep the guide synchronized with actual control names.

For this release, Notepad is a selectable, read-only welcome document rather than a general file editor. Allow copying, selecting all, word wrap, font-size adjustment, downloading the guide as .txt, closing and reopening. Preserve the historical menu headings; unsupported editing/file commands are visibly disabled, not fake successful actions. These limited behaviors are explicit product adaptations. General personal-note editing and cloud note storage are not introduced by this request.

### Surface-by-surface scope

| Prototype feature | V0 decision |
|---|---|
| Fullscreen entry, avatar, glass blue gradients, compact controls | Preserve and adapt to real login |
| Fictitious email/password signup and recovery | Preserve the approved email/password login, signup and recovery screens; connect them to Supabase Auth; keep fictitious authentication isolated to the explicitly labeled demonstration |
| Local demonstration account | Optional explicit local demo only; never a fallback authenticated session or production credential |
| Contact list, search, avatars, presence | Preserve layout and grouping; the demonstration has all 13 contacts; live mode lists owned presets and custom bots with real presence |
| Text conversation, Enter/Shift+Enter, drafts, history | Keep; history persisted; independent 2009-style conversation windows with per-contact drafts |
| Create custom bots | Connect the approved dialog to durable real provisioning with role, instructions, avatar and configured limits; server policy still bounds capabilities |
| Per-bot instructions | Keep bounded editable instructions; apply only to future runs; never override server tool policy |
| Files toolbar | Show generated deliverables and authorized downloads; user uploads deferred |
| Stop, activity, history | Keep with real run state and explicit outcomes |
| Watch | Add genuine authenticated desktop frames; no simulated progress represented as real |
| Favorites, contact-list folders, compact modes, themes, custom portrait, nudge, optional sound, rich composer | Preserve approved UI and local interactions in the implementation; cloud persistence can follow separately |
| Desktop wallpaper and movable windows | Use an original aurora wallpaper after login; both the contact list and independent conversation windows support dragging, focus stacking and viewport bounds; no tabs or OS taskbar; minimizing a conversation must not interrupt a run |
| Desktop application shortcuts | Add Bot Messenger and Bloco de Notas icons at the upper left; activate to open, focus or restore their windows without duplicates |
| Welcome Notepad | Open beside Messenger on first entry; Windows 7-era appearance, concise numbered guide, close/reopen through its desktop icon and remembered dismissal |
| Advertising placement | Reserve a labeled area below What's New in the contact list; V0 uses local promotional placeholder content without third-party ad delivery or tracking |
| Manual connect/disconnect, arbitrary presence for bots | Remove; compute lifecycle and presence derive from actual state |
| Export transcript | P1; generated artifact downloads are P0 |
| Windows taskbar, original Microsoft logos/audio | Excluded |

No private-site accounts, third-party OAuth integrations, payments, publishing, purchases, external message sending, arbitrary public shell, unrestricted browsing, marketplace, multi-user shared workspaces, voice/video, replay recording, hourly free tasks in V0. These expand authorization, abuse, cost or operational complexity beyond the experiment.

## 5. User stories

1. As a new visitor, I want to enter through a familiar Messenger screen and sign in safely so my contacts and work belong to me.
2. As a returning user, I want the same bot and conversation so I can continue without reconstructing the context.
3. As a task owner, I want to see queued, working, waiting and finished states so I understand what is happening.
4. As a task owner, I want to watch the actual computer and stop work so I retain control.
5. As a user who closes the page, I want work and delivered files to survive so a browser connection does not determine completion.
6. As a user facing a failure or limit, I want a clear outcome and any saved outputs so I can make an informed next attempt.
7. As a workspace owner, I want other users excluded from my messages, desktop and files.

## 6. Acceptance requirements

All P0 criteria are public-pilot launch requirements. A local foundation may only claim the subset it actually implements.

| ID | Priority | Acceptance criterion |
|---|---|---|
| UX-01 | P0 | Given a signed-out visitor, the homepage renders a fullscreen Messenger-inspired entry screen with Bot Messenger branding, no OS taskbar, browser-localized copy and keyboard-operable login. No unsupported control appears to work. |
| UX-02 | P0 | All system-authored UI uses bot/bots; preset names match the specified AI-prefixed names in list, conversation, activity, error and artifact contexts. User-entered content is not rewritten. |
| UX-03 | P0 | After sign-in, an aurora wallpaper appears behind the contact and conversation windows. Title bars support pointer dragging and keyboard movement; activating a window brings it forward, and resizing keeps its title bar reachable. The contact list includes a clearly labeled advertising placement. |
| AUTH-01 | P0 | Successful email/password signup or login creates or resumes the Supabase session and provisions exactly one instance of each preset. Repeated callbacks do not duplicate profiles, bots or conversations. Failure/cancellation returns a useful entry state. |
| AUTH-02 | P0 | Reload preserves the legitimate session. Sign-out removes access to private app state. Expired sessions cannot send, subscribe, watch or download; reauthentication restores persisted work. |
| BOT-01 | P0 | The contact list includes only the owner's presets and custom bots. Search matches full names. Switching away and back restores persisted messages and run state without stopping execution. |
| MSG-01 | P0 | A nonempty message of at most 8,000 characters queues one run and one user message in a transaction. Empty/oversized input receives a validation error without dispatch or reservation. |
| MSG-02 | P0 | Repeating the same user-scoped idempotency key and same payload returns the original result. Reusing the key with another payload returns conflict. Concurrent duplicate requests cannot create two runs. |
| RUN-01 | P0 | API returns an accepted run after durable persistence; work executes in Trigger.dev independently of page or request lifetime. Closing and reopening the browser restores progress/result. |
| RUN-02 | P0 | Database constraints and worker lease fencing prevent simultaneous controllers for a bot. Admission and dispatch also enforce per-user and global execution caps under concurrency. |
| RUN-03 | P0 | Busy is derived from queued/starting/running/finalizing work, with explicit localized subtext. Waiting, failure and paused computer states remain distinct; typing is never fabricated to stand for all execution. |
| RUN-04 | P0 | Stop durably requests cancellation. Worker checks it before each model call, tool action and batch element; it interrupts in-flight work when supported, records the outcome and pauses compute. UI shows “Parando...” until acknowledged and never claims instant rollback. |
| RUN-05 | P0 | A clarification checkpoints the run, releases its worker/compute allocation and shows a question. One authorized reply resumes the same run with an idempotent continuation number and remaining budget; it does not silently create unlimited fresh allowance. |
| RUN-06 | P0 | Dispatch failure, worker crash, stale lease and uncertain tool outcome have deterministic recovery. A retry does not blindly replay an unconfirmed side effect or append duplicate final replies/artifacts. |
| INS-01 | P0 | Owner may update bounded instructions (maximum 4,000 characters). A run records its instruction version; editing during execution affects the next run only. Preset capability and security rules remain server-owned. |
| PC-01 | P0 | A tool task creates/resumes only the server-resolved computer assigned to that bot's user. Ordinary strategy chat creates no desktop. Guest template, ownership, health and network policy are verified before actions. |
| PC-02 | P0 | After approximately 15 seconds of user-wide idle time the worker pauses the shared computer, atomically rechecking that no bot has active computer work or a resource lease. Timeout is explicitly configured to pause; incidental access cannot automatically resume it. |
| PC-03 | P0 | After normal pause/resume a previously created test file remains usable. If replacement is needed, exported deliverables are restored and the UI discloses lost machine state rather than claiming full continuity. |
| WATCH-01 | P0 | Only the owner may obtain a 60-second renewable watch lease for active desktop work. UI shows real frames, capture time and stale/error states; target perceived update is 1–3 seconds, to be measured. |
| WATCH-02 | P0 | No sandbox control token, VNC/CDP address or keyboard/mouse control reaches the browser. Closing Watch or expiry stops extra captures and removes temporary frame objects. A frame cannot be retrieved by another user. |
| FILE-01 | P0 | A delivered file is copied to private Storage with size, MIME type, checksum and run ownership before being announced as downloadable. Reload and sandbox loss do not remove that delivered copy. |
| FILE-02 | P0 | Export paths remain inside the workspace after normalization/symlink checks. Downloads require current ownership and short-lived authorization; HTML/SVG are downloads, never active same-origin previews. Failed export cannot produce false success. |
| SEC-01 | P0 | User A cannot read/write/subscribe/watch/download anything owned by B using guessed IDs, direct database/Storage requests or altered request fields. Anonymous access also fails. |
| SEC-02 | P0 | Secrets remain in trusted server/worker configuration. Sandbox IDs are references, not access credentials; clients cannot choose them. No public guest services or platform credentials are exposed. |
| SEC-03 | P0 | Model output, websites and files are untrusted. Tool schemas, arguments, paths and limits are validated outside the model; unsafe actions and unsupported destinations fail closed. Markdown cannot execute scripts. |
| COST-01 | P0 | Admission atomically reserves quota and estimated budget before dispatch. Before each potentially billable action the worker reserves headroom; exhaustion yields BUDGET_EXCEEDED without starting another call. |
| COST-02 | P0 | Maximum duration, model turns, computer actions and no-progress limits terminate work independently of the browser. Global kill switch rejects new work and requests active cancellation. Usage settles once and estimates are reconciled. |
| LIVE-01 | P0 | Private Realtime notifications contain sanitized data; reconnect fetches canonical state and missing sequenced events, discarding duplicates. Missed notifications never lose messages or completion. |
| A11Y-01 | P0 | Core login, contact switching, send, stop and download work by keyboard; focus is visible, status has text as well as color, and narrow screens have no inaccessible essential controls. |
| OPS-01 | P0 | Structured logs correlate run/provider IDs without raw message bodies, screenshots, credentials or document content. Operator can find failed/stale runs, pause admissions and reconcile orphaned compute. |
| EXPORT-01 | P1 | Owner can export a sanitized transcript with timestamps and full contact name. |
| I18N-01 | P0 | First visits with each supported browser locale render translated login, desktop, Messenger and Notepad without manual setup. Regional variants and ordered browser preferences resolve correctly; unsupported languages use the documented fallback. |
| I18N-02 | P0 | Manual language choice survives reload/sign-in; Automatic resumes browser selection. Switching language preserves forms, drafts, windows, conversation history and active runs. |
| I18N-03 | P0 | Every shipped locale covers visible strings, errors and accessible labels; no raw keys or clipped essential controls appear. The guide refers to the exact localized control names. |
| I18N-04 | P0 | New bot replies follow the resolved default or explicit conversational instruction. Existing messages/files remain unchanged; formatting does not silently convert currency or infer time zone from language. |
| AVATAR-01 | P0 | User and bot picture pickers expose all 30 catalog entries, defaults resolve to catalog assets, and every portrait surface reflects the saved selection after reload. Existing user choices survive repeated onboarding. |
| AVATAR-02 | P0 | All copied files match manifest checksums and load without a Downloads dependency; images retain their aspect ratio and portrait frames, with a still preview for reduced-motion GIF display. |
| DESK-01 | P0 | First signed-in entry shows labeled Messenger and Notepad shortcuts plus both app windows. At 1280x720 and 1366x768, guide text is readable and shortcuts/title bars remain reachable without whole-desktop scaling. |
| DESK-02 | P0 | Click/tap or keyboard activation opens/restores/focuses exactly one instance. Close and minimize both apps, reopen from shortcuts, and verify Messenger tasks and login remain intact. |
| NOTE-01 | P0 | Notepad shows the localized numbered guide specified above in a Windows 7-era frame. It can move, resize, maximize/restore and close; viewport changes keep window controls accessible. |
| NOTE-02 | P0 | Closing the guide survives refresh for that user's browser; the shortcut always reopens it with its contents intact. Another user's local presentation state is not reused. |
| NOTE-03 | P0 | Select/copy, wrap, font size and .txt download work as labeled. Unsupported menu actions are visibly disabled. Demo notice and guide control names match the actual product state. |
| TEAM-01 | P0 | Repeated onboarding provisions at least ten distinct approved roles without duplicates. Each role has a grounded task benchmark; missing integrations are disclosed. Exact default-catalog parity requires verified roster evidence. |
| TEAM-02 | P0 | A user creates and edits a custom bot, reloads, and resumes it with the same profile and conversation. Another user cannot access it. |
| MEM-01 | P0 | A saved preference and role correction affect a later session. User inspection, correction and deletion work; superseded values are no longer retrieved and provenance is retained appropriately. |
| TEAM-03 | P0 | Two independent bots make overlapping real progress for one user. Conflicting GUI/file actions are coordinated; a worker crash cannot leave stale resource control. |
| TEAM-04 | P0 | A bot delegates to another owned bot and receives a persisted, attributed result after reconnect. Duplicate delivery does not duplicate work, and the parent cannot starve the child. |
| TEAM-05 | P0 | The user creates a group, mentions two bots, sees attributed handoffs and a final deliverable, and restores history after reload. Removed members cannot receive new group context or post new messages. |
| TEAM-06 | P0 | All bots resolve to the same user computer; another user resolves to a different assignment. Cancelling one independent task does not pause a computer still used by another bot. |
| TEAM-07 | P0 | Cyclic handoffs terminate within configured depth/budget limits; root cancellation propagates to children, retries are idempotent, and no bot-to-bot message increases authorization. |

## 7. Technical contract

### Architecture

- Next.js and TypeScript on Vercel: short authenticated routes, session handling, UI, validation and admission.
- Supabase Auth, Postgres, private Storage and private Realtime Broadcast: identity and canonical durable product state.
- Trigger.dev: execution, periodic reconciliation, leases, budget checks, cancellation and computer lifecycle outside HTTP requests.
- Official OpenAI SDK using Responses API directly: model calls and a small explicit tool loop. Avoid another orchestration framework in V0.
- E2B Desktop: one resumable, replaceable computer per user, shared by their bots, created only when needed. Versioned non-admin template and restricted external access.

The trusted worker coordinates OpenAI and E2B; the model requests actions and the worker validates/executes them. The guest never coordinates privileged product operations. Surf is a selective reference, not the multi-tenant backend foundation.

### Persistence and ownership

Minimum logical records: profiles; bots; conversations (direct and group); conversation memberships; messages with sender/recipient attribution; user preferences; versioned bot memories; runs; handoffs; root-task budgets; resource leases; run events; checkpoints; user-owned computers; artifacts; watch leases; quota/budget reservations; usage ledger. Names may differ in code while preserving these contracts.

Every private record has an owner chain enforced through RLS and relational constraints, not only route filtering. Composite relationships must prevent associating A's conversation/run/artifact with B's bot. Browser clients cannot mutate operational status, leases, cost balances, provider references or trusted assistant messages. Restrict database mutation functions to their intended authenticated or worker roles; service-role use never substitutes for ownership validation on a user request.

Unique constraints: user plus preset; one primary direct conversation per bot plus independent group conversations; one computer assignment per user; user plus idempotency key; one open run per bot; final output keys per run; continuation number per run. Record normalized request fingerprints to detect conflicting idempotency-key reuse.

Persist message + run + reservation atomically. Dispatch after commit with `run_id` and continuation as task idempotency identity. Reconciler dispatches committed undispatched work; duplicate delivery is harmless. A worker claims an expiring lease with a monotonically increasing fencing token. Only the current token may execute actions or persist operational transitions; losing ownership means stop.

### State and lifecycle

Bot administrative state: ENABLED or DISABLED. Run progression: QUEUED → STARTING → RUNNING → FINALIZING → SUCCEEDED, optionally RUNNING → WAITING_FOR_USER → RUNNING. Active states may finish CANCELLED, FAILED, TIMED_OUT or BUDGET_EXCEEDED. Terminal transitions are immutable; an explicit retry is a new run.

Computer state: NOT_CREATED, CREATING, READY, PAUSING, PAUSED, RESUMING, UNAVAILABLE, DESTROYING, DESTROYED. Never collapse bot/run/computer status into one enum.

Presence precedence: disabled or unrecoverable computer → “Indisponível”; queued/starting/running/finalizing → “Ocupado” with reason; waiting for user → “Ausente — Preciso da sua resposta”; idle paused computer → “Ausente — Computador pausado”; healthy idle → “Disponível”. Chat-only presets can be available with no computer. Tool-capable presets with no computer explain “Computador inicia na primeira tarefa”. A failed run does not automatically mean the computer is broken.

Checkpoint confirmed model/tool steps and response references. On crash, inspect outcome before repeating any action. If certainty is unavailable, stop with a recoverable failure and retain existing outputs. Finalization is idempotent and must finish durable output storage before declaring success.

### API contract

Use owned bot/run IDs. Minimum operations: list/create/edit bots; inspect/update/delete memory; create/update groups and membership; authorize and deliver bot handoffs; paginate messages; post message; get run; paginate events; cancel run; reply to clarification; update future-run instructions; start/renew/stop watch; download owned artifact. Successful queue submission returns HTTP 202 with message ID, run ID and status. Invalid input returns 400, unauthenticated 401, unavailable/non-owned resource a consistent non-disclosing response, conflicting requests 409, quota/rate rejection 429 and integration unavailable 503. Do not expose public create/pause/resume computer endpoints.

Events carry schema version, unique ID, sequence, owner-scoped bot/run references, timestamp, type and sanitized payload. Persist meaningful transitions; do not persist every frame as event history. Database state is authoritative; Realtime is a notification path.

### Cost defaults and execution controls

Starting limits are configuration, not pricing promises:

- Initial engineering proposal: up to three executing bot runs per user, one executing controller per bot, ten executing runs globally. Parallel work is required; exact caps need measurement. Serialize conflicting computer-resource actions and release waiting-parent slots.
- Charge delegated work to its root-task reservation; creating bots or groups grants no additional budget. Cancellation of a root task stops its delegated work without cancelling unrelated tasks.
- USD 50 pilot override: at most two minutes active execution, twenty model turns and sixty computer actions per run.
- USD 50 pilot override: eight chat messages and one computer task per account, shared across bots, without automatic renewal. Reserve USD 0.02 per chat run and USD 0.25 per computer run; every Hermes chat also reserves USD 0.25 from the computer pool. Global allocation pools are USD 30 for chat and USD 10 for computer tasks; USD 10 remains outside execution as an operator reserve for infrastructure, tests and discrepancies. All paid tests must count against these pools or the reserve.
- Three consecutive steps with no new useful observation trigger a bounded recovery or failure.
- Model output token cap must fit the remaining reservation; zero price configuration or unknown model pricing disables paid execution.

Count lifetime welcome allowance at admission; duplicate delivery never counts again. The initial implementation conservatively retains the complete reservation and attempt on cancellation/failure. Any later refund requires verified no-cost execution and an idempotent operator-controlled settlement; it must never reset the global budget. Waiting time releases execution slots but preserves open-run lock and remaining limits; expire unanswered clarifications after 24 hours. Usage estimates include model, active compute and applicable storage/watch overhead; actual provider charges can diverge, so also configure a conservative project budget and reconcile. Do not claim the estimate is a guaranteed billing ceiling.

## 8. Security and data handling gates

Supported V0 work is read-only public research and local artifact generation. Start with an explicit operator-configured destination set and disabled computer execution when no validated policy exists. Enforce traffic policy outside the guest where possible; a prompt and a domain allowlist alone are not a complete boundary. Account for GUI access to terminal even if no shell tool exists. Block public guest ports and private/link-local backend fetch targets; validate redirect chains, file size and response size.

No personal website logins or imported credentials. No arbitrary uploads. No automatic sending, publishing, purchasing or destructive external actions. A request requiring those capabilities receives an honest scope explanation; a clarification is not permission to bypass server policy.

Proposed pilot retention: messages and exported artifacts remain until account deletion or a published retention change; operational event content 30 days; detailed checkpoints seven days after termination; frames two alternating temporary objects removed after watch expiry. Avoid promising unlimited storage: initial export maximum 10 MiB/file and 100 MiB/user, configurable. Communicate retention before admitting real users. Account deletion must revoke sessions, cancel active work, delete private objects and remove computers through a tracked, retryable cleanup process. No local prototype deletion claim implies remote deletion.

## 9. Phased, implementable backlog

| Phase | Work and owner responsibility | Exit evidence |
|---|---|---|
| F0 — Local foundation | Engineering: Next/TypeScript scaffold, licensed assets, all approved demonstration contacts, faithful entry/contact/conversation UI, domain states, provider interfaces, environment validation, schema/migrations and deterministic tests | Build/typecheck pass; local UI inspection; clear demo labeling and unsupported-integration behavior; no paid calls or launch claims |
| F1 — Real vertical slice | Integration engineering: confirm account-accessible model/tool combination; versioned E2B template; Responses loop; create file, export it, pause/resume | Recorded real run IDs, downloaded checksum, actual screenshot and resumed file; provider usage recorded |
| F2 — Durable identity and execution | Backend: Supabase email/password authentication, idempotent onboarding, owner-scoped API, RLS, transaction admission, Trigger dispatch/leases, event history, instructions versions | Two-user authorization suite, duplicate/concurrent admission tests, browser-close and worker-crash tests |
| F3 — Safe observable task lifecycle | Backend/UI: real presence, cancellation, budgets, clarification, private Watch, artifact delivery, reconciliation, idle pause | Cancellation/limits/failure-injection results; watch isolation and expiry; orphan cleanup evidence |
| F3b — Persistent collaborating team | Backend/UI: ten-role roster, custom bots, inspectable memory, group membership, durable handoffs, shared computer resource coordination and parallel scheduling | TEAM-01 through TEAM-07 and MEM-01 pass, including restart, contention, cancellation and isolation evidence |
| F4 — Limited pilot readiness | Release/operator: production projects and secrets, Auth redirect domains, supported destinations, retention notice, usage dashboards, account cleanup, global kill switch | Deployed-domain smoke, real acceptance evidence for all P0s, explicit publishing authorization and limited cohort admission |
| F5 — Learning and polish | Product/engineering: benchmark analysis, follow-up interviews, cost/context tuning, strongest missing convenience features | Measured reasons for continued use and prioritized follow-ups; no scope expansion without evidence |

F0 can begin while external accounts are unavailable. F1 is the critical integration risk and should be proved before polishing peripheral UI. No fixed 24-hour commitment: the reference timeline assumes credentials, vendor access and a working path that have not yet been verified here.

## 10. Definition of Done and release gates

### Local foundation done

A runnable local Next.js project exists alongside the untouched reference prototype; expected flows render with the agreed branding/presets; domain contracts, migration and provider seams are reviewable; meaningful deterministic checks pass; environment examples contain no secrets. Missing integrations fail closed or are clearly marked as demonstration. The implementation report lists which acceptance IDs are complete, partial and unverified. This state is **not** a functioning production service or proof of real AI/computer use.

### Integration complete

Authenticated test accounts run genuine model/desktop work through the durable executor; exported output is downloadable; pause/resume and reconnect are verified; real provider errors have user-visible behavior; ownership, idempotency and quota assertions pass against actual database policies. Evidence includes date/environment and sanitized IDs, without credentials.

### Public pilot launch done

All P0 acceptance criteria verified on the deployed target; negative tenant-access and guest-exposure checks pass; cancellation/cost controls and reconciler are tested with induced failure; production Auth/secrets/limits/retention are configured; operator can stop admission and clean up resources; no misleading mock controls or outcomes remain. Publishing/deployment is separately authorized and its actual result checked. A successful local build alone cannot satisfy this gate.

## 11. External dependencies and remaining decisions

| Dependency or decision | Owner | Timing / safe default |
|---|---|---|
| Supabase project, region, connection configuration, migrations, email delivery and Auth redirect URLs | Operator | Before F2 integration; local foundation does not need real user data |
| OpenAI account, approved spend, enabled model and computer-tool schema | Operator + engineering | Before F1 paid smoke; model configurable, no availability assumption |
| E2B account, paid access if required, template ID and enforceable guest/network configuration | Operator + engineering | Before F1; desktop disabled until validated |
| Trigger.dev project, worker deployment identity and schedule configuration | Operator + engineering | Before F2 durability evidence |
| Hosting project/domain and release authorization | Operator | Before F4; no implied public publication |
| Supported source set and benchmark tasks | Product + engineering | Before enabling public research; start with a small explicit set |
| Retention and account deletion notice | Product + operator | Before first real pilot user; use Section 8 proposal until reviewed |
| Measured cost and user return rate | Product | During F5; no pricing or demand claim before evidence |

No unanswered product question blocks F0. External configuration blocks corresponding live integration, not useful local progress. Revisit broader capability scope after observing completed tasks and return behavior.
