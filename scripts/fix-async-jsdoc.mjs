import fs from 'node:fs';import ts from 'typescript';import path from 'node:path';
const files=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(d,e.name)):e.name.endsWith('.mjs')?[path.join(d,e.name)]:[]);
for(const file of files('src')){let source=fs.readFileSync(file,'utf8');const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),edits=[];
function visit(n){if(ts.isFunctionLike(n)&&n.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword))for(const doc of n.jsDoc||[])for(const tag of doc.tags||[]){const type=tag.typeExpression?.type;if(['returns','return'].includes(tag.tagName.text)&&type&&!type.getText(sf).startsWith('Promise<'))edits.push({start:type.getStart(sf),end:type.end,text:'Promise<'+type.getText(sf)+'>'})}ts.forEachChild(n,visit)}visit(sf);
for(const e of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,e.start)+e.text+source.slice(e.end);if(edits.length)fs.writeFileSync(file,source)
}
