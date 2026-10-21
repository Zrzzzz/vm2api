// One-time source migration. Not imported by the application.
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const root = path.resolve('src/lib/db/repos')
const report=[]
for (const file of fs.readdirSync(root).filter(f=>f.endsWith('.mjs'))) {
  const full=path.join(root,file),text=fs.readFileSync(full,'utf8')
  const sf=ts.createSourceFile(full,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  const context={}
  for(let pass=0;pass<3;pass++) for(const statement of sf.statements) {
    if(!ts.isVariableStatement(statement))continue
    for(const d of statement.declarationList.declarations) {
      if(!ts.isIdentifier(d.name)||!d.initializer||context[d.name.text]!==undefined)continue
      if(ts.isArrowFunction(d.initializer)||ts.isFunctionExpression(d.initializer))continue
      try{context[d.name.text]=vm.runInNewContext('('+d.initializer.getText(sf)+')',context,{timeout:50})}catch{}
    }
  }
  const edits=[],statements=new Map(),asyncFunctions=new Set(),unresolved=[]
  function sql(source) {
    let n=0,quote=null,out=''
    for(let i=0;i<source.length;i++) {
      const c=source[i]
      if(quote) {out+=c;if(c===quote){if(source[i+1]===quote){out+=source[++i]}else quote=null}continue}
      if(c==="'"||c==='"'){quote=c;out+=c;continue}
      out+=c==='?'?'$'+(++n):c
    }
    out=out.replace(/IFNULL\(/gi,'COALESCE(')
    if(/INSERT OR IGNORE/i.test(out))out=out.replace(/INSERT OR IGNORE/i,'INSERT').trim()+' ON CONFLICT DO NOTHING'
    out=out.replace(/username = (\$\d+) COLLATE NOCASE/g,'ascii_fold(username) = ascii_fold($1)')
    if(/INSERT OR REPLACE|strftime|COLLATE NOCASE/i.test(out))throw new Error('manual SQL dialect conversion needed')
    return out
  }
  function enclosingFunction(n){while(n&&!ts.isFunctionLike(n))n=n.parent;return n}
  function markAsync(n){const f=enclosingFunction(n);if(f){if(ts.isConstructorDeclaration(f)||ts.isGetAccessor(f)||ts.isSetAccessor(f))throw new Error('async constructor/accessor requires manual change');asyncFunctions.add(f)}}
  function add(n,replacement){edits.push({start:n.getStart(sf),end:n.end,text:replacement})}
  function walk(n,fn){fn(n);ts.forEachChild(n,c=>walk(c,fn))}
  walk(sf,n=>{
    if(!ts.isCallExpression(n)||!ts.isPropertyAccessExpression(n.expression)||n.expression.name.text!=='prepare')return
    let evaluated
    try{evaluated=vm.runInNewContext('('+n.arguments[0].getText(sf)+')',context,{timeout:50});if(typeof evaluated!=='string')throw new Error();evaluated=sql(evaluated)}catch{unresolved.push({line:sf.getLineAndCharacterOfPosition(n.pos).line+1,kind:'dynamic_prepare'});return}
    if(ts.isBinaryExpression(n.parent)&&n.parent.right===n){statements.set(n.parent.left.getText(sf),{receiver:'this.db',sql:evaluated});add(n,JSON.stringify(evaluated))}
    else if(ts.isVariableDeclaration(n.parent)){statements.set(n.parent.name.getText(sf),{receiver:n.expression.expression.getText(sf),sql:evaluated});add(n,JSON.stringify(evaluated))}
    else if(ts.isPropertyAccessExpression(n.parent)&&ts.isCallExpression(n.parent.parent)){
      const call=n.parent.parent,method=n.parent.name.text
      if(!['get','all','run'].includes(method))return
      let replacement=`(await ${n.expression.expression.getText(sf)}.query(${JSON.stringify(evaluated)}, [${call.arguments.map(a=>a.getText(sf)).join(', ')}]))`
      if(method==='get')replacement+='.rows[0]';if(method==='all')replacement+='.rows'
      add(call,(ts.isExpressionStatement(call.parent) ? ';' : '')+replacement);markAsync(call)
      if(method==='run'&&ts.isPropertyAccessExpression(call.parent)&&call.parent.name.text==='changes')add(call.parent.name,'rowCount')
    }else unresolved.push({line:sf.getLineAndCharacterOfPosition(n.pos).line+1,kind:'prepare_context'})
  })
  walk(sf,n=>{
    if(!ts.isCallExpression(n)||!ts.isPropertyAccessExpression(n.expression))return
    const info=statements.get(n.expression.expression.getText(sf)),method=n.expression.name.text
    if(!info||!['get','all','run'].includes(method))return
    let replacement=`(await ${info.receiver}.query(${n.expression.expression.getText(sf)}, [${n.arguments.map(a=>a.getText(sf)).join(', ')}]))`
    if(method==='get')replacement+='.rows[0]';if(method==='all')replacement+='.rows'
    add(n,(ts.isExpressionStatement(n.parent) ? ';' : '')+replacement);markAsync(n)
    if(method==='run'&&ts.isPropertyAccessExpression(n.parent)&&n.parent.name.text==='changes')add(n.parent.name,'rowCount')
    if(method==='run'&&ts.isVariableDeclaration(n.parent))unresolved.push({line:sf.getLineAndCharacterOfPosition(n.pos).line+1,kind:'query_result_binding',name:n.parent.name.getText(sf)})
  })
  for(const fn of asyncFunctions) if(!fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)) {
    let pos=fn.getStart(sf)
    if(fn.modifiers?.length)pos=fn.modifiers.at(-1).end+1
    edits.push({start:pos,end:pos,text:'async '})
  }
  edits.sort((a,b)=>b.start-a.start)
  for(let i=0;i<edits.length-1;i++)if(edits[i+1].end>edits[i].start)throw new Error('Overlapping edits: '+file)
  let updated=text
  for(const edit of edits)updated=updated.slice(0,edit.start)+edit.text+updated.slice(edit.end)
  if(edits.length)fs.writeFileSync(full,updated)
  report.push({file,edits:edits.length,unresolved})
}
fs.writeFileSync('postgres-port-report.json',JSON.stringify(report,null,2))
console.log(JSON.stringify({files:report.filter(r=>r.edits).length,manual_sites:report.reduce((n,r)=>n+r.unresolved.length,0)}))
