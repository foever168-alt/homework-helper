# 作业收件小帮手

这是一个可部署到 GitHub Pages 的手机优先三阶段网页：小老师在同一个区块内点麦克风、语音或点选座号、返回上一笔并结束登记，接着在结果页确认缺交名单，最后从汇出页查看纪录与同步状态。座号会依画面宽度自动调整栏数，避免在语音工具列与座号区之间来回卷动。26 号固定标示为休学；说出「刚刚念错了」或按返回图示可撤销尚未送出的上一轮操作。

每笔纪录只用收作业同学的座号 `collectorSeat` 识别收件者，不收集、保存或传送收作业同学姓名。作业名称上限为 6 个字，可手动输入或用同一个麦克风说「作业名称 数学习作」。

## GitHub Pages

整个资料夹可直接上传到 GitHub 仓库。仓库内已附 GitHub Actions：在仓库的 **Settings → Pages → Build and deployment** 选择 **GitHub Actions**，之后每次推送到 `main` 都会自动发布 `dist`。网页不含学生姓名或成绩资料。

## Google Sheets 后台

1. 在 Google Drive 确认或建立「成绩」资料夹，复制资料夹网址中 `/folders/` 后面的 ID。
2. 新建 Google Apps Script 专案，把 `gas/Code.gs` 贴进去。
3. 在 Apps Script 的 **专案设定 → 指令码属性** 新增 `FOLDER_ID`，值为「成绩」资料夹网址中 `/folders/` 后面的 ID。
4. 在同一处新增 `ROSTER_SPREADSHEET_ID`，值为学生名单 Google Sheet 的文件 ID；再新增 `ROSTER_SHEET_NAME`，值为 `原班名單`。
5. 部署为 Web App：执行身分选「我」，存取权限设为可让公开网页直接呼叫的「所有人」。
6. 把部署后的 `/exec` URL 写入 `dist/index.html` 的 `GAS_WEB_APP_URL` 常数，然后重新发布 GitHub Pages。学生装置不需要另行设定或登入。

第一次按「汇出并送出」时，Apps Script 会在「成绩」资料夹自动建立一份固定的 `收作业小老师收作业`，并把档案 ID 存入指令码属性 `DATA_SPREADSHEET_ID`。之后每次登记都写进同一个 Google Sheets：`总览` 会新增一笔索引，有登记的日期才会自动建立 `yyyy-MM-dd` 分页；同一天的多份作业放在同一分页，并依作业名称分成不同区块。每个区块包含收作业座号、开始与完成时间，以及 1–33 号的姓名和缴交状态。学生姓名只会由 Apps Script 在执行时从私人名单读取，不会写入公开网页源码。

## 隐私说明

不要把成绩资料夹 ID、名册试算表 ID、学生名单或登记资料提交到公开 GitHub 仓库。Web App URL 会随网页公开；这个部署模式没有访问码，任何取得端点的人都可能送出资料，因此后端会严格验证座号集合、作业名称与时间格式。学生姓名只保留在私人 Google Sheets 中，网页只在当前浏览器保存最近登记纪录作为失败时的本机备援。
