// One-time semantic source refactor; never used at runtime.
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import cp from 'node:child_process'

function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):e.name.endsWith('.mjs')?[path.resolve(dir,e.name)]:[])}
const roots=files('src'),repoOnly=process.argv.includes('--repos-only')
const selected=f=>!repoOnly||f.includes('/src/lib/db/repos/')
const walk=(n,fn)=>{fn(n);ts.forEachChild(n,c=>walk(c,fn))}
const isAsync=f=>f.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)
function name(n){if(n.name)return n.name.getText();if(ts.isVariableDeclaration(n.parent))return n.parent.name.getText();if(ts.isPropertyAssignment(n.parent))return n.parent.name.getText();return '<callback>'}
function key(f){const names=[];for(let n=f;n;n=n.parent)if(ts.isFunctionLike(n)||ts.isClassDeclaration(n))names.unshift(name(n));return f.getSourceFile().fileName+'#'+names.join('.')}
const oldAsync=new Set(),marked=new Set()
for(const file of roots){
 let text;try{text=cp.execFileSync('git',['show','HEAD:'+path.relative(process.cwd(),file)],{encoding:'utf8',stdio:['ignore','pipe','ignore']})}catch{continue}
 const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
 walk(sf,n=>{if(ts.isFunctionLike(n)&&isAsync(n))oldAsync.add(key(n))})
}
let total=0,unresolved=[]
for(let round=0;round<30;round++){
 const program=ts.createProgram(roots,{allowJs:true,checkJs:true,noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,skipLibCheck:true})
 const checker=program.getTypeChecker(),changes=new Map(),asyncFns=new Map()
 for(const sf of program.getSourceFiles())if(roots.includes(sf.fileName))walk(sf,n=>{if(ts.isFunctionLike(n)&&isAsync(n)&&!oldAsync.has(key(n)))marked.add(key(n))})
 function add(sf,n,text){let edits=changes.get(sf.fileName);if(!edits)changes.set(sf.fileName,edits=[]);const edit={start:n.getStart(sf),end:n.end,text};if(edits.some(e=>edit.start<e.end&&edit.end>e.start))return false;edits.push(edit);return true}
 function containing(n){for(let p=n.parent;p;p=p.parent)if(ts.isFunctionLike(p))return p;return null}
 for(const sf of program.getSourceFiles()){
  if(!roots.includes(sf.fileName)||!selected(sf.fileName))continue
  walk(sf,n=>{
   if(!ts.isCallExpression(n)||ts.isAwaitExpression(n.parent))return
   const sig=checker.getResolvedSignature(n),decl=sig?.declaration
   if(!decl||!marked.has(key(decl)))return
   if(ts.isPropertyAccessExpression(n.parent)&&['then','catch','finally'].includes(n.parent.name.text))return
   const fn=containing(n)
   if(fn&&(ts.isConstructorDeclaration(fn)||ts.isGetAccessor(fn)||ts.isSetAccessor(fn))){unresolved.push({file:sf.fileName,line:sf.getLineAndCharacterOfPosition(n.pos).line+1,kind:'constructor_or_accessor',callee:n.expression.getText(sf)});return}
   if(add(sf,n,(ts.isExpressionStatement(n.parent)?'await '+n.getText(sf):'(await '+n.getText(sf)+')'))&&fn&&!isAsync(fn))asyncFns.set(key(fn),fn)
  })
 }
 for(const fn of asyncFns.values()){
  const sf=fn.getSourceFile();let edits=changes.get(sf.fileName);if(!edits)changes.set(sf.fileName,edits=[])
  let start=fn.getStart(sf);if(fn.modifiers?.length)start=fn.modifiers.at(-1).end+1
  edits.push({start,end:start,text:'async '});marked.add(key(fn))
 }
 let count=0
 for(const [file,edits] of changes){let text=fs.readFileSync(file,'utf8');for(const e of edits.sort((a,b)=>b.start-a.start)){text=text.slice(0,e.start)+e.text+text.slice(e.end);count++}fs.writeFileSync(file,text)}
 total+=count;console.log(JSON.stringify({round,edits:count,marked:marked.size}))
 if(!count)break
}
fs.writeFileSync('postgres-async-report.json',JSON.stringify({total,unresolved:[...new Map(unresolved.map(r=>[JSON.stringify(r),r])).values()]},null,2))
