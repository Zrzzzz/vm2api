import ts from 'typescript';import fs from 'node:fs';import path from 'node:path';
const files=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(d,e.name)):e.name.endsWith('.mjs')?[path.resolve(d,e.name)]:[]);
const roots=files('src'),program=ts.createProgram(roots,{allowJs:true,checkJs:true,noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,skipLibCheck:true}),checker=program.getTypeChecker(),report=[];
function walk(n,fn){fn(n);ts.forEachChild(n,c=>walk(c,fn))}
for(const sf of program.getSourceFiles())if(roots.includes(sf.fileName))walk(sf,n=>{
 if(!ts.isCallExpression(n)||ts.isAwaitExpression(n.parent)||ts.isReturnStatement(n.parent))return;
 const type=checker.getTypeAtLocation(n);if(!checker.getPromisedTypeOfPromise(type))return;
 const p=n.parent;
 if(ts.isPropertyAccessExpression(p)&&['then','catch','finally'].includes(p.name.text))return;
 if(ts.isCallExpression(p)&&['Promise.all','Promise.allSettled','Promise.race','Promise.resolve'].includes(p.expression.getText(sf)))return;
 if(ts.isArrowFunction(p)&&p.body===n)return;
 if(ts.isVariableDeclaration(p)||ts.isArrayLiteralExpression(p)||ts.isPropertyAssignment(p))return;
 report.push({file:sf.fileName,line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,call:n.expression.getText(sf),consumer:ts.SyntaxKind[p.kind]});
});fs.writeFileSync('postgres-promise-audit.json',JSON.stringify(report,null,2));console.log({issues:report.length});
