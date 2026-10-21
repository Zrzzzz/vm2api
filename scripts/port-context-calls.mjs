// Explicit application dependency names supplement TypeScript's untyped route contexts.
import ts from 'typescript';import fs from 'node:fs';import path from 'node:path';
const files=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(d,e.name)):e.name.endsWith('.mjs')?[path.join(d,e.name)]:[]);
const names={manager:'ClusterManager',clusterManager:'ClusterManager',settings:'SettingsRepo',settingsRepo:'SettingsRepo',repo:'Repository',apiKeyStore:'ApiKeyStore',panelUsers:'PanelUserStore',requestLog:'RequestLogStore',accountQuota:'AccountQuota',stickyRouter:'StickyRouter',proxyPool:'ProxyPool',runtimeRepo:'AccountRuntimeRepo',attemptsRepo:'RequestAttemptsRepo',groupsRepo:'GroupsRepo',poolScheduler:'PoolScheduler',apiScheduler:'ApiScheduler',backupService:'BackupService'};
const trees=files('src').map(file=>ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)),methods=new Map();
const walk=(n,f)=>{f(n);ts.forEachChild(n,c=>walk(c,f))};
for(const sf of trees)walk(sf,n=>{if(ts.isClassDeclaration(n))methods.set(n.name?.text,new Set(n.members.filter(m=>m.modifiers?.some(x=>x.kind===ts.SyntaxKind.AsyncKeyword)).map(m=>m.name?.getText(sf))))});
methods.set('Repository',new Set([...methods].filter(([name])=>name?.endsWith('Repo')).flatMap(([,items])=>[...items])));
for(const sf of trees){const edits=[],fns=new Set();walk(sf,n=>{
 if(!ts.isCallExpression(n)||!ts.isPropertyAccessExpression(n.expression)||ts.isAwaitExpression(n.parent))return;
 const obj=n.expression.expression, dep=ts.isPropertyAccessExpression(obj)?obj.name.text:ts.isIdentifier(obj)?obj.text:null;
 if(!names[dep]||!methods.get(names[dep])?.has(n.expression.name.text))return;
 if(ts.isPropertyAccessExpression(n.parent)&&['then','catch','finally'].includes(n.parent.name.text))return;
 let fn;for(let p=n.parent;p;p=p.parent)if(ts.isFunctionLike(p)){fn=p;break}
 if(fn&&(ts.isConstructorDeclaration(fn)||ts.isGetAccessor(fn)))throw new Error('Async constructor dependency: '+sf.fileName);
 if(edits.some(e=>n.getStart(sf)<e.end&&n.end>e.start))return;
 edits.push({start:n.getStart(sf),end:n.end,text:ts.isExpressionStatement(n.parent)?'await '+n.getText(sf):'(await '+n.getText(sf)+')'});if(fn)fns.add(fn);
 });
 for(const f of fns)if(!f.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)){const start=f.modifiers?.length?f.modifiers.at(-1).end+1:f.getStart(sf);edits.push({start,end:start,text:'async '})}
 let source=sf.text;for(const e of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,e.start)+e.text+source.slice(e.end);if(edits.length){fs.writeFileSync(sf.fileName,source);console.log(sf.fileName,edits.length)}
}
