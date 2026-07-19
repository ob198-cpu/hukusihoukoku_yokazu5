const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'backend', 'Code.gs'), 'utf8');
const clasp = JSON.parse(fs.readFileSync(path.join(root, '.clasp.json'), 'utf8'));
const expectedScriptId = '1dQTXk3OjzJ1TJpUzPnt7Y2ZfJObUCdgVhzhBwFQ2AYeljOiyWhFC3pwf';
const systemKeys = ['hukusihoukoku', 'yokazu', 'yokazu2', 'yokazu3', 'yokazu4', 'yokazu5', 'yokazu6'];

const failures = [];
if (clasp.scriptId !== expectedScriptId) failures.push('正本GASのscriptIdが変更されています。');
systemKeys.forEach(key => {
  if (!new RegExp('(?:^|\\n)\\s*' + key + ':').test(source)) failures.push('保存先ルーターに ' + key + ' がありません。');
});
if (!source.includes('commitDataSafely_')) failures.push('世代付き保存がありません。');
if (!source.includes('recoverPendingSave_')) failures.push('異常終了時の復旧処理がありません。');
if (source.includes('.clearContents(') || source.includes('.clear(')) failures.push('稼働シートの全消去処理が残っています。');
if (/String\(rawKey\s*\|\|\s*['"](?:yokazu5|yokazu|hukusihoukoku)['"]/.test(source)) failures.push('systemKey欠落時の既定保存先が残っています。');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('backend safety checks passed');
