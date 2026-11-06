# Zotero ↔ DeepSeek Harness Bridge

把本地 [Zotero](https://www.zotero.org/) 文献库无缝接入 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的双向桥接插件。

## 功能

- **DSH → Zotero**：Agent 通过工具直接检索文献，读取元数据、笔记、PDF 批注与全文。
- **Zotero → DSH**：在 Zotero 内一键把选中文献发给 DSH 解读；导入新文献时自动生成初步阅读笔记。
- **笔记回写**：DSH 的解读会自动回写成文献的「阅读笔记」子笔记（与 PDF 关联存储），只记录重要结论而非全量对话。
- **会话隔离**：每篇文献对应一个独立对话窗口；DSH Web UI 只打开一次，之后复用。
- **命令行**：提供 `zotero-dsh` 终端聊天工具。

## 目录结构

```
zotero-dsh-bridge/
├── dsh-plugin/              DSH 侧插件（Host 插件，安装进 DSH profile）
│   ├── package.json
│   ├── cordis.patch.yml
│   ├── index.js             工具注册 + HTTP 桥接端点
│   ├── zotero.js            Zotero SQLite 只读访问层
│   ├── zotero-dsh.mjs       命令行聊天客户端
│   ├── locale/              多语言元数据
│   └── icon.svg
├── zotero-plugin/           Zotero 侧插件（打包为 .xpi，安装进 Zotero）
│   ├── manifest.json
│   ├── bootstrap.js         工具栏按钮、笔记写回、导入监听
│   └── icons/               DeepSeek Harness 图标
└── build/                   构建脚本
```

## 安装

### 前置条件

- **DSH**：已安装并登录，能正常运行。
- **Zotero**：7.0 或更高版本（针对 Zotero 10 适配）。
- **Python 3**：DSH 侧依赖（含标准库 `sqlite3`）。
- **可选**：`poppler`（提供 `pdftotext`，用于 PDF 全文提取）。

### 1. 安装 DSH 侧插件

在 DSH 中用 `plugin_manager` 安装 `dsh-plugin/` 目录：

```
plugin_manager install_bundle <绝对路径>/zotero-dsh-bridge/dsh-plugin
```

安装后重启 DSH。DSH 会暴露 6 个工具：`zotero_search`、`zotero_get_item`、`zotero_get_note`、`zotero_get_selected`、`zotero_get_pdf_text`、`zotero_bridge_status`。

### 2. 安装 Zotero 侧插件

```bash
bash build/build-zotero-xpi.sh
```

或手动打包：

```bash
cd zotero-plugin && zip -X ../zotero-dsh-bridge.xpi manifest.json bootstrap.js icons/*
```

然后在 Zotero 中：**工具 → 插件 → ⚙️ → Install Add-on From File…** 选择生成的 `.xpi`，重启 Zotero。

### 3. 命令行（可选）

```bash
ln -s <仓库路径>/dsh-plugin/zotero-dsh.mjs /usr/local/bin/zotero-dsh
```

## 使用

### Zotero 图形界面

- **解读文献**：选中文献 → 点工具栏 DeepSeek Harness 鲸鱼图标（或按 F12）→ DSH 生成解读并回写「阅读笔记」。
- **自动笔记**：导入新文献时，插件自动为其生成初步阅读笔记。

### 命令行

```bash
zotero-dsh "帮我总结 Zotero 中关于情绪计算的文献"   # 单次提问
zotero-dsh                                          # 连续聊天（/open 打开 DSH，/exit 退出）
zotero-dsh --open                                   # 只打开 DSH 页面
```

### DSH 对话

在 DSH 中直接说：

- 「找 Zotero 里关于 X 的文献」
- 「读一下这篇的笔记」
- 「我现在 Zotero 里选中了什么」

## 配置

DSH 侧插件支持以下配置（通过 DSH 的 Config 或 `cordis.patch.yml` 传入）：

| 字段 | 说明 | 默认值 |
|---|---|---|
| `dataDir` | Zotero 数据目录 | `~/Zotero` |
| `connectorUrl` | Zotero connector 地址 | `http://127.0.0.1:23119` |
| `pdftotextPath` | pdftotext 可执行文件路径 | 空（禁用 PDF 全文） |
| `sessionTitlePrefix` | 桥接会话标题前缀 | `Zotero` |

## 工作原理

1. **只读访问**：DSH 侧通过只读连接 Zotero 的 `zotero.sqlite`（WAL 模式，安全不锁库），查询文献、笔记、批注、附件。
2. **端点发现**：DSH 侧每次启动把当前端点写入 `~/.dsh/zotero-bridge.json`；Zotero 侧插件读取该文件，无需硬编码端口。
3. **消息投递**：走 DSH 官方 `sessionController` 链路，保证会话日志合法、可重放。
4. **笔记写回**：Zotero 侧插件调用 `Zotero.Item` API 创建/更新子笔记，与文献和 PDF 关联存储。

## 许可

[MIT](LICENSE)

## 发布前自定义

上传 GitHub 前，请替换以下占位符为你的实际信息：

1. `zotero-plugin/manifest.json`：
   - `homepage_url` 和 `applications.zotero.update_url` 中的 `your-username` → 你的 GitHub 用户名。
   - 如需自动更新，提供真实可访问的 `update.json`（JSON 格式见 [Mozilla 文档](https://extensionworkshop.com/documentation/manage/updating-your-extension/)）。
2. `LICENSE` 中的版权信息按需修改。

> 注意：`applications.zotero.id` 是插件唯一标识。修改它会导致 Zotero 把它识别为一个新插件（旧版本不会被覆盖）。请在上线前确定好 id，之后保持不变。

