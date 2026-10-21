import ts from 'typescript';import fs from 'node:fs';import path from 'node:path';
const files=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(d,e.name)):e.name.endsWith('.mjs')?[path.join(d,e.name)]:[]);
for(const file of files('src')){
 let source=fs.readFileSync(file,'utf8'),sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),edits=[],imports=new Set(),parents=new Set();
 function visit(n){if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&['map','filter','find','some'].includes(n.expression.name.text)&&n.arguments[0]?.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)){
  const method=n.expression.name.text;
  if(method==='map'&&ts.isCallExpression(n.parent)&&n.parent.expression.getText(sf)==='Promise.all')return;
  const helper='async'+method[0].toUpperCase()+method.slice(1);
  const text=method==='map'?`(await Promise.all(${n.getText(sf)}))`:`(await ${helper}(${n.expression.expression.getText(sf)}, ${n.arguments[0].getText(sf)}))`;
  edits.push({start:n.getStart(sf),end:n.end,text});if(method!=='map')imports.add(helper);
  for(let p=n.parent;p;p=p.parent)if(ts.isFunctionLike(p)){parents.add(p);break}return;
 }ts.forEachChild(n,visit)}visit(sf);
 for(const f of parents)if(!f.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)){const start=f.modifiers?.length?f.modifiers.at(-1).end+1:f.getStart(sf);edits.push({start,end:start,text:'async '})}
 for(const e of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,e.start)+e.text+source.slice(e.end);
 if(imports.size){let rel=path.relative(path.dirname(file),'src/lib/core/async-collections.mjs');if(!rel.startsWith('.'))rel='./'+rel;source=`import { ${[...imports].join(', ')} } from '${rel}'\n`+source}
 if(edits.length)fs.writeFileSync(file,source)
}
