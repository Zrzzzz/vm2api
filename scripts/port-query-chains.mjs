// One-time source transformation. SQL dialect and parameters must be reviewed separately.
import ts from 'typescript'
import fs from 'node:fs'
for(const file of process.argv.slice(2)) {
 let source=fs.readFileSync(file,'utf8');const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),edits=[],fns=new Set();
 function visit(n){
  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&['get','all','run'].includes(n.expression.name.text)){
   const prep=n.expression.expression;
   if(ts.isCallExpression(prep)&&ts.isPropertyAccessExpression(prep.expression)&&prep.expression.name.text==='prepare'){
    const kind=n.expression.name.text,db=prep.expression.expression.getText(sf),sql=prep.arguments[0].getText(sf),args=n.arguments.map(a=>a.getText(sf)).join(', ');
    edits.push({start:n.getStart(sf),end:n.end,text:`(await ${db}.query(${sql}, [${args}]))${kind==='all'?'.rows':kind==='get'?'.rows[0]':''}`});
    for(let p=n.parent;p;p=p.parent)if(ts.isFunctionLike(p)){fns.add(p);break}
    return;
   }
  }
  ts.forEachChild(n,visit)
 }
 visit(sf);
 for(const f of fns)if(!f.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)){
  const start=f.modifiers?.length?f.modifiers.at(-1).end+1:f.getStart(sf);edits.push({start,end:start,text:'async '})
 }
 for(const e of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,e.start)+e.text+source.slice(e.end);
 fs.writeFileSync(file,source);console.log(file,edits.length)
}
