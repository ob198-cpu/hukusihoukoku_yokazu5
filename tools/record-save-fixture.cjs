const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const clone = value => JSON.parse(JSON.stringify(value));
class Range {
  constructor(sheet, row, col, height=1, width=1) { Object.assign(this, {sheet,row,col,height,width}); }
  getValues() {
    return Array.from({length:this.height}, (_,r) => Array.from({length:this.width},
      (_,c) => this.sheet.rows[this.row+r-1]?.[this.col+c-1] ?? ''));
  }
  getFormulas() { return Array.from({length:this.height}, () => Array(this.width).fill('')); }
  setValues(values) {
    this.sheet.book.hook?.({sheet:this.sheet, row:this.row, col:this.col, values});
    for(let r=0; r<this.height; r++) {
      const row=this.sheet.rows[this.row+r-1] ||= [];
      for(let c=0; c<this.width; c++) {
        const value=values[r][c];
        row[this.col+c-1]=this.sheet.book.coerceDates && typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? new Date(value+'T00:00:00.000Z') : value;
      }
    }
    this.sheet.book.writes.push({sheet:this.sheet.name,row:this.row,count:this.height});
    return this;
  }
}
class Sheet {
  constructor(book,name) { Object.assign(this,{book,name,rows:[],maxRows:1000,maxColumns:26,id:book.nextId++}); }
  getName(){return this.name;}
  getSheetId(){return this.id;}
  getLastRow(){for(let i=this.rows.length-1;i>=0;i--) if(this.rows[i]?.some(v=>v!==''&&v!=null)) return i+1; return 0;}
  getMaxRows(){return this.maxRows;}
  getMaxColumns(){return this.maxColumns;}
  getRange(...args){return new Range(this,...args);}
  appendRow(row){return this.getRange(this.getLastRow()+1,1,1,row.length).setValues([row]);}
  insertRowsAfter(_row,count){this.maxRows+=count;return this;}
  insertColumnsAfter(_col,count){this.maxColumns+=count;return this;}
  setFrozenRows(){return this;}
  setName(name){this.book.sheets.delete(this.name);this.name=name;this.book.sheets.set(name,this);return this;}
  createTextFinder(text){const self=this;return {matchEntireCell(){return this;},findNext(){return self.rows.some(row=>row.includes(text))?{}:null;}};}
}
class Book {
  constructor(){this.sheets=new Map();this.nextId=1;this.writes=[];}
  getSheetByName(name){return this.sheets.get(name)||null;}
  insertSheet(name){if(this.sheets.has(name))throw Error('duplicate');const s=new Sheet(this,name);this.sheets.set(name,s);return s;}
  deleteSheet(sheet){this.sheets.delete(sheet.name);}
  getSpreadsheetTimeZone(){return 'Etc/UTC';}
}
function backend() {
  const books=new Map(), properties=new Map();
  let id=0, locked=false;
  const ctx=vm.createContext({console:{error(){}}, Date,
    Utilities:{getUuid:()=>String(++id).padStart(8,'0')+'-test',
      parseDate:(text,timezone)=>{if(!timezone)throw Error('Invalid timeZone');return new Date(text.length===10?text+'T00:00:00.000Z':text.replace(' ','T')+'Z');},
      formatDate:(date,_timezone,format)=>format==='yyyy-MM-dd'?date.toISOString().slice(0,10):date.toISOString().slice(0,format.endsWith(':ss')?19:16).replace('T',' '),
      DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},
      computeDigest:(algorithm,text)=>[...crypto.createHash(algorithm).update(text).digest()]},
    SpreadsheetApp:{openById:spreadsheetId=>{if(!books.has(spreadsheetId))books.set(spreadsheetId,new Book());return books.get(spreadsheetId);},flush(){}},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties.get(k)||null,
      setProperty:(k,v)=>properties.set(k,v),deleteProperty:k=>properties.delete(k)})},
    LockService:{getScriptLock:()=>({waitLock(){if(locked)throw Error('lock conflict');locked=true;},releaseLock(){locked=false;}})},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})}
  });
  for(const name of ['record-sync.js','Code.gs','RecordSave.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../backend',name),'utf8'),ctx);
  function seed(systemKey, data) {
    ctx.selectSpreadsheet_(systemKey);ctx.ensureAllSheets_();ctx.commitDataSafely_(ctx.normalizeData_(data),'seed-'+systemKey);
    const book=ctx.targetSpreadsheet_();book.writes.length=0;return book;
  }
  const book=seed('yokazu5',{accounts:[],posts:[{id:'p',content:'original',impressions:1}]});
  const sheetId=[...books.keys()][0];
  const api=(action,payload={})=>JSON.parse(ctx.doPost({postData:{contents:JSON.stringify({systemKey:'yokazu5',action,...payload})}}).text);
  const request=(changes, extra={})=>api('saveChanges',{protocolVersion:1,spreadsheetId:sheetId,requestId:'request-1',changes,...extra});
  const read=()=>api('loadData').data.data;
  return {ctx,books,book,properties,sheetId,seed,api,request,read,clone};
}
module.exports={backend,clone};
