import ts from 'typescript';import fs from 'node:fs';import path from 'node:path';
const files=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(d,e.name)):e.name.endsWith('.mjs')?[path.join(d,e.name)]:[]);
for(const file of files('src')){
 let text=fs.readFileSync(file,'utf8'),sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),fns=new Set();
 function visit(n){if(ts.isAwaitExpression(n)){for(let p=n.parent;p;p=p.parent)if(ts.isFunctionLike(p)){if(!p.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword))fns.add(p);break}}ts.forEachChild(n,visit)}visit(sf);
 const positions=[...fns].map(f=>f.modifiers?.length?f.modifiers.at(-1).end+1:f.getStart(sf)).sort((a,b)=>b-a);
 for(const pos of positions)text=text.slice(0,pos)+'async '+text.slice(pos);if(positions.length)fs.writeFileSync(file,text)
}
