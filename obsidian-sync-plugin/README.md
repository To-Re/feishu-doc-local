# 本地飞书文档 · Obsidian 飞书同步扩展

为[基础插件](../obsidian-plugin/README.md)增加飞书导入、关联、正文和评论同步。通过 Obsidian 桌面版自带的运行时调用用户配置的官方 `lark-cli`，不需要启动网页服务。

## 安装与设置

需要桌面 Obsidian **1.8.0+**、已启用的基础插件和自行安装的[官方 lark CLI](https://github.com/larksuite/cli)。

1. 从[发布页](https://github.com/To-Re/feishu-doc-local/releases)下载同版本的同步扩展，将 `feishu-doc-local-sync/` 放入库的 `.obsidian/plugins/` 并启用。
2. 按官方说明配置 CLI 应用、身份和权限。使用用户身份时，在终端运行 `lark-cli auth login` 并完成授权；机器人身份使用应用配置。
3. 在命令面板选择“配置官方 CLI 与项目路径”，填写 CLI **绝对路径**及固定参数，例如 `["--as", "bot"]`。
4. 如需与本地服务共用项目列表，选择同一 `projects.json`；默认位置为 `~/.lark-review/projects.json`。

macOS 从 Dock 启动时可能找不到终端的 `PATH`。npm 版 CLI 可同时填写 Node 的绝对路径；用 `command -v lark-cli` 和 `command -v node` 查询。此时 CLI 路径应指向 JavaScript 启动文件或其链接，不能填 shell 脚本。原生 CLI 的 Node 字段留空。

扩展不自带 CLI，不自动登录，也不保存访问令牌。配置保存不会执行命令；npm 版 CLI 自身仍需要系统 Node。文档访问权和 API 权限应按实际操作配置，不能仅凭页面可编辑就认为接口可写。

## 使用

| 入口 | 作用 |
| --- | --- |
| 从飞书导入 | 预览后保存为库内新 XML，下载支持的资源；不覆盖已有文件。 |
| 关联飞书 | 将当前本地稿关联已有目标，或明确新建飞书文档。 |
| 预览同步 | 选择“飞书 → 本地”或“本地 → 飞书”，核对差异后在顶部确认拉取或推送。 |
| 同步评论 | 交换新增评论、回复及解决状态，独立于正文同步。 |
| 关联设置 | 查看关联信息，进入“恢复上一快照”。 |

文档切换使用 Obsidian 文件列表。正文同步前先保存并锁定相应编辑视图；未完成草稿应先处理。切换方向、文件变化或预览过期后需重新预览。

拉取前备份本地正文和评论；推送或新建成功后完整回读并更新本地，旧稿和回执存档。恢复上一快照也先预览，并为当前版本另存备份，只改变本地。快照不复制全部素材，引用资源需要保留原位。详细行为见[项目与同步](../docs/projects-and-sync.md)。

## 限制与异常

- 本地白板组件评论同步到飞书时按整图定位；已发送评论的正文改写不会自动覆盖云线程。
- 结果不确定或资源下载失败时保留 `pending` 和回执。先核对飞书实际内容，不要删除记录或反复重发。
- 插件内真实发布、评论云端同步及完整双向往返仍未完成全部实测；先使用副本验收。已确认的 CLI 内容丢失与格式变化见[兼容性说明](../docs/style-coverage.md)。
- 不支持移动端或独立弹出窗口。不提供插件内登录按钮、内置凭据管理或跨电脑文件同步。

## 构建

在仓库根目录执行：

```sh
npm ci
npm ci --prefix obsidian-sync-plugin
npm run typecheck --prefix obsidian-sync-plugin
npm test --prefix obsidian-sync-plugin
npm run build --prefix obsidian-sync-plugin
```

输出为 `obsidian-sync-plugin/dist/`。保留 `LICENSE`、`THIRD_PARTY_NOTICES.md` 和 `licenses/`；构建需要 Node，用户无需安装这些开发依赖。
