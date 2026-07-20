# cheerful-music-ai
AI music content system

## Cheerful GPT（服务器安全配置）

`OPENAI_API_KEY` 只允许配置在 Vercel 的服务器环境变量中，禁止写入
`index.html`、浏览器 JavaScript 或 GitHub 文件。

需要在 Vercel Project Settings → Environment Variables 配置：

- `OPENAI_API_KEY`：OpenAI API Key。
- `OPENAI_MODEL`：可选，默认 `gpt-5.6-luna`。
- `CHEERFUL_GPT_SESSION_SECRET`：至少 32 位随机字符串，用于签发 HttpOnly 会话。
- `CHEERFUL_GPT_ACCESS_KEYS`：登录密码与身份角色的 JSON 映射。密码是 JSON 的 key，
  只保存在 Vercel；前端不会保存密码。例如
  `{"一个仅保存在Vercel的随机密码":{"id":"snow","email":"snow@cheerfulmusic.com","name":"Snow","role":"ceo"}}`。

同一个服务器会话同时用于 Cheerful Music AI OS 与 Cheerful GPT。登录页面不再使用
浏览器内写死的测试密码；用户登录后，Cheerful GPT 自动继承该用户的角色，不需要第二次验证。

角色权限：

- 所有角色：使用同一个 Cheerful AI 页面，并可以联网搜索公开资料。
- `ceo`：可以查询全部获准接入的内部数据。
- `finance`：可以查询歌曲目录、Royalty Matrix、分成比例、平台收入、结算与金额。
- `ar`：只可以查询歌曲库、艺人、录音版本、ISRC/UPC 与 Song Matching 等音乐数据，不能读取财务金额。
- `hr`：只可以查询招聘与人事数据。
- `legal`：只可以查询合同与法务数据。
- `copyright`、`distribution`、`marketing`、`member`：目前只允许普通对话与联网搜索公开资料，不能向 AI 发送公司内部数据。
- `admin`：可以管理和查看审计日志，但默认不能读取财务金额。
- `viewer`：可以普通对话与联网搜索，不能读取内部业务数据或上传文件。

OS 左侧部门入口也按登录角色收敛：CEO 可进入全部模块；Finance、A&R、HR、
Marketing、Legal 等角色只显示本部门模块与统一的 Cheerful GPT。真正的数据隔离由
服务器的角色过滤执行，不能依赖前端按钮隐藏。

## Supabase（正式账号、数据库、文件和权限）

完整数据库脚本位于 `supabase/cheerful-os.sql`。它会建立：

- `users`：连接 Supabase Auth 的员工身份与角色。
- `songs`、`recordings`：作品与录音版本两层结构，支持 6,200+ 歌曲。
- `payees`、`royalty_rules`：收款方与 Royalty Matrix。
- `royalty_imports`、`royalty_import_rows`：平台报表批次、原始行、匹配状态与金额。
- `royalty_calculation_runs`、`royalty_calculation_lines`：可复算、可审计的版税计算批次与逐笔明细。
- `finance_exceptions`：匹配、规则、金额和成本回收异常及处理记录。
- `hr_records`、`recruitment_records`：HR 专属数据。
- `contracts`、`legal_records`：法务专属数据。
- `gpt_chat_messages`、`gpt_audit_logs`：跨设备聊天记录与审计日志。

脚本同时建立 RLS 数据库权限、Auth 用户同步触发器、搜索歌曲库的 RPC，以及三个私有
Storage bucket。正式配置步骤：

1. 在 Supabase SQL Editor 运行 `supabase/cheerful-os.sql` 全文。
2. 再运行 `supabase/finance-workflow-v2.sql` 全文，建立持久化计算和异常工作流（可重复运行）。
3. 在 Supabase Authentication → Users 创建员工账号。新账号默认是 `viewer`。
4. 在 SQL Editor 为员工设置角色，例如：
   `update public.users set role = 'ceo', department = 'Executive' where email = '你的CEO邮箱';`
5. 在 Vercel Project Settings → Environment Variables 添加以下三个变量，并应用到
   Production、Preview、Development：
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SECRET_KEY`
6. 重新部署 Vercel。不要把 Secret Key 复制到聊天、浏览器代码或 GitHub。

代码也兼容旧名称 `SUPABASE_ANON_KEY` 和 `SUPABASE_SERVICE_ROLE_KEY`，但新项目优先
使用 publishable/secret keys。

连接成功后，OS 登录优先使用 Supabase Auth；原 `CHEERFUL_GPT_ACCESS_KEYS` 暂时保留为
迁移期回退。歌曲库和 Royalty Matrix 会经由 Vercel 服务器分批同步到 Supabase，平台
导入批次也会保存到数据库。Cheerful GPT 的内部数据不再信任浏览器上传的上下文，而是
由服务器按当前角色从 Supabase 加载：

- `ceo`：全部内部数据。
- `finance`：歌曲目录、分成规则、平台导入与金额。
- `ar`：歌曲和录音版本，不含财务金额。
- `hr`：员工与招聘数据。
- `legal`：合同与法务数据。
- 其他角色：仅普通对话和公开网络搜索。

全部员工确认可用 Supabase 账号登录后，应从 Vercel 删除
`CHEERFUL_GPT_ACCESS_KEYS`，结束旧密码回退并只保留 Supabase Auth。

如果暂未配置 Supabase，现有前端原型仍可运行，数据暂留当前浏览器；审计事件写入
Vercel Functions 日志。
