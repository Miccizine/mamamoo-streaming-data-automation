'use strict';
const { getSheetsClient, getSheetData, getPHTTimestamp } = require('./helpers');

const GRAY_BACKGROUND = { red: 0.851, green: 0.851, blue: 0.851 };
const GRAY_TEXT       = { red: 0.4,   green: 0.4,   blue: 0.4 };
const WHITE           = { red: 1,     green: 1,      blue: 1   };
const BLACK           = { red: 0,     green: 0,      blue: 0   };

async function processMilestonesSheet(sheets) {
  const sheetId     = process.env.GOOGLE_SHEETS_ID;
  const data        = await getSheetData(sheets, 'Milestones Achieved');
  const requests    = [];
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const mSheet      = spreadsheet.data.sheets.find(s => s.properties.title === 'Milestones Achieved');
  if (!mSheet) { console.log('Milestones Achieved sheet not found'); return; }
  const gid = mSheet.properties.sheetId;

  for (let i = 1; i < data.length; i++) {
    const row        = data[i];
    const rowIndex   = i; // 0-based for API
    const hasDate    = !!(row[0] && row[0] !== '');
    const checkboxVal = row[7];
    const hasCheckbox = checkboxVal !== '' && checkboxVal !== undefined;
    const isChecked   = checkboxVal === true || checkboxVal === 'TRUE';
    const alreadyGray = !!(row[8] && row[8] !== '');

    // Add checkbox if row has data but no checkbox yet
    if (hasDate && !hasCheckbox) {
      requests.push({
        repeatCell: {
          range: { sheetId: gid, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 7, endColumnIndex: 8 },
          cell: { dataValidation: { condition: { type: 'BOOLEAN' }, showCustomUi: true } },
          fields: 'dataValidation'
        }
      });
      console.log(`Added checkbox to row ${i + 1}: ${row[1]}`);
    }

    // Reset gray if checkbox is unticked but row is grayed (inherited or corrupt state)
    if (!isChecked && alreadyGray) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: sheetId,
        range: `Milestones Achieved!I${i + 1}`
      });
      requests.push({
        repeatCell: {
          range: { sheetId: gid, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: 9 },
          cell: { userEnteredFormat: { backgroundColor: WHITE, textFormat: { foregroundColor: BLACK } } },
          fields: 'userEnteredFormat(backgroundColor,textFormat)'
        }
      });
      console.log(`Cleared gray on unticked row ${i + 1}: ${row[1]}`);
    }

    // Gray out row only if checkbox is ticked and not already grayed
    if (isChecked && !alreadyGray) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `Milestones Achieved!I${i + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[getPHTTimestamp()]] }
      });
      requests.push({
        repeatCell: {
          range: { sheetId: gid, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: 9 },
          cell: { userEnteredFormat: { backgroundColor: GRAY_BACKGROUND, textFormat: { foregroundColor: GRAY_TEXT } } },
          fields: 'userEnteredFormat(backgroundColor,textFormat)'
        }
      });
      console.log(`Grayed out row ${i + 1}: ${row[1]}`);
    }
  }

 if (requests.length > 0) {
    const CHUNK = 50;
    for (let i = 0; i < requests.length; i += CHUNK) {
      const chunk = requests.slice(i, i + CHUNK);
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: chunk } });
      if (i + CHUNK < requests.length) await new Promise(r => setTimeout(r, 1000));
    }
    console.log(`Applied ${requests.length} formatting updates`);
  } else {
    console.log('No formatting updates needed');
  }
}

async function main() {
  console.log('Starting sheet maintenance...');
  const sheets = await getSheetsClient();
  await processMilestonesSheet(sheets);
  console.log('Sheet maintenance complete.');
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
