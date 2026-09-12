# 接入指南 —— 写给负责编排层、quote engine、审批 UI、slow lane 的队友

这份文档是给需要**调用** `top-up-agent`(fast lane)的人,或者需要**被外层编排层调用**的人看的。假设你没读过 fast lane 的源码——只看这份文档,以及必要时指向具体代码位置的链接就够了。

如果你是负责 **slow lane**(Steel + Playwright)的,直接跳到 [第 5 节](#5-如果你在做-slow-lane)。

---

## 1. 这个包是干什么的,一句话说清楚

`top-up-agent` 是一个库,不是一个服务。它只有一个入口:`runFastLane(request, deps)`。给它一个任务断点(checkpoint)、一份报价(quote)、一份**已经签好名、已经过人工审批**的购买授权(mandate),再加一个连到某个 vendor WebMCP 工具的活连接,它会:检测这个 vendor 是否支持通过 MCP 工具购买、执行所有安全检查、调用购买工具、验证额度真的到账、然后返回一个 resume token。

它**不**决定买什么、**不**展示任何 UI、**不**给任何东西签名、**也不**知道怎么应付一个没有 MCP 工具的 vendor(那是 slow lane 的活)。"mandate 被人签字批准"之前的所有事,和"resume token 发出"之后的所有事,都是别人的代码——大概率就是你的。

---

## 2. 怎么把它加成依赖

三种接入方式,按 hackathon 时间成本从低到高排:

### 方案 A —— npm/yarn/pnpm workspace(推荐)

如果你的代码和这个包在同一个仓库(或者我们把仓库合并),在根目录加一个 `package.json`:

```json
{ "workspaces": ["packages/*"] }
```

把这个包挪到 `packages/fast-lane/`。你的代码直接:

```bash
npm install top-up-agent --workspace=your-package
```

import 立刻能用,不用发布、不用手动 link。这是摩擦最小的方案,值得花五分钟做。

### 方案 B —— 跨仓库的 `file:` 依赖

```json
// 你的 package.json
"dependencies": {
  "top-up-agent": "file:../Top-up-agent-Fast-slow-lane"
}
```

跑 `npm install`。这边代码每次改动后你都要重新 `npm install`(或者开发阶段用 `npm link` 做实时软链)。

### 方案 C —— git 依赖

```json
"top-up-agent": "github:<owner>/Top-up-agent-Fast-slow-lane"
```

适合仓库已经推上去、且你们不需要同时在两边写代码的阶段。

不管选哪种:先在这个包里跑一次 `npm run build`(或者如果你的工具链也是 tsx/ESM 友好的,可以直接指向 `src/`——这个包除了 `tsc` 之外没有别的构建要求)。

---

## 3. 公开接口参考

下面这些都从包的根路径导出(`import { ... } from "top-up-agent"`)。

### 3.1 你要调用的唯一一个函数

```ts
function runFastLane(
  request: FastLaneRequest,
  deps: FastLaneDeps,
): Promise<FastLaneResult>;
```

```ts
interface FastLaneRequest {
  checkpoint: TaskCheckpoint; // 任务卡在哪
  quote: Quote;               // 要买什么
  mandate: PurchaseMandate;   // 已签名的购买授权
}

interface FastLaneDeps {
  session: WebMcpSession;      // 连到 vendor MCP 工具的活连接
  mandateSecret: string;       // 必填 —— 见 4a
  store?: IdempotencyStore;    // 实际使用中必填 —— 见 4b(默认是内存版，几乎不会是你真正想要的）
  verifyRetry?: VerifyRetryOptions; // 默认 { attempts: 3, delayMsBetween: 200 }
  emit?: (event: FastLaneEvent) => void; // 给你的时间线 UI 用
  now?: () => Date;            // 只用于测试注入
}

interface FastLaneResult {
  purchaseId: string;
  verifiedEntitlement: Entitlement;
  resumeToken: ResumeToken;
}
```

### 3.2 你(或 quote engine / 审批 UI)在调用前要构造好的东西

这几个结构体由你自己构造——这个包从不生成它们:

```ts
interface TaskCheckpoint {
  taskId: string;
  agentId: string;
  originalGoal: string;
  failedToolCall: { id: string; tool: string; arguments: unknown }; // 之后会被原样重放
  origin: {
    provider: string;
    canonicalOrigin: string;       // 例如 "https://api.higgsfield.ai"
    source: "task_configuration";  // 唯一合法值 —— 绝不能从 vendor 的返回内容推出这个字段
    lockedAt: string;
  };
  failure: { type: BlockerType; rawError: unknown };
}

interface Quote {
  provider: string;
  purchase: { productId: string; quantity: number; credits: number; price: number; currency: string };
  billing: "one_time" | "subscription";
  autoRenew: boolean; // 必须是 false —— guard 会拒绝 true
  reason: string;
}

interface PurchaseMandate {
  mandateId: string;
  taskId: string;
  origin: string;          // 必须等于 checkpoint.origin.canonicalOrigin
  provider: string;
  productId: string;       // 必须等于 quote.purchase.productId
  maximumAmount: number;   // 硬上限 —— quote.purchase.price 不能超过它
  currency: string;
  billingType: "one_time";
  autoRenew: false;
  expiresAt: string;
  nonce: string;
  signature: string;       // 见下面的 signMandate() —— 不要自己手搓签名
}
```

### 3.3 签名(审批层的活)

```ts
function signMandate(mandate: Omit<PurchaseMandate, "signature">, secret: string): string;
function verifyMandateSignature(mandate: PurchaseMandate, secret: string): boolean; // runFastLane 内部会用，一般不用你自己调
```

签名用的密钥必须和 `runFastLane` 拿到的 `deps.mandateSecret` **是同一个**。见 4a。

### 3.4 获取 `WebMcpSession`

```ts
function connectMcpWebMcpSession(options: {
  provider: string;              // 必须等于 mandate.provider
  url: string | URL;             // 必须等于 mandate.origin —— 取自任务配置，绝不能来自 tool 的返回结果
  headers?: Record<string, string>; // 例如 { Authorization: `Bearer ${token}` } —— 绝不能放卡号等信息
  clientInfo?: { name: string; version: string };
}): Promise<McpWebMcpSession>;
```

这个函数通过 MCP Streamable HTTP 连接真实 vendor。用完调用 `session.close()`。如果需要别的传输方式，自己实现 `WebMcpSession` 就行——只有三个方法(`origin`、`provider`、`listTools()`、`callTool()`)。

### 3.5 错误类型 —— 分别代表什么、你该怎么处理

| 错误 | 发生了什么 | 是否已经产生实际影响 | 你该怎么办 |
|---|---|---|---|
| `NoFastLaneError` | vendor 没有 MCP 购买/查余额工具 | 没有 —— 没尝试购买 | 用同一份 `{checkpoint, quote, mandate}` 转交给 **slow lane** |
| `MandateRejectedError` | 某个前置 guard 没过(签名错误/伪造、已过期、origin 不对、价格超上限、provider/product 不匹配、autoRenew 为 true) | 没有 —— 没尝试购买 | 不要盲目重试。上游肯定哪里错了(mandate 过期、quote 被篡改、密钥不对)。用一份全新的、范围正确的 quote 重新走一遍签名和审批 |
| `PurchaseInFlightError` | 针对同一个 `(task, requirement)` 的另一次调用正在进行中 | 未知 —— 那次调用还没结束 | 等一等再查(轮询，或者干脆别马上重试)。**不要**循环重试——这个错误存在的意义就是防止这种竞态 |
| `PurchaseFailedError` | vendor 的工具明确报告购买失败 | 没有 —— vendor 明确说了不行 | 可以安全重试(用同一个或新签一份未过期的 mandate),或者重新报价(比如价格变了) |
| `PurchaseVerificationError` | 购买调用成功了(或者结果不明且无法恢复),但余额不够 | **可能已经产生影响** —— 钱可能已经动了 | **不要**自动重新购买。这需要人工/运营介入，或者针对差额重新出一份 top-up 的 quote。现在恢复任务只会让它立刻再撞一次同样的付费墙 |
| 其他任何异常(原始 exception) | 没被归类的网络/传输层失败 | 未知 | 当作临时性问题处理；编排层做常规的重试/退避是可以的，因为购买这一侧的状态没有被模糊地改动过 |

---

## 4. 三个必须和签 mandate 的人、跑 store 的人对齐的"契约"

这三样任何一个没对齐，轻则悄无声息地失败，重则重复扣款。

### 4a. `mandateSecret` —— 两个组件必须用同一个值

做审批 UI 的人调用 `signMandate(unsigned, SECRET)`。调用 `runFastLane` 的人传 `deps.mandateSecret = SECRET`。**这两个必须是同一个字符串**，否则每一份 mandate 都会被判定为伪造而拒绝(这是对的——检查存在的意义就在这)。

- 放到环境变量里，比如 `MANDATE_SIGNING_SECRET`，两个组件从同一个来源读取(共享的 `.env`、共享的密钥管理服务——不要两个人各自往两个文件里敲"hunter2")。
- 用 `openssl rand -hex 32` 之类的方式生成。不要复用密码或者已有的 API key。
- 绝不提交到 git，绝不打印到日志，绝不塞进 mandate 的任何字段里。

### 4b. `IdempotencyStore` —— 必须是同一个、持久化的东西

默认值(`new InMemoryIdempotencyStore()`)是**每个进程、每次运行**独立的。如果你的编排层每次调用 `runFastLane` 都 `new` 一个新的(或者跑在多个进程/多个实例上),这个包存在的核心保证——"不会买两次"——**就不成立了**——每次调用看起来都像是第一次购买。

- 如果是单个长期运行、处理所有恢复任务的编排层进程:在启动时创建**一个** `InMemoryIdempotencyStore()`，每次调用 `runFastLane` 都传同一个实例。demo 阶段够用。
- 如果会重启、要水平扩展、或者需要在购买过程中崩溃后还能恢复:针对 Redis 或 Postgres 实现 `IdempotencyStore` 接口(只有三个方法——`get`、`putIfAbsent`、`update`，见 [`src/fast-lane/idempotency.ts`](src/fast-lane/idempotency.ts))。**`putIfAbsent` 必须是原子操作**(`INSERT ... ON CONFLICT DO NOTHING RETURNING *`，或者基于 Redis `SETNX` 的写法)——如果用分开的读和写拼出"先检查再写入"，就又把这个接口本来要堵住的那个竞态问题带回来了。

### 4c. 如果你在做编排层:让 slow lane 的输入输出跟 fast lane 对齐

fast lane 和 slow lane 之间的切换,在你的代码里应该几乎无感。要做到这一点,让两条 lane 接受同样的输入、返回同样的输出结构:

```ts
// 两条 lane 都应该接受：
{ checkpoint: TaskCheckpoint, quote: Quote, mandate: PurchaseMandate }

// 两条 lane 成功时都应该返回：
{ purchaseId: string, verifiedEntitlement: Entitlement, resumeToken: ResumeToken }
```

让做 slow lane 的队友直接 `import type { TaskCheckpoint, Quote, PurchaseMandate, Entitlement, ResumeToken } from "top-up-agent"`，而不是自己重新定义一套长得很像但不完全一样的类型——这种"看起来一样但字段对不上"的偏差，正是"我这边测试没问题、demo 时炸了"这类 bug 的来源。

---

## 5. 如果你在做 slow lane

你不需要 `WebMcpSession` 或任何 `top-up-agent` 专属的东西——你的执行方式(Steel + Playwright)完全不同。但下面这几件事你需要做到:

1. **接受同样的输入结构**:`{ checkpoint, quote, mandate }`(类型从这个包里 import，见 4c)。
2. **自己实现 origin lock。** 这个包里的 guard(`assertPurchaseAllowed`，在 [`src/fast-lane/guards.ts`](src/fast-lane/guards.ts))是 fast lane 专属的管道代码，但**原则**对你完全适用:只能导航到 `mandate.origin`，绝不能导航到从 tool 返回结果或页面内容里冒出来的 URL。抄的是这个检查的精神，不是代码本身。
2b. 打开浏览器之前，你也应该自己校验一遍 mandate 签名(这个包导出的 `verifyMandateSignature(mandate, MANDATE_SECRET)`)——伪造 mandate 的风险对你同样存在。
3. **返回同样的成功结构**:`{ purchaseId, verifiedEntitlement, resumeToken }`。构造 `ResumeToken` 时用你收到的**同一个** `TaskCheckpoint`——整件事的重点就是让 host 原样重放最初失败的那次调用，而不是重新生成一个新的。
4. **像这个包一样，先验证再宣布成功**:完成结账不等于确认到账。结账后重新读一次 vendor 的余额/账户状态，再返回成功。
5. **绝不要假设浏览器超时就等于购买没发生。** 重试之前先查状态——参考 [`src/fast-lane/executor.ts`](src/fast-lane/executor.ts) 里"结果不明的失败"的处理逻辑，你在浏览器会话不稳定时会遇到完全同样的问题。

---

## 6. 接入完成前的检查清单

- [ ] 已把这个包加为依赖(workspace / `file:` / git)，import 能正常解析
- [ ] `MANDATE_SIGNING_SECRET` 只放在一个地方，签名方和调用方都从这里读
- [ ] 有一个共享的 `IdempotencyStore` 实例(或真正的持久化后端)——不是每次调用都 new 一个内存版的
- [ ] 每个 vendor 都拿到了一个 `WebMcpSession`，`origin`/`provider` 来自任务配置，绝不来自 tool 的返回结果
- [ ] 编排层针对 3.5 表格里的 5 种错误类型分别处理——不是一个笼统的 `catch`
- [ ] slow lane 的输入输出结构和 fast lane 对齐(见 4c、第 5 节)
- [ ] `resumeToken.resumeAction` 被原样重放回 host agent 的 tool-call 循环里
