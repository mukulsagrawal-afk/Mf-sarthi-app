const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseStatementFile } = require('../server/utils/statementParser');

test('client statement Excel import remains compatible with the patched workbook parser', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Investor Name','Mobile','PAN','Current Value','Monthly SIP'],
    ['Anita Shah','9876543210','abcde1234f','₹1,25,000','5,000'],
  ]),'Clients');
  const buffer = XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  const result = await parseStatementFile(buffer,'cams-export.xlsx');
  assert.deepEqual(result.rows,[{name:'Anita Shah',mobile:'9876543210',pan:'ABCDE1234F',aum:125000,sip:5000}]);
});
