const CONFIG = {
  SUSPENDED_SEAT: 26,
  TIME_ZONE: 'Asia/Taipei'
};

function doGet() {
  return jsonOutput_({ ok: true, service: '作業收件小幫手', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    const expectedToken = PropertiesService.getScriptProperties().getProperty('ACCESS_TOKEN');
    if (!expectedToken || !e || !e.parameter || e.parameter.token !== expectedToken) {
      return jsonOutput_({ ok: false, error: 'unauthorized' });
    }
    const payload = JSON.parse(e.parameter.payload || '{}');
    validatePayload_(payload);
    const result = saveAssignment_(payload);
    return jsonOutput_({
      ok: true,
      spreadsheetId: result.id,
      spreadsheetUrl: result.url,
      detailSheetName: result.detailSheetName
    });
  } catch (error) {
    console.error(error);
    return jsonOutput_({ ok: false, error: String(error && error.message || error) });
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
    sheet.getRange('A2:H2').merge().setValue('有送出登记的日期会自动建立分页；同日多份作业依作业名称分区。').setHorizontalAlignment('center').setBackground('#FFF0F5');
    sheet.getRange('A4:H4').setValues([['完成时间', '作业名称', '收作业座号', '已交人数', '缺交人数', '缺交座号', '明细分页', '查看']]).setFontWeight('bold').setBackground('#B8DCEF');
    sheet.setFrozenRows(4);
    sheet.setColumnWidths(1, 1, 145); sheet.setColumnWidths(2, 1, 220); sheet.setColumnWidths(3, 1, 160);
    sheet.setColumnWidths(4, 2, 90); sheet.setColumnWidths(6, 1, 240); sheet.setColumnWidths(7, 2, 135);
  }
  return sheet;
}

function getOrCreateDailySheet_(spreadsheet, completedAt) {
  const sheetName = Utilities.formatDate(completedAt, CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    sheet.setTabColor('#F7BFD5');
    sheet.setColumnWidth(1, 80); sheet.setColumnWidth(2, 160); sheet.setColumnWidth(3, 110);
    sheet.setColumnWidths(4, 3, 105);
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
      seat === CONFIG.SUSPENDED_SEAT ? '休学' : submitted.has(seat) ? '已交' : '缺交'
    ]);
  }
  const startRow = sheet.getLastRow() ? sheet.getLastRow() + 3 : 1;
  sheet.getRange(startRow, 1, 1, 6).merge().setValue(data.assignmentName).setFontSize(18).setFontWeight('bold').setHorizontalAlignment('center').setBackground('#F7BFD5');
  sheet.getRange(startRow + 1, 1, 5, 2).setValues([
    ['作业名称', data.assignmentName],
    ['收作业座号', `${data.collectorSeat}号`],
    ['开始时间', new Date(data.startedAt)],
    ['完成时间', completedAt],
    ['缺交座号', (data.missing || []).length ? `${data.missing.join('、')}号` : '全班皆已缴交']
  ]);
  sheet.getRange(startRow + 3, 2, 2, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  sheet.getRange(startRow + 7, 1, 1, 3).setValues([['座号', '姓名', '状态']]).setFontWeight('bold').setBackground('#B8DCEF');
  sheet.getRange(startRow + 8, 1, rows.length, 3).setValues(rows);
  sheet.getRange(startRow + 1, 1, 5, 1).setFontWeight('bold').setBackground('#FFF0F5');
  sheet.getRange(startRow + 8, 1, rows.length, 1).setHorizontalAlignment('center');
  sheet.getRange(startRow + 8, 3, rows.length, 1).setHorizontalAlignment('center');
  const statusRange = sheet.getRange(startRow + 8, 3, rows.length, 1);
  const existingRules = sheet.getConditionalFormatRules();
  sheet.setConditionalFormatRules(existingRules.concat([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('已交').setBackground('#BFE5D1').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('缺交').setBackground('#F7BFD5').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('休学').setBackground('#DDD9DF').setRanges([statusRange]).build()
  ]));
  sheet.getRange(startRow, 1, 41, 6).setVerticalAlignment('middle');
  return startRow;
}

function appendIndexRow_(indexSheet, dailySheet, blockStartRow, data, completedAt) {
  const row = Math.max(indexSheet.getLastRow() + 1, 5);
  indexSheet.getRange(row, 1, 1, 7).setValues([[
    completedAt,
    data.assignmentName,
    `${data.collectorSeat}号`,
    data.submitted.length,
    data.missing.length,
    data.missing.length ? `${data.missing.join('、')}号` : '无',
    dailySheet.getName()
  ]]);
  indexSheet.getRange(row, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  indexSheet.getRange(row, 8).setFormula(`=HYPERLINK("#gid=${dailySheet.getSheetId()}&range=A${blockStartRow}","查看")`);
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
  if (!String(data.assignmentName || '').trim()) throw new Error('缺少作业名称');
  if ([...String(data.assignmentName || '').trim()].length > 6) throw new Error('作业名称最多 6 个字');
  const collectorSeat = Number(data.collectorSeat);
  if (!Number.isInteger(collectorSeat) || collectorSeat < 1 || collectorSeat > 33 || collectorSeat === CONFIG.SUSPENDED_SEAT) throw new Error('收作业座号不正确');
  if (!Array.isArray(data.submitted) || !Array.isArray(data.missing)) throw new Error('座号资料格式不正确');
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
