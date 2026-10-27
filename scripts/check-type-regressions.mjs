import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const baselinePath = path.join(root, 'typecheck-baseline.json')

export function diagnostics(overrides = new Map()) {
  return collectDiagnostics(overrides, 'tsconfig.async.json', { checkJs: true, strictNullChecks: false })
}

export function strictDiagnostics(overrides = new Map()) {
  return collectDiagnostics(overrides, 'tsconfig.strict.json', {})
}

function collectDiagnostics(overrides, configFile, options) {
  const config = ts.readConfigFile(path.join(root, configFile), ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, options)
  if (parsed.errors.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      }),
    )
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host)
  host.readFile = (file) => overrides.get(path.relative(root, file)) ?? readFile(file)
  const program = ts.createProgram(
    parsed.fileNames.filter((f) => !f.includes('/test/types/')),
    parsed.options,
    host,
  )
  return ts.getPreEmitDiagnostics(program).map((d) => ({
    file: d.file ? path.relative(root, d.file.fileName) : '<config>',
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    line: d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0,
  }))
}

function key(d) {
  return JSON.stringify([d.file, d.code, d.message])
}
export function newDiagnostics(current, baseline) {
  const counts = new Map()
  for (const d of baseline) counts.set(key(d), (counts.get(key(d)) || 0) + 1)
  return current.filter((d) => {
    const remaining = counts.get(key(d)) || 0
    if (!remaining) return true
    counts.set(key(d), remaining - 1)
    return false
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const current = diagnostics()
  if (process.argv.includes('--update-baseline')) {
    fs.writeFileSync(
      baselinePath,
      JSON.stringify(
        current.map(({ line, ...d }) => d),
        null,
        2,
      ) + '\n',
    )
    console.log(`Recorded ${current.length} existing diagnostics; review baseline changes before committing.`)
  } else {
    const added = newDiagnostics(current, JSON.parse(fs.readFileSync(baselinePath, 'utf8')))
    for (const d of added) console.error(`${d.file}:${d.line} TS${d.code}: ${d.message}`)
    console.log(`Backend type regressions: ${added.length}; existing diagnostics: ${current.length - added.length}`)
    if (added.length) process.exitCode = 1
  }
}
