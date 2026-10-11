const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const files=new Map([
  ['/sync-engine.js','sync-engine.js'],['/backend/record-sync.js','backend/record-sync.js'],
  ['/backend/browser-retention.js','backend/browser-retention.js'],
  ['/fixture.js','tools/storage-browser-fixture.js'],['/tests.js','tools/storage-browser-tests.js']
]);
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; form-action 'none'");
  if(url.pathname==='/'){
    const html=fs.readFileSync(path.join(root,'index.html'),'utf8')
      .replace('<head>','<head><script src="/fixture.js"></script>')
      .replace('</body>','<script src="/tests.js"></script></body>');
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;
  }
  const file=files.get(url.pathname);
  if(!file){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(fs.readFileSync(path.join(root,file)));
});
server.listen(0,'127.0.0.1',()=>console.log('Isolated synthetic-data test: http://127.0.0.1:'+server.address().port+'/'));
