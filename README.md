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

可选配置 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 后，聊天记录与审计日志会
写入 Supabase。建表脚本位于 `supabase/cheerful-gpt.sql`。未配置 Supabase 时，聊天记录
保存在当前浏览器，审计事件仍写入 Vercel Functions 日志。
