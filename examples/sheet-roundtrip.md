# 电子表格单元格往返样例

这些 JSON 是公开测试输入和本地预期，没有真实工作簿、子表 token 或云端回执。`sheet-cells.json` 是官方 `sheets +cells-set --cells` 的二维对象矩阵；`sheet-expectations.json` 仅是测试说明，不作为官方请求上传。

样稿使用 6 行 5 列，包含中文、数字、布尔值、乘法与 `SUM` 公式、单格字体和背景色、粗体、数字格式。`C6` 和 `E6` 的 `{}` 表示保留原值，不能理解为清空。首轮应选择已获授权且回读确认为空的 `A1:E6`；没有合并、行列增删或大小调整操作。

DocxXML 的 `<sheet type="blank"/>` 只创建嵌入表格容器，之后完整 fetch 才能取得其真实 `token` 和 `sheet-id`。单元格走独立 Sheets 协议，不把矩阵塞进 XML 子节点，也不编造测试 token。

从命令所在工作目录指向这些文件；以下环境变量必须来自这份已授权测试稿的真实回读：

```sh
# 以下使用官方 lark-cli，并显式选择 bot 身份。
lark-cli --as bot sheets +sheet-info \
  --spreadsheet-token "$SPREADSHEET_TOKEN" --sheet-id "$SHEET_ID" \
  --range A1:E6 --include merges,row_heights,col_widths,hidden_rows,hidden_cols,frozen

# 完整写入前先做无网络 dry-run，并保存此次的输入文件。
lark-cli --as bot --dry-run sheets +cells-set \
  --spreadsheet-token "$SPREADSHEET_TOKEN" --sheet-id "$SHEET_ID" \
  --range A1:E6 --cells @./sheet-cells.json

# 仅在范围已确认、应用权限已开通时执行一次写入。
lark-cli --as bot sheets +cells-set \
  --spreadsheet-token "$SPREADSHEET_TOKEN" --sheet-id "$SHEET_ID" \
  --range A1:E6 --cells @./sheet-cells.json --allow-overwrite=false

# 分别保存原始值/样式响应和公式/样式响应。
lark-cli --as bot sheets +cells-get \
  --spreadsheet-token "$SPREADSHEET_TOKEN" --sheet-id "$SHEET_ID" \
  --range A1:E6 --include value,style --max-chars 25000
lark-cli --as bot sheets +cells-get \
  --spreadsheet-token "$SPREADSHEET_TOKEN" --sheet-id "$SHEET_ID" \
  --range A1:E6 --include formula,style --max-chars 25000

# 精确修改 B3，回读确认后，再精确恢复 B3；每一步独立保存回执。
lark-cli --as bot sheets +cells-set \
  --spreadsheet-token "$SPREADSHEET_TOKEN" --sheet-id "$SHEET_ID" \
  --range B3 --cells @./sheet-edit.json
lark-cli --as bot sheets +cells-set \
  --spreadsheet-token "$SPREADSHEET_TOKEN" --sheet-id "$SHEET_ID" \
  --range B3 --cells @./sheet-restore.json
```

预期 `D6` 为 90，修改 `B3` 为 5 后变为 106，恢复为 3 后回到 90。公式、其他格值与样式应保持；公式计算结果是否及时更新必须依据实际回读。检查 `has_more`、`truncated`、`actual_range`，使用 `row_indices`、`col_indices` 定位。旁置 JSON 保存官方响应原文；本地预期数值不冒充飞书计算结果。浏览器展示需与相同版本的官方响应核对，读取或写入命令成功不等于完成视觉验收。

当前应用的测试读取返回 `99991672 app_scope_not_applied`，缺少 `sheets:spreadsheet:read`。写入需要 `sheets:spreadsheet:write_only`。这属于应用 API scope，不是文档协作者权限；在权限变更获准并生效前不进行云端写入。输入校验、dry-run 与 mock 测试可以离线完成。

字段依据：[官方单元格 schema](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/shortcuts/sheets/data/flag-schemas.json)、[Sheets 读取](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/shortcuts/sheets/lark_sheet_read_data.go)、[布局](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/shortcuts/sheets/lark_sheet_sheet_structure.go)。
