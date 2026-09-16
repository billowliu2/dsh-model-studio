# dsh-model-studio · 模型商店

> DeepSeek Harness 的高级模型设置插件：把**模型供应商、模型能力、按供应商维度的请求头**集中到一个右侧抽屉里，入口按钮就在侧栏设置（齿轮）旁边。

[English](README.md) · **简体中文**

DSH 官方「模型」设置页刻意把两件事留给 `settings.yaml`：**没有按供应商维度的请求头编辑器**，**推理能力也不在可编辑字段之列**。本插件不替换官方页，而是补上这两块，并把整个供应商配置面搬进一个随手可开的抽屉。

零依赖、不需要构建：两半都是纯 JavaScript。

---

## 1. 功能

| 区域 | 说明 |
|---|---|
| 入口按钮 | 侧栏底部、设置齿轮**正上方**的「模型商店」按钮（宽栏显示图标 + 文字，56px 轨道只显示图标）；面板打开时按钮高亮。 |
| 悬浮抽屉 | 以**悬浮式右侧抽屉**盖在会话之上打开：半透明遮罩、圆角、阴影；Esc / 点遮罩 / ✕ 关闭。**不依赖会话**，首页也能开。一键可「停靠到右侧栏」变成官方面板。 |
| 停靠模式 | 同时注册为官方右侧栏 tab，可与其他面板分屏、浮动、记住宽度。 |
| 设置内页 | 同一个面板也注册为设置里的「模型商店」页 —— 稳定的兜底入口。 |
| 供应商列表 | 读已配置供应商，叠加适配器自带的供应商目录（区分「目录」与「自定义」），并显示适配器诊断。 |
| 全局思考 | 面板顶部一条可折叠的全局区：新会话的**默认推理等级**，且**只列出该模型真正支持的档位**；另有内置 DeepSeek 路由的思考总闸与默认档。折叠后仍显示当前策略。 |
| 供应商预设 | 新建供应商从**预设选择器**开始 —— 列出已安装目录里的每个供应商及其模型数。选中后会**按目录把协议与请求地址填好**，你只需要提供 API Key。两个字段仍可编辑：**不改动就不会写进配置**，因此继续由目录决定，DSH 升级后自动跟随；改动（例如走代理）才成为显式覆盖。混合协议的供应商刻意留空 —— 指定单一协议会把它的每个模型都钉死。 |
| 详情分区 | **基本信息**（含 API 密钥）/ **模型能力** / **自定义请求头** / **配置 JSON**：分段控件带图标与计数徽标，路由身份条与状态行固定，只有当前 pane 滚动。 |
| 基本信息 | 编辑 `displayName`、`api`、`baseURL`。**清空 = 取消覆盖**（回退到目录值），而不是写入空串。 |
| 模型能力 | 逐模型的上下文长度、输出上限、图像输入（继承 / 仅文本 / 文本 + 图像）、思考档位（继承 / 非推理模型 / 任选档位，自动映射过线拼写）。编辑器不认识的字段 —— `compat`、`thinkingBudgets`、pi-ai 将来新增的字段 —— 原样保留。 |
| 模型发现 | 「获取模型列表」：目录路由**本地零网络**回答（选中路由即自动加载）；带端点的自定义路由也会自动读一次，按钮用于重读。结果行给出 **模型数 · 耗时 · 来源**。已配置的模型标为已存在且不可重复勾选，未配置的默认预选。支持搜索、全选、取消、反选、「为获取的模型启用思考」，以及一次「同步（补 N / 删 N）」。既无端点又无目录的路由给出可操作提示而不是原始报错；端点 12 秒不响应会提示并继续等待。 |
| 能力参考库 | 自定义端点只回裸 id，所以插件把**已安装目录当参考库**：一次扇出建索引（实测约 8ms、零网络、约 890 个模型），用分级匹配（同名 → 去前缀 → 规范化）补上**上下文长度、输出上限、显示名**。候选行标「参考库」，tooltip 给出匹配来源与级别；「按参考库补全」可给手写或旧行补空值，且**绝不覆盖已有值**。 |
| 请求头 | 按供应商维度的 key/value 编辑器 + 预设（OpenCode `x-opencode-session`、OpenRouter 归属头、User-Agent）+ 名称/值校验 + 保留名警告（`user-agent` 会被运行时覆盖）。 |
| 配置 JSON | 用户层子树可编辑：保存时按顶层键差分、做路径级写入，未改动字段（凭据引用、手写 `compat`、你在别处加的注释）不会被整体替换。旁边同时展示合并后的有效值。 |
| API 密钥 | 只写输入框 → 凭据存储；`settings.yaml` 只保存引用名（供应商缺引用时派生 `<ROUTE>_API_KEY`）。显示引用来源与是否可写。 |
| 新建 / 删除供应商 | 一次写入 `providers.<route>`（用预设时只写凭据引用）；ID 语法在字段处校验。删除即 unset 用户层，并明确提示哪些供应商来自组合基础层、删除只会回退。 |

### 写入语义

三条规则，因为弄错任何一条都会搞坏一个本来能用的配置：

1. **清空 = 取消覆盖**：`displayName` / `api` / `baseURL` 留空，以及逐模型的 `input` / `contextWindow` / `reasoningEfforts` 留空，提交的都是 *unset*，目录值重新生效；绝不写空串或 `null`。
2. **目录路由走覆盖项**：对目录提供的模型改能力，只写该模型的覆盖项，其余目录模型继续原样服务。把目录路由固化成显式模型列表时，会在**同一次写入**里移除已经冲突的覆盖表。
3. **未建模字段原样往返**：编辑器只接管它认识的字段，`compat`、`thinkingBudgets` 与将来的字段键顺序不变地往返，`settings.yaml` 的 diff 因此最小。

## 2. 安装

**要求**：DSH `0.1.5-rc.2` 或更新；Node 版本见插件的 `engines`（`^22.19.0 || >=24.0.0`）。本插件是 bundle 插件：它自己声明 bundle patch，不需要手工接线。

### A. 用启动器安装（推荐）

```bash
# 从 git 仓库
dsh plugin --profile web add github:billowliu2/dsh-model-studio

# 或从本地 checkout（相对路径以你执行命令的目录为基准）
dsh plugin --profile web add /path/to/dsh-model-studio

# Windows PowerShell
dsh plugin --profile web add D:\Coding\Dsh-Plu
```

`dsh plugin` 会在 profile 目录里转发给 pnpm，然后**按已安装状态对账** profile 的 bundle 列表，插件会自动加入层栈。之后**重启应用并硬刷新浏览器**（Ctrl+Shift+R）：bundle 层在启动时组合，客户端 bundle 带内容哈希。

```bash
dsh web
```

### B. 离线安装（没有 pnpm 也能装）

`scripts/install.mjs` 直接做同样两步 —— 把包物化进 profile、写入依赖与 bundle 层。没有 pnpm、没有网络，或 Windows 上链接安装加载失败时用它。

```bash
node scripts/install.mjs --dry-run                     # 只报告，不改动
node scripts/install.mjs --profile web                 # 默认复制模式
node scripts/install.mjs --profile web --mode link     # 改为链接 checkout（开发用）
```

| 选项 | 含义 |
|---|---|
| `--profile <name>` | 装进哪个 profile（默认 `web`） |
| `--dsh-home <dir>` | DSH 主目录（默认 `$DSH_HOME`，否则 `~/.dsh`） |
| `--source <dir>` | 从哪个 checkout 安装（默认本仓库） |
| `--mode <copy\|link>` | 复制进 profile（默认）或链接 checkout |
| `--uninstall` | 从该 profile 卸载 |
| `--dry-run` | 打印将要发生的改动，不实际执行 |

它只读写 `<profile>/package.json` 与 `<profile>/node_modules/dsh-model-studio`，**从不碰 `settings.yaml`**，并通过回读 profile 打印组合后的 bundle 行。Windows 上建议用默认的复制模式：链接进来的是一个目录重解析点，部分进程无法遍历，加载器会对刚解析成功的包报 `EPERM`。

### 验证安装

```bash
dsh --profile web --dump-config | grep -A1 'id: model-studio'      # POSIX
dsh --profile web --dump-config | Select-String 'dsh-model-studio' # PowerShell
```

出现一行 `dsh-model-studio` 就说明 bundle 层已组合。应用里，入口按钮在侧栏底部、设置齿轮正上方；**设置 → 模型商店**也始终可用。

### 卸载

```bash
dsh plugin --profile web remove dsh-model-studio
node scripts/install.mjs --profile web --uninstall   # 离线路径
```

卸载**不会动**你的供应商、密钥与模型能力：它们存在官方设置节与凭据存储里，有没有本插件都继续生效。若还想清掉本插件自己的展示元数据，把 `settings.yaml` 里的 `model-studio:` 节删掉即可。

## 3. 数据落点

插件不自建配置文件。凡是已有 pi-ai 字段能表达的，一律写回官方设置：请求路径因此天然生效，官方「模型」页也能看到，其它插件同样识别。

| 界面字段 | 设置落点 |
|---|---|
| 供应商名称 | `llm-pi-ai.providers.<route>.displayName` |
| API 格式 | `llm-pi-ai.providers.<route>.api`（`openai-completions` / `openai-responses` / `anthropic-messages`；留空 = 目录协议） |
| 请求地址 | `llm-pi-ai.providers.<route>.baseURL` |
| 托管供应商（无需凭证） | **故意不写** `apiKeyEnv`，把认证交回供应商 |
| API Key | `llm-pi-ai.providers.<route>.apiKeyEnv` 只存引用名；密钥本体进凭据存储 |
| 显示名称 / 实际请求模型 | `llm-pi-ai.providers.<route>.models[].name` / `.id` |
| 上下文长度 / 输出上限 | `models[].contextWindow` / `.maxTokens`，另有路由级回退 |
| 思考 | `models[].reasoningEfforts`（档位 → 过线拼写；`false` 表示非推理模型） |
| 图像输入 | `models[].input`（`["text","image"]`） |
| 请求头 | `llm-pi-ai.providers.<route>.headers` |
| 默认推理等级（全局区） | `agent-default-model.reasoningEffort` |
| 内置 DeepSeek 思考总闸与档位 | `llm-deepseek.thinking` / `llm-deepseek.reasoningEffort` |
| 备注 / 官网 / 图标 / 标签 | `model-studio.providers.<route>` —— 本插件自有的展示元数据 |

所有写入都走官方 settings seam：schema 校验、按 revision 做并发冲突检测、原子落盘、热生效。插件不会绕过校验直接改 YAML；适配器拒绝某个改动时，面板会在状态行显示错误。

### 为什么全局档位列表这么短

推理档位是适配器自有的 id，向模型请求一个它不提供的档位是**硬错误**（`UNSUPPORTED_REASONING_EFFORT`），会让该模型的每个请求都失败。所以全局区**只列出宿主自己的模型目录为这个路由和模型报告的档位**；读不到时只给「未设置」。如果已存的档位不再适合当前默认模型，下拉里会把它显示成 *当前模型未声明此档位*，方便你看到并清掉。当 DeepSeek 总闸管不到你的默认模型时，全局区也会明说 —— 默认模型跑在别的路由上时，这一点很容易踩错。

## 4. 兼容性

| 依赖 | 作用 | 缺失时 |
|---|---|---|
| 侧栏 UI | 入口按钮 | 退回设置内页 |
| 右侧栏 UI | 抽屉 / 停靠面板 | 退回设置内页 |
| 设置 UI | 设置绑定 + 页面席位 | 面板显示数据面不可用 |
| `@deepseek-ai/dsh-llm-pi-ai` | 供应商字段语义、模型发现 | 只能编辑 JSON 视图 |
| `@deepseek-ai/schemastery` | 宿主半注册自己的命名空间 | 宿主半不激活 |

已在 **dsh 0.1.5-rc.2**（Windows / Node 24）验证。DSH 处于 developer preview，名称与几何可能随版本变化。

## 5. 验证状态

三套测试全部离线、在仓库根目录运行：

| 测试 | 项数 | 覆盖 |
|---|---|---|
| `node test/smoke.mjs` | 160 | 注册与反注册、席位接线、双语语言包完整性、两种宿主里的面板渲染、Tab 切换、抽屉开/关/停靠、类名 ↔ 样式表契约、参考库补全端到端、预设预填与创建 |
| `node test/api.mjs` | 180 | 供应商派生、path op 语义、能力草稿往返、发现合并、请求头校验、JSON 差分、凭据写入顺序、档位与预设解析、目录快照 |
| `node test/host-schema.mjs <profile-dir>` | 15 | 用 profile 自己的模块图重建并校验宿主 schema，包括供应商预设写入的最小文档 |

```bash
npm test                                                  # smoke + api
node test/host-schema.mjs "$env:USERPROFILE\.dsh\profiles\web"
```

`test/host-schema.mjs` 需要一个 profile 目录，只是为了像真实安装那样解析 peer 依赖 —— 它不写任何东西。

**已验证**：宿主半在启动时注册命名空间；浏览器半被注入 boot graph 并经内容哈希路由可取；bundle 层组合进 profile 树；`scripts/install.mjs` 的安装、卸载、重装都能收敛。

**未在本机验证**：真实浏览器里的像素几何，以及脚本化的鼠标点击链路（改 → 保存 → `settings.yaml`）。渲染、props 传递与写入语义由上面的测试覆盖，但开发机没有可用的浏览器驱动。

## 6. 开发

装进一个隔离 profile 并在备用端口启动，不影响正在运行的应用：

```bash
node scripts/install.mjs --profile model-studio-dev --mode copy
dsh --profile model-studio-dev --patch dev/plugin-dev-port.yml --no-open
```

`dev/plugin-dev-port.yml` 把 web 服务固定在备用 loopback 端口。改完代码重跑一次安装（复制模式会刷新 profile）并重启即可。`node scripts/install.mjs --profile model-studio-dev --uninstall` 可移除。

### 保持供应商预填为最新

新建表单预填的协议与端点来自**本机目录快照**：直接从 `@earendil-works/pi-ai` 读出并内联进浏览器半边。DSH 升级后重新生成：

```bash
npm run catalog:defaults     # 默认读取 "web" profile 的目录
npm run catalog:check        # lib/client.js 过期时返回非零，不改动任何文件
node scripts/generate-catalog-defaults.mjs --profile web
```

快照过期**不会**弄坏请求：预填值只有在你改动时才会写入，没动过的路由继续跟随实时目录。快照的来源与日期就显示在表单里。

## 许可证

MIT
