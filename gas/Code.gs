const CONFIG = {
  SUSPENDED_SEAT: 26,
  TIME_ZONE: 'Asia/Taipei',
  MAX_LATE_DAYS: 3,
  ACTIVE_TOTAL: 32
};

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  if (params.action === 'status') {
    const callback = String(params.callback || 'callback');
    if (!/^[A-Za-z_$][0-9A-Za-z_$\.]{0,80}$/.test(callback)) {
      return jsonOutput_({ ok: false, error: 'callback 格式不正确' });
    }
    const id = String(params.id || '');
    const cached = id ? CacheService.getScriptCache().get(`sync:${id}`) : null;
    const value = cached ? JSON.parse(cached) : { pending: true };
    return ContentService.createTextOutput(`${callback}(${JSON.stringify(value)});`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return jsonOutput_({ ok: true, service: '作業收件小幫手', time: new Date().toISOString() });
}

function doPost(e) {
  let requestId = '';
  try {
    if (!e || !e.parameter) throw new Error('缺少请求参数');
    const payload = JSON.parse(e.parameter.payload || '{}');
    requestId = String(payload.id || '');
    validatePayload_(payload);
    const result = payload.type === 'late' ? saveLateSubmission_(payload) : saveAssignment_(payload);
    const response = {
      ok: true,
      type: payload.type || 'initial',
      spreadsheetId: result.id,
      spreadsheetUrl: result.url,
      detailSheetName: result.detailSheetName,
      message: result.message || '登记完成'
    };
    cacheResponse_(requestId, response);
    return jsonOutput_(response);
  } catch (error) {
    console.error(error);
    const response = { ok: false, error: String(error && error.message || error) };
    cacheResponse_(requestId, response);
    return jsonOutput_(response);
  }
}

function cacheResponse_(requestId, response) {
  if (/^[0-9A-Za-z_-]{8,80}$/.test(requestId)) {
    CacheService.getScriptCache().put(`sync:${requestId}`, JSON.stringify(response), 300);
  }
}

function saveAssignment_(data) {
  const properties = PropertiesService.getScriptProperties();
  const roster = loadRoster_(properties);
  const completedAt = new Date(data.completedAt);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('系统正在保存另一笔登记，请稍后再试');
  try {
    const spreadsheet = getOrCreateDataSpreadsheet_(properties);
    const indexSheet = ensureIndexSheet_(spreadsheet);
    const dailySheet = getOrCreateDailySheet_(spreadsheet, completedAt);
    const blockStartRow = writeDailyBlock_(dailySheet, data, roster, completedAt);
    appendIndexRow_(indexSheet, dailySheet, blockStartRow, data, completedAt);
    SpreadsheetApp.flush();
    return { id: spreadsheet.getId(), url: spreadsheet.getUrl(), detailSheetName: dailySheet.getName() };
  } finally {
    lock.releaseLock();
  }
}

function saveLateSubmission_(data) {
  const properties = PropertiesService.getScriptProperties();
  const receivedAt = new Date(data.completedAt);
  const lateDays = getLateDays_(data.originalDate, receivedAt);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('系统正在保存另一笔登记，请稍后再试');
  try {
    const spreadsheet = getOrCreateDataSpreadsheet_(properties);
    const indexSheet = ensureIndexSheet_(spreadsheet);
    const dailySheet = spreadsheet.getSheetByName(data.originalDate);
    if (!dailySheet) throw new Error(`找不到 ${data.originalDate} 的原始收件分页`);
    const startRow = findAssignmentBlock_(dailySheet, data.assignmentName);
    if (!startRow) throw new Error('在原收件日找不到这个作业名称');

    const tableHeaderRow = startRow + 7;
    dailySheet.getRange(tableHeaderRow, 1, 1, 5)
      .setValues([['座号', '姓名', '状态', '补交时间', '收作业人']])
      .setFontWeight('bold').setBackground('#B8DCEF');
    dailySheet.getRange(tableHeaderRow, 7, 1, 4)
      .setValues([['补交座号', '补交日数', '补交时间', '收作业人']])
      .setFontWeight('bold').setBackground('#F8DF93');

    const seats = data.lateSeats.slice().sort((a, b) => a - b);
    seats.forEach(seat => {
      const seatRow = startRow + 8 + seat - 1;
      if (Number(dailySheet.getRange(seatRow, 1).getValue()) !== seat) {
        throw new Error(`找不到 ${seat} 号的原始登记列`);
      }
      const currentStatus = String(dailySheet.getRange(seatRow, 3).getDisplayValue()).trim();
      if (currentStatus !== '缺交') throw new Error(`${seat} 号目前不是缺交状态，无法重复补登`);
      dailySheet.getRange(seatRow, 3, 1, 3).setValues([[
        `第${lateDays}日补交`,
        receivedAt,
        sheetText_(getCollector_(data))
      ]]);
      dailySheet.getRange(seatRow, 4).setNumberFormat('yyyy/mm/dd hh:mm');

      const logStart = startRow + 8;
      const logValues = dailySheet.getRange(logStart, 7, 33, 1).getDisplayValues();
      let logOffset = logValues.findIndex(row => !row[0]);
      if (logOffset < 0) logOffset = 32;
      dailySheet.getRange(logStart + logOffset, 7, 1, 4).setValues([[
        seat,
        `第${lateDays}日`,
        receivedAt,
        sheetText_(getCollector_(data))
      ]]);
      dailySheet.getRange(logStart + logOffset, 9).setNumberFormat('yyyy/mm/dd hh:mm');
    });

    const summary = refreshAssignmentSummary_(dailySheet, startRow);
    refreshIndexRow_(indexSheet, dailySheet, startRow, data.assignmentName, summary);
    ensureLateConditionalFormatting_(dailySheet, startRow);
    SpreadsheetApp.flush();
    return {
      id: spreadsheet.getId(),
      url: spreadsheet.getUrl(),
      detailSheetName: dailySheet.getName(),
      message: `${seats.join('、')}号已登记为第${lateDays}日补交`
    };
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateDataSpreadsheet_(properties) {
  const existingId = properties.getProperty('DATA_SPREADSHEET_ID');
  if (existingId) return SpreadsheetApp.openById(existingId);
  const folderId = properties.getProperty('FOLDER_ID');
  if (!folderId) throw new Error('尚未設定 FOLDER_ID');
  const spreadsheet = SpreadsheetApp.create('收作業小老師收作業');
  DriveApp.getFileById(spreadsheet.getId()).moveTo(DriveApp.getFolderById(folderId));
  properties.setProperty('DATA_SPREADSHEET_ID', spreadsheet.getId());
  return spreadsheet;
}

function ensureIndexSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName('總覽');
  if (!sheet) {
    const sheets = spreadsheet.getSheets();
    sheet = sheets.length === 1 && sheets[0].getLastRow() === 0 ? sheets[0] : spreadsheet.insertSheet();
    sheet.setName('總覽');
  }
  if (sheet.getRange('A1').getValue() !== '收作業小老師收作業') {
    sheet.clear();
    sheet.getRange('A1:H1').merge().setValue('收作業小老師收作業').setFontSize(20).setFontWeight('bold').setHorizontalAlignment('center').setBackground('#F7BFD5');
    sheet.setFrozenRows(4);
    sheet.setColumnWidths(1, 1, 145); sheet.setColumnWidths(2, 1, 220); sheet.setColumnWidths(3, 1, 160);
    sheet.setColumnWidths(4, 2, 90); sheet.setColumnWidths(6, 1, 240); sheet.setColumnWidths(7, 2, 135);
  }
  sheet.getRange('A2:H2').merge().setValue('有送出登记的日期会自动建立分页；同日多份作业依作业名称分区，补交会写回原日期的原作业区块。').setHorizontalAlignment('center').setBackground('#FFF0F5');
  sheet.getRange('A4:H4').setValues([['完成时间', '作业名称', '收作业人', '已交人数', '缺交人数', '缺交座号', '明细分页', '查看']]).setFontWeight('bold').setBackground('#B8DCEF');
  return sheet;
}

function getOrCreateDailySheet_(spreadsheet, completedAt) {
  const sheetName = Utilities.formatDate(completedAt, CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    sheet.setTabColor('#F7BFD5');
    sheet.setColumnWidth(1, 80); sheet.setColumnWidth(2, 160); sheet.setColumnWidth(3, 110);
    sheet.setColumnWidth(4, 145); sheet.setColumnWidth(5, 145); sheet.setColumnWidth(6, 24);
    sheet.setColumnWidth(7, 90); sheet.setColumnWidth(8, 95); sheet.setColumnWidth(9, 145); sheet.setColumnWidth(10, 145);
  }
  return sheet;
}

function writeDailyBlock_(sheet, data, roster, completedAt) {
  const submitted = new Set((data.submitted || []).map(Number));
  const rows = [];
  for (let seat = 1; seat <= 33; seat += 1) {
    rows.push([
      seat,
      roster.get(seat) || '',
      seat === CONFIG.SUSPENDED_SEAT ? '休学' : submitted.has(seat) ? '已交' : '缺交',
      '',
      ''
    ]);
  }
  const startRow = sheet.getLastRow() ? sheet.getLastRow() + 3 : 1;
  sheet.getRange(startRow, 1, 1, 6).merge().setValue(sheetText_(data.assignmentName)).setFontSize(18).setFontWeight('bold').setHorizontalAlignment('center').setBackground('#F7BFD5');
  sheet.getRange(startRow + 1, 1, 5, 2).setValues([
    ['作业名称', sheetText_(data.assignmentName)],
    ['收作业人', sheetText_(getCollector_(data))],
    ['开始时间', new Date(data.startedAt)],
    ['完成时间', completedAt],
    ['缺交座号', (data.missing || []).length ? `${data.missing.join('、')}号` : '全班皆已缴交']
  ]);
  sheet.getRange(startRow + 3, 2, 2, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  sheet.getRange(startRow + 7, 1, 1, 5).setValues([['座号', '姓名', '状态', '补交时间', '收作业人']]).setFontWeight('bold').setBackground('#B8DCEF');
  sheet.getRange(startRow + 7, 7, 1, 4).setValues([['补交座号', '补交日数', '补交时间', '收作业人']]).setFontWeight('bold').setBackground('#F8DF93');
  sheet.getRange(startRow + 8, 1, rows.length, 5).setValues(rows);
  sheet.getRange(startRow + 1, 1, 5, 1).setFontWeight('bold').setBackground('#FFF0F5');
  sheet.getRange(startRow + 8, 1, rows.length, 1).setHorizontalAlignment('center');
  sheet.getRange(startRow + 8, 3, rows.length, 1).setHorizontalAlignment('center');
  const statusRange = sheet.getRange(startRow + 8, 3, rows.length, 1);
  const existingRules = sheet.getConditionalFormatRules();
  sheet.setConditionalFormatRules(existingRules.concat([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('已交').setBackground('#BFE5D1').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('缺交').setBackground('#F7BFD5').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('休学').setBackground('#DDD9DF').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextContains('补交').setBackground('#F8DF93').setRanges([statusRange]).build()
  ]));
  sheet.getRange(startRow, 1, 41, 10).setVerticalAlignment('middle');
  return startRow;
}

function appendIndexRow_(indexSheet, dailySheet, blockStartRow, data, completedAt) {
  const row = Math.max(indexSheet.getLastRow() + 1, 5);
  indexSheet.getRange(row, 1, 1, 7).setValues([[
    completedAt,
    sheetText_(data.assignmentName),
    sheetText_(getCollector_(data)),
    data.submitted.length,
    data.missing.length,
    data.missing.length ? `${data.missing.join('、')}号` : '无',
    dailySheet.getName()
  ]]);
  indexSheet.getRange(row, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  indexSheet.getRange(row, 8).setFormula(`=HYPERLINK("#gid=${dailySheet.getSheetId()}&range=A${blockStartRow}","查看")`);
}

function findAssignmentBlock_(sheet, assignmentName) {
  const values = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 2).getDisplayValues();
  for (let i = 0; i < values.length - 1; i += 1) {
    if (String(values[i][0]).trim() === assignmentName && String(values[i + 1][0]).trim() === '作业名称' && String(values[i + 1][1]).trim() === assignmentName) {
      return i + 1;
    }
  }
  return 0;
}

function refreshAssignmentSummary_(sheet, startRow) {
  const statuses = sheet.getRange(startRow + 8, 3, 33, 1).getDisplayValues().map(row => String(row[0]).trim());
  const missing = [];
  let submittedCount = 0;
  statuses.forEach((status, index) => {
    const seat = index + 1;
    if (seat === CONFIG.SUSPENDED_SEAT) return;
    if (status === '缺交') missing.push(seat);
    else submittedCount += 1;
  });
  sheet.getRange(startRow + 5, 2).setValue(missing.length ? `${missing.join('、')}号` : '全班皆已缴交');
  return { submittedCount, missing };
}

function refreshIndexRow_(indexSheet, dailySheet, startRow, assignmentName, summary) {
  const lastRow = indexSheet.getLastRow();
  if (lastRow < 5) return;
  const values = indexSheet.getRange(5, 1, lastRow - 4, 8).getDisplayValues();
  const formulas = indexSheet.getRange(5, 8, lastRow - 4, 1).getFormulas();
  for (let i = 0; i < values.length; i += 1) {
    const sameAssignment = String(values[i][1]).trim() === assignmentName;
    const sameSheet = String(values[i][6]).trim() === dailySheet.getName();
    const sameBlock = String(formulas[i][0]).includes(`range=A${startRow}`);
    if (sameAssignment && sameSheet && sameBlock) {
      indexSheet.getRange(i + 5, 4, 1, 3).setValues([[
        summary.submittedCount,
        summary.missing.length,
        summary.missing.length ? `${summary.missing.join('、')}号` : '无'
      ]]);
      return;
    }
  }
}

function ensureLateConditionalFormatting_(sheet, startRow) {
  const range = sheet.getRange(startRow + 8, 3, 33, 1);
  const hasLateRule = sheet.getConditionalFormatRules().some(rule => {
    const condition = rule.getBooleanCondition();
    return condition && condition.getCriteriaType() === SpreadsheetApp.BooleanCriteria.TEXT_CONTAINS && String(condition.getCriteriaValues()[0]) === '补交';
  });
  if (!hasLateRule) {
    sheet.setConditionalFormatRules(sheet.getConditionalFormatRules().concat([
      SpreadsheetApp.newConditionalFormatRule().whenTextContains('补交').setBackground('#F8DF93').setRanges([range]).build()
    ]));
  }
}

function loadRoster_(properties) {
  const spreadsheetId = properties.getProperty('ROSTER_SPREADSHEET_ID');
  const sheetName = properties.getProperty('ROSTER_SHEET_NAME') || '原班名單';
  if (!spreadsheetId) throw new Error('尚未設定 ROSTER_SPREADSHEET_ID');
  const source = SpreadsheetApp.openById(spreadsheetId).getSheetByName(sheetName);
  if (!source) throw new Error(`找不到名單工作表：${sheetName}`);
  const lastRow = source.getLastRow();
  const values = lastRow >= 2 ? source.getRange(2, 1, lastRow - 1, 2).getDisplayValues() : [];
  const roster = new Map();
  values.forEach(row => {
    const seat = Number(row[0]);
    const name = String(row[1] || '').trim();
    if (Number.isInteger(seat) && seat >= 1 && seat <= 33 && name) roster.set(seat, name);
  });
  if (roster.size < 32) throw new Error('學生名單不足 32 人，請檢查座號與姓名欄');
  return roster;
}

function validatePayload_(data) {
  if (!data || typeof data !== 'object') throw new Error('缺少登记资料');
  if (!/^[0-9A-Za-z_-]{8,80}$/.test(String(data.id || ''))) throw new Error('记录编号格式不正确');
  const assignmentName = String(data.assignmentName || '').trim();
  if (!assignmentName) throw new Error('缺少作业名称');
  if ([...assignmentName].length > 12) throw new Error('作业名称最多 12 个字');
  const collector = getCollector_(data);
  if (!collector || [...collector].length > 20) throw new Error('收作业人必须为 1 至 20 个字');
  if (typeof data.completedAt !== 'string' || Number.isNaN(Date.parse(data.completedAt))) throw new Error('完成时间格式不正确');

  if (data.type === 'late') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.originalDate || ''))) throw new Error('原收件日期格式不正确');
    getLateDays_(data.originalDate, new Date(data.completedAt));
    if (!Array.isArray(data.lateSeats) || !data.lateSeats.length) throw new Error('请至少选择一个补交座号');
    validateActiveSeats_(data.lateSeats);
    if (new Set(data.lateSeats).size !== data.lateSeats.length) throw new Error('补交座号不可重复');
    return;
  }

  if (!Array.isArray(data.submitted) || !Array.isArray(data.missing)) throw new Error('座号资料格式不正确');
  validateActiveSeats_(data.submitted);
  validateActiveSeats_(data.missing);
  const submitted = new Set(data.submitted);
  const missing = new Set(data.missing);
  if (submitted.size !== data.submitted.length || missing.size !== data.missing.length) throw new Error('座号资料不可重复');
  if ([...submitted].some(seat => missing.has(seat))) throw new Error('已交与缺交座号不可重叠');
  const activeSeats = [];
  for (let seat = 1; seat <= 33; seat += 1) if (seat !== CONFIG.SUSPENDED_SEAT) activeSeats.push(seat);
  if (submitted.size + missing.size !== activeSeats.length || activeSeats.some(seat => !submitted.has(seat) && !missing.has(seat))) {
    throw new Error('已交与缺交座号必须完整涵盖 32 位在籍学生');
  }
  if (typeof data.startedAt !== 'string' || Number.isNaN(Date.parse(data.startedAt))) throw new Error('开始时间格式不正确');
}

function validateActiveSeats_(seats) {
  const valid = seat => Number.isInteger(seat) && seat >= 1 && seat <= 33 && seat !== CONFIG.SUSPENDED_SEAT;
  if (!seats.every(valid)) throw new Error('座号资料包含无效座号');
}

function getLateDays_(originalDate, receivedAt) {
  const original = new Date(`${originalDate}T00:00:00+08:00`);
  if (Number.isNaN(original.getTime())) throw new Error('原收件日期不正确');
  const todayText = Utilities.formatDate(receivedAt, CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  const today = new Date(`${todayText}T00:00:00+08:00`);
  const days = Math.round((today.getTime() - original.getTime()) / 86400000);
  if (days < 1 || days > CONFIG.MAX_LATE_DAYS) throw new Error('补交只接受原收件日后的第 1 至第 3 日');
  return days;
}

function sheetText_(value) {
  const text = String(value == null ? '' : value).trim();
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function getCollector_(data) {
  return String(data.collector || data.collectorSeat || '').trim();
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
