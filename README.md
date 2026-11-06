<div align="center">

# 🐳 Zotero ↔ DeepSeek Harness Bridge

**把本地 Zotero 文献库无缝接入 DeepSeek Harness（DSH）的双向桥接插件**

在 Zotero 里选中一篇文献，一键让 DSH 的 AI 生成解读并写回「阅读笔记」；在 DSH 里直接检索文献、读取笔记、提取 PDF 全文。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Zotero](https://img.shields.io/badge/Zotero-7%2B-red)](https://www.zotero.org/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-compatible-4D6BFE)](https://github.com/deepseek-ai)

</div>

---

## 目录

- [功能特性](#功能特性)
- [架构与数据流](#架构与数据流)
- [目录结构](#目录结构)
- [安装](#安装)
  - [前置条件](#前置条件)
  - [DSH 侧插件](#1-安装-dsh-侧插件)
  - [Zotero 侧插件](#2-安装-zotero-侧插件)
  - [命令行工具（可选）](#3-命令行工具可选)
- [使用指南](#使用指南)
- [配置](#配置)
- [HTTP 桥接 API](#http-桥接-api)
- [故障排查](#故障排查)
- [常见问题 FAQ](#常见问题-faq)
- [开发与贡献](#开发与贡献)
- [发布前自定义](#发布前自定义)
- [许可](#许可)

---

## 功能特性

### 🔄 双向桥接

| 方向 | 能力 |
|---|---|
| **DSH → Zotero** | Agent 通过 6 个工具检索文献、读取元数据/笔记/批注/PDF 全文 |
| **Zotero → DSH** | 选中文献一键发送给 DSH 解读；导入新文献自动生成阅读笔记 |

### 📝 智能阅读笔记

- **自动生成**：导入新文献时，插件自动调用 DSH 生成初步阅读笔记。
- **实时更新**：每次与 DSH 交互后，重要结论会自动追加到阅读笔记。
- **精炼内容**：只记录要点，不记录全量对话记录。
- **规范格式**：标注入库时间，使用客观学术语言，无「AI 生成」等字样。

### 🗂 会话隔离

- 每篇文献对应一个**独立对话窗口**，同一篇文献复用同一会话。
- 所有桥接会话统一归入 `zotero-dsh-bridge` 工作区。
- DSH Web UI 只打开一次，之后复用已开窗口。

### ⌨️ 命令行

提供 `zotero-dsh` 终端工具，支持单次提问、连续聊天、打开 DSH。

---

## 架构与数据流

```
┌─────────────┐         HTTP (127.0.0.1)        ┌──────────────────┐
│             │  ── POST /zotero-bridge/chat ─▶ │                  │
│   Zotero    │  ◀── GET  /zotero-bridge/status │  DeepSeek        │
│  (插件)     │                                  │  Harness         │
│             │  ◀── 读取 zotero.sqlite ──────── │  (dsh-plugin)    │
│             │                                  │                  │
│  文献库     │  ── 写回「阅读笔记」子笔记 ──▶    │  6 个 zotero_*   │
│  笔记/PDF   │                                  │  工具            │
└─────────────┘                                  └──────────────────┘
      │                                                   │
      │  ~/.dsh/zotero-bridge.json（端点自动发现）          │  ~/.dsh/zotero-dsh-bridge（工作区）
      └───────────────────────────────────────────────────┘
```

**关键机制**：

1. **只读访问**：DSH 侧通过只读连接 Zotero 的 `zotero.sqlite`（WAL 模式，安全不锁库）。
2. **端点发现**：DSH 每次启动把当前端点写入 `~/.dsh/zotero-bridge.json`，Zotero 侧无需硬编码端口。
3. **消息投递**：走 DSH 官方 `sessionController` 链路，保证会话日志合法、可重放。
4. **笔记写回**：Zotero 侧调用 `Zotero.Item` API 创建/更新子笔记。

---

## 目录结构

```
zotero-dsh-bridge/
├── dsh-plugin/              # DSH 侧插件（Host 插件）
│   ├── package.json
│   ├── cordis.patch.yml     # Loader patch
│   ├── index.js             # 工具注册 + HTTP 桥接端点
│   ├── zotero.js            # Zotero SQLite 只读访问层
│   ├── zotero-dsh.mjs       # 命令行客户端
│   ├── locale/              # 多语言元数据（en/zh）
│   └── icon.svg
├── zotero-plugin/           # Zotero 侧插件（打包为 .xpi）
│   ├── manifest.json
│   ├── bootstrap.js         # 工具栏按钮、笔记写回、导入监听
│   └── icons/               # DeepSeek Harness 图标
├── build/                   # 构建脚本
│   └── build-zotero-xpi.sh
├── LICENSE
├── README.md
└── .gitignore
```

---

## 安装

### 前置条件

| 依赖 | 说明 | 必需 |
|---|---|---|
| **DeepSeek Harness** | 已安装并登录 | ✅ |
| **Zotero** | 7.0+（针对 Zotero 10 适配） | ✅ |
| **Python 3** | 含标准库 `sqlite3` | ✅ |
| **poppler**（`pdftotext`） | PDF 全文提取 | ⚠️ 可选 |

### 1. 安装 DSH 侧插件

在 DSH 中用 `plugin_manager` 工具安装 `dsh-plugin/` 目录：

```
plugin_manager install_bundle <仓库绝对路径>/dsh-plugin
```

> 或在 DSH 中让 Agent 执行：「安装这个插件 `<仓库绝对路径>/dsh-plugin`」。

安装后**重启 DSH**，会暴露以下 6 个工具：

| 工具 | 说明 |
|---|---|
| `zotero_search` | 按标题/作者/标签检索文献 |
| `zotero_get_item` | 读取文献完整元数据、笔记、批注、附件 |
| `zotero_get_note` | 读取单条笔记全文 |
| `zotero_get_selected` | 读取 Zotero 当前选中条目 |
| `zotero_get_pdf_text` | 提取 PDF 全文（需 pdftotext） |
| `zotero_bridge_status` | 查看桥接状态 |

### 2. 安装 Zotero 侧插件

**构建 .xpi**：

```bash
bash build/build-zotero-xpi.sh
```

或手动打包：

```bash
cd zotero-plugin && zip -X ../zotero-dsh-bridge.xpi manifest.json bootstrap.js icons/*
```

**安装**：

1. Zotero → 工具 → 插件 → ⚙️ → **Install Add-on From File…**
2. 选择生成的 `zotero-dsh-bridge.xpi`
3. 重启 Zotero

### 3. 命令行工具（可选）

```bash
ln -s <仓库路径>/dsh-plugin/zotero-dsh.mjs /usr/local/bin/zotero-dsh
chmod +x /usr/local/bin/zotero-dsh
```

---

## 使用指南

### Zotero 图形界面

- **解读文献**：选中文献 → 点工具栏 🐳 鲸鱼图标（或按 `F12`）→ DSH 生成解读并自动回写「阅读笔记」。
- **自动笔记**：导入新文献时，插件自动为其生成初步阅读笔记（后台完成，无需手动操作）。

### 命令行

```bash
# 单次提问，等待回复
zotero-dsh "帮我总结 Zotero 中关于情绪计算的文献"

# 进入连续聊天（/open 打开 DSH，/exit 退出）
zotero-dsh

# 只打开 DSH 页面
zotero-dsh --open
```

### DSH 对话

在 DSH 中直接用自然语言：

- 「找 Zotero 里关于 **情绪计算** 的文献」
- 「读一下这篇的笔记」
- 「我现在 Zotero 里选中了什么」
- 「提取这篇 PDF 的全文」

---

## 配置

DSH 侧插件支持以下配置（通过 DSH 的 Config 或 `cordis.patch.yml` 传入）：

| 字段 | 说明 | 默认值 |
|---|---|---|
| `dataDir` | Zotero 数据目录 | `~/Zotero` |
| `connectorUrl` | Zotero connector 地址 | `http://127.0.0.1:23119` |
| `pdftotextPath` | pdftotext 可执行文件路径 | 空（禁用 PDF 全文） |
| `sessionTitlePrefix` | 桥接会话标题前缀 | `Zotero` |

示例 `cordis.patch.yml`：

```yaml
- insert:
    - id: zotero-bridge
      name: '@local/zotero-bridge'
      config:
        dataDir: '/Users/you/Zotero'
        pdftotextPath: '/opt/homebrew/bin/pdftotext'
```

---

## HTTP 桥接 API

DSH 侧暴露以下本地端点（端口每次启动变化，通过 `~/.dsh/zotero-bridge.json` 自动发现）：

| 端点 | 方法 | 说明 |
|---|---|---|
| `/zotero-bridge/health` | GET | 健康检查、会话数、openUrl |
| `/zotero-bridge/chat` | POST | 发送消息（body: `{itemKey, title, message}`） |
| `/zotero-bridge/status` | GET | 读取指定会话状态（`?itemKey=`） |

---

## 故障排查

### 1. 点击按钮无反应

- 查看日志：`~/.dsh/zotero-bridge-plugin.log`
- 确认 DSH 正在运行（插件会提示「找不到 DSH 端点」）

### 2. 消息发出但 DSH 无回复

- 确认 DSH 已重启（加载最新代码）
- 查看 DSH 的 `zotero-dsh-bridge` 工作区是否有新会话

### 3. `zotero_get_selected` 报错

- 需在 Zotero 7.1+ 开启：设置 → 高级 → **允许其他应用通信**

### 4. `zotero_get_pdf_text` 报错

- 安装 poppler：`brew install poppler`
- 在配置中设置 `pdftotextPath`

### 5. 历史加载失败 / 会话损坏

- 删除 `~/.dsh/sessions/--Users-*/zotero-bridge-*` 目录后重启 DSH

---

## 常见问题 FAQ

<details>
<summary><b>Q：为什么端口每次都不一样？</b></summary>
DSH 桌面版每次启动随机分配 Web 端口。插件通过 `~/.dsh/zotero-bridge.json` 自动发现，无需手动配置。
</details>

<details>
<summary><b>Q：阅读笔记会被覆盖吗？</b></summary>
不会。笔记按日期追加，且做了长度上限裁剪（超过约 2 万字符自动裁剪旧内容）。
</details>

<details>
<summary><b>Q：同一篇论文会创建多个会话吗？</b></summary>
不会。每篇文献（按 `itemKey`）只对应一个会话，重复点击复用同一会话。
</details>

<details>
<summary><b>Q：数据安全吗？</b></summary>
DSH 侧只读访问 Zotero 数据库（WAL 模式，不锁库、不写入）。唯一写入是 Zotero 侧插件主动创建/更新阅读笔记。
</details>

---

## 开发与贡献

欢迎提交 Issue 和 Pull Request。

### 本地开发

```bash
# 克隆仓库
git clone <你的仓库地址>
cd zotero-dsh-bridge

# 修改 DSH 侧插件后，重启 DSH 生效
# 修改 Zotero 侧插件后，重新打包并重装
bash build/build-zotero-xpi.sh
```

### 调试

- **Zotero 侧**：日志写入 `~/.dsh/zotero-bridge-plugin.log`；或用 `-ZoteroDebugText` 启动查看控制台。
- **DSH 侧**：`zotero_bridge_status` 工具可查看桥接状态。

---

## 发布前自定义

上传 GitHub 前，请替换以下占位符为你的实际信息：

1. `zotero-plugin/manifest.json`：
   - `homepage_url` 和 `applications.zotero.update_url` 中的 `your-username` → 你的 GitHub 用户名。
   - 如需自动更新，提供真实可访问的 `update.json`（见 [Mozilla 文档](https://extensionworkshop.com/documentation/manage/updating-your-extension/)）。
2. `LICENSE` 中的版权信息按需修改。

> ⚠️ `applications.zotero.id` 是插件唯一标识。修改它会导致 Zotero 把它识别为一个新插件（旧版本不会被覆盖）。请在上线前确定好 id，之后保持不变。

---

## 许可

[MIT](LICENSE) © 2026 zotero-dsh-bridge contributors
