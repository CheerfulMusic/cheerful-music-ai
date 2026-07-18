# cheerful-music-ai
AI music content system

## Cheerful GPT（服务器安全配置）

`OPENAI_API_KEY` 只允许配置在 Vercel 的服务器环境变量中，禁止写入
`index.html`、浏览器 JavaScript 或 GitHub 文件。

需要在 Vercel Project Settings → Environment Variables 配置：

- `OPENAI_API_KEY`：OpenAI API Key。
- `OPENAI_MODEL`：可选，默认 `gpt-5.6-luna`。
- `CHEERFUL_GPT_SESSION_SECRET`：至少 32 位随机字符串，用于签发 HttpOnly 会话。
- `CHEERFUL_GPT_ACCESS_KEYS`：访问码与角色的 JSON 映射，例如
  `{"一个仅保存在Vercel的随机访问码":{"id":"snow","name":"Snow","role":"ceo"}}`。

角色权限：

- `finance`、`ceo`：可以查询歌曲目录、Royalty Matrix、分成比例、平台收入、结算与金额。
- `member`：可以查询歌曲目录，但服务器会移除版税规则、分成比例和金额。
- `admin`：可以管理和查看审计日志，但默认不能读取财务金额。
- `viewer`：只能普通对话，不能读取内部业务数据或上传文件。

可选配置 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 后，聊天记录与审计日志会
写入 Supabase。建表脚本位于 `supabase/cheerful-gpt.sql`。未配置 Supabase 时，聊天记录
保存在当前浏览器，审计事件仍写入 Vercel Functions 日志。
