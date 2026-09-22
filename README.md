# 车辆保养助手（vehicle-care）

一个跑在 **Cloudflare Workers** 上的多用户车辆保养记录与到期提醒系统。

拍一张维修/保养单据的截图上传，AI 自动识别店铺、金额、项目和里程，写进账本，
并按内置保养周期表生成下一次保养计划；到期时通过 **Bark** 推送到手机。

- 在线地址：<https://by.813146.xyz>
- 多用户隔离：所有业务表都带 `user_id`，互相看不到对方数据

---

## 功能特性

### 1. 截图识别记账
- 上传维修单 / 保养单 / 加油小票截图，AI 识别后进入「待确认」页，**人工确认后才入库**
- 识别结果可逐项编辑（项目名、规格、数量、单价、金额、质保期）
- 支持 Workers AI（默认，零成本）与外部 OpenAI 兼容多模态 API **双通道切换**

### 2. 三类账目
| 类型 | 说明 |
| --- | --- |
| 保养 | 维修保养单据，识别明细行并生成保养计划 |
| 加油 | 金额 + 油价 → 自动算升数，按车辆百公里油耗预估可跑里程 |
| 杂项 | 洗车、打蜡、保险、年检、停车费、过路费、违章罚款等 |

账本默认展示**全部历史**，每页 5 条，带「共 X 条 · 第 Y/Z 页」翻页；
可按类型（全部 / 加油 / 保养 / 杂项）和月份筛选，月份默认「全部」。

### 3. 保养计划与到期提醒
- 内置 **24 项通用保养周期表**（机油 6 个月/5000km、空滤 12 个月/10000km……），
  可按项目单独覆盖周期
- 单据带质保期的，以质保期为准覆盖通用周期
- 计划支持「暂停 / 重新启用」，暂停项不计入提醒
- 每天 **北京时间 09:00**（cron `0 1 * * *` UTC）扫描一次，提前 N 天 / N 公里推送
- 推送走 **Bark**，可在设置里填自己的 Key 和自架服务器；`push_log` 做去重，同一到期不会重复推

### 4. 看板
- 4 个 KPI：今年花费、累计记录、累计加油（含总升数）、累计杂项
- 月度花费趋势柱状图
- 最紧急的保养计划卡片

### 5. 数据与账号
- **备份 / 迁移**：`GET /api/export` 导出全量 JSON（剔除原始图片），
  `POST /api/import` 完整恢复，另有账单 CSV 导出（带 BOM，Excel 不乱码）
- **个人账号管理**（设置页）：修改密码、退出登录
- **管理台**（仅管理员可见）：用户列表 / 封禁 / 改资料 / 删数据、注册开关、
  项目周期表维护、公告发布、关于卡片外链配置

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 运行时 | Cloudflare Workers（`compatibility_date = 2026-09-01`） |
| 数据库 | Cloudflare D1（SQLite） |
| 静态资源 | Workers Assets（`./public`，历史路由回退到 `index.html`） |
| AI | Workers AI `@cf/meta/llama-4-scout-17b-16e-instruct`，或外部 OpenAI 兼容接口 |
| 前端 | 原生 JS 单页应用，**无框架、无构建步骤** |
| 定时 | Workers Cron Triggers |
| 推送 | Bark |

前端只有三个文件：`public/index.html` / `public/app.js` / `public/style.css`。
响应式只有 **768px** 一个断点：手机端单列 + 底部导航，电脑端左侧栏 + 内容居中。

---

## 目录结构

```
vehicle-care/
├── src/
│   ├── index.js      # Worker 入口：API 路由 + 静态资源 + 定时扫描
│   ├── api.js        # 全部 REST 路由与业务逻辑
│   ├── auth.js       # 会话、登录态、封禁判断
│   ├── crypto.js     # PBKDF2/SHA-256 派生、sealed verifier、加解密
│   ├── ai.js         # AI 双通道调用与响应解析
│   ├── plans.js      # 计划生成、到期评估、Bark 推送、扫描
│   └── catalog.js    # 内置保养周期表与关键词归类
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── tools/
│   └── check-sql-bindings.py  # D1 语句静态体检
├── schema.sql        # D1 建表 + 内置周期表种子数据
├── wrangler.toml
└── package.json
```

---

## 部署步骤

### 前置条件
- 一个 Cloudflare 账号，已安装 Node 18+
- `npm i -g wrangler`，然后 `wrangler login`

### 1. 创建 D1 数据库并初始化

```bash
wrangler d1 create vehicle-care-db
# 把输出的 database_id 填进 wrangler.toml 的 [[d1_databases]]
wrangler d1 execute vehicle-care-db --remote --file=schema.sql
```

### 2. 配置密钥

项目只需要一个密钥变量 `APP_SECRET`，用于口令派生加密与 AI Key 加密：

```bash
openssl rand -hex 32            # 生成后写进 .dev.vars
wrangler secret put APP_SECRET   # 生产环境用 secret，不要写进 wrangler.toml
```

`.dev.vars` 已被 `.gitignore` 排除。**`APP_SECRET` 一旦上线就不能改**，改了所有登录态失效。

### 3. 自定义域名（可选）

`wrangler.toml` 里配：

```toml
[[routes]]
pattern = "你的域名"
custom_domain = true
```

`wrangler deploy` 时 Cloudflare 会自动建 DNS 记录并签发证书，无需手动加 CNAME。

### 4. 部署

```bash
npm run deploy     # = wrangler deploy
```

首次注册的第一个账号会自动成为管理员。

---

## 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `APP_SECRET` | 是 | 口令派生 pepper 与 AI Key 加密密钥，32 字节 hex |

其余能力（D1、Workers AI、Assets）都通过 `wrangler.toml` 的绑定提供，不需要额外变量。
Bark Key、AI API Key 都存在数据库里（AI Key 加密存储），不在环境变量中。

---

## API 概览

首屏只打一个聚合接口 `GET /api/bootstrap`，一次返回看板所需的全部数据，减少往返。

| 分组 | 接口 |
| --- | --- |
| 认证 | `POST /api/auth/salt`、`/api/auth/register`、`/api/auth/login`、`/api/auth/logout`、`POST /api/account/password` |
| 聚合 | `GET /api/bootstrap`、`GET /api/meta`、`GET /api/me`、`GET /api/catalog` |
| 车辆 | `GET/POST /api/vehicles`、`PATCH/DELETE /api/vehicles/:id` |
| 记录 | `GET/POST /api/records`、`PATCH/DELETE /api/records/:id`、`GET /api/export/records.csv` |
| 上传 | `POST /api/uploads`、待确认项确认 / 删除 |
| 计划 | `GET /api/plans`、`PATCH /api/plans/:id`、`DELETE /api/plans/:id` |
| 设置 | `GET/PUT /api/settings`、`POST /api/push/test`、`POST /api/push/scan` |
| 备份 | `GET /api/export`、`POST /api/import` |
| 公告 | `GET /api/announcements`、`POST /api/announcements/read` |
| 管理台 | `/api/admin/overview`、`/api/admin/users/:id`、`/api/admin/registration`、`/api/admin/about`、`/api/admin/announcements`、`/api/admin/catalog` |

`/api/records` 支持 `vehicle_id`、`month`、`type`、`page`、`page_size` 参数；
不带 `page` 时保持旧的全量行为（看板兼容）。

---

## 安全设计

- **口令不落服务端明文**：浏览器用 PBKDF2-SHA256（210000 次）派生 verifier，
  服务端只做一次 SHA-256 封存后比对。Workers 免费版 CPU 上限 10ms，
  所以派生必须放客户端
- **salt 由服务端确定性派生**，前端不需要传 salt，同时也免疫邮箱枚举
- **改密码会踢掉其它会话**
- 封禁用户立即失效：登录被拒 + 已有会话作废
- 导出数据**剔除原始图片**；AI API Key 密文不参与迁移
- `.dev.vars`、`.wrangler/` 均在 `.gitignore` 中

> 本文档不涉及任何密钥、口令、Token 的实际值。部署时请自行生成。

---

## 常见问题

**改了前端但线上没变化？**
`public/index.html` 里静态资源带 `?v=<版本戳>`，改完前端记得 bump 这个戳；
Worker 对 html/js/css 也强制 `no-cache`，正常不会命中旧缓存。

**AI 识别不准？**
默认是 Workers AI 免费通道。设置页可切到外部 OpenAI 兼容的多模态模型，
填 Base URL + 模型名 + API Key（加密存储）。

**推送收不到？**
设置页有「测试推送」按钮，先确认 Bark Key 与服务器地址（默认 `https://api.day.app`）正确；
再确认 `notify_enabled` 打开、计划不是 `paused` 状态。

---

## License

MIT
