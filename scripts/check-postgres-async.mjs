import ts from 'typescript';import fs from 'node:fs';import path from 'node:path';
const files=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(d,e.name)):e.name.endsWith('.mjs')?[path.join(d,e.name)]:[]);
const p=ts.createProgram(files('src'),{allowJs:true,checkJs:true,noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,skipLibCheck:true});
const diagnostics=ts.getPreEmitDiagnostics(p).filter(d=>d.file?.fileName.includes('/src/')||d.file?.fileName.startsWith('src/'));
const relevant=diagnostics.filter(d=>/Promise|await|async|already been exported|Cannot redeclare|has no exported member/.test(ts.flattenDiagnosticMessageText(d.messageText,' '))||[1005,1109,1308,2300,2528].includes(d.code));
fs.writeFileSync('postgres-check-report.json',JSON.stringify(relevant.map(d=>({file:d.file.fileName,line:d.file.getLineAndCharacterOfPosition(d.start).line+1,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,' ')})),null,2));
console.log(JSON.stringify({total:diagnostics.length,asyncIssues:relevant.length}));
