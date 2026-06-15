#!/usr/bin/env node
import path from "node:path"
import {
  DEFAULT_PROJECT_PATH,
  askWiki,
  apiRunIngest,
  applyManifest,
  exportTrainingSamples,
  finalizeStagedIngest,
  getBrainStatus,
  marketValidatePrediction,
  prepareIngest,
  rememberBrainMemory,
  resolveBrainMemory,
  runAskEval,
  runAskSearch,
  runAskSmartSearch,
  runCompanyResearch,
  runDailyLoop,
  runHygiene,
  runSelfTraining,
  runTemporalFactsAudit,
} from "./codex-ingest-lib.mjs"

function printHelp() {
  console.log(`Usage:
  npm run codex:ingest -- prepare --source <raw-file> [--project <wiki-root>] [--schema <schema.md>]
  npm run codex:ingest -- api-run --source <raw-file> --model <model> [--project <wiki-root>] [--api-key <key>]
  npm run codex:ingest -- api-run --provider codex --source <raw-file> [--project <wiki-root>] [--model <model>] [--page-concurrency <n>] [--max-plan-items <n>]
  npm run codex:ingest -- finalize --report <codex-ingest-report-dir> [--provider codex]
  npm run codex:ingest -- apply --manifest <changes.json> [--project <wiki-root>] [--write]
  npm run codex:ingest -- search --query "..." [--project <wiki-root>] [--preset auto|quick|deep|validate|industry] [--output text|json]
  npm run codex:ingest -- smart-search --query "..." [--project <wiki-root>] [--preset auto|quick|deep|validate|industry] [--no-llm-rerank] [--no-fallback] [--output text|json]
  npm run codex:ingest -- ask --query "..." [--project <wiki-root>] [--provider codex] [--show-context] [--show-sources] [--include-invalidated]
  npm run codex:ingest -- ask eval [--query "..."] [--expect-paths wiki/概念/xxx.md,raw/研报新闻/xxx.md] [--project <wiki-root>] [--write]
  npm run codex:ingest -- brain remember --type correction|thread|preference|guardrail --text "..." [--project <wiki-root>]
  npm run codex:ingest -- brain status [--project <wiki-root>]
  npm run codex:ingest -- brain resolve --id <id> --result success|failure|uncertain [--project <wiki-root>]
  npm run codex:ingest -- market-validate --prediction "..." --stock <code|name> [--window 20d] [--write]
  npm run codex:ingest -- company-research --stock <code|name> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--deep] [--cninfo-event-from YYYY-MM-DD] [--cninfo-download-timeout-ms 90000] [--project <wiki-root>]
  npm run codex:ingest -- daily-loop --mode premarket|postclose|full [--write] [--show-context] [--validate-pending-only]
  npm run codex:ingest -- self-train [--project <wiki-root>] [--write]
  npm run codex:ingest -- export-samples --kind sft|preference|eval [--project <wiki-root>]
  npm run codex:ingest -- hygiene audit|plan|apply [--project <wiki-root>] [--keep-days 14] [--write]
  npm run codex:ingest -- temporal-facts audit [--project <wiki-root>] [--top-n 50] [--write]

Defaults:
  --project ${DEFAULT_PROJECT_PATH}

Notes:
  prepare writes only .llm-wiki/codex-ingest reports.
  api-run writes staged artifacts (analysis.md, plan.json, files/**, changes.json) and dry-runs the manifest.
  finalize resumes after page FILE blocks exist and only regenerates housekeeping/changes.json/dry-run.
  --provider codex uses the local Codex CLI login instead of OPENAI_API_KEY.
  --page-concurrency controls parallel FILE-block generation; defaults to 1.
  --max-plan-items, --max-create-pages, and --max-update-pages record soft plan-budget warnings in plan-budget.json; they do not stop normal ingest.
  retrieval tiers: search is local multi-source evidence retrieval; smart-search uses the LLM only for retrieval planning/evidence reranking and falls back to local search unless --no-fallback is set; ask generates a final cited answer.
  ask is read-only. Use --show-context to print retrieval hits; use --show-sources to print source routing/native query summaries.
  ask eval is read-only by default and reports retrieval recall/relevance/source coverage/raw-noise/structure scores; --write stores only .llm-wiki/eval/*.json.
  ask source controls: --source-k 3 --sources auto|wiki,raw,graph,facts,brain,stock-price --graph-depth auto|1|2 --top-brain 8 --sql-limit 200 --raw-scan-limit 320 --max-raw-bytes <n> --include-invalidated.
  daily-loop controls: --question-count <n> --lookback-days 30 --max-stocks-per-question 8 --max-existing-validations <n> --validation-windows 1,3,5,10,20 --market-validate auto|off|tencent|eastmoney --validate-pending-only.
  daily-loop questions are planned by the provider LLM first; rules/templates are only fallback.
  brain/market/self-train commands write only data/brain or .llm-wiki/exports when explicitly invoked; ask remains read-only.
  company-research writes only .llm-wiki/company-research reports, model workbooks, and wiki write candidates; --deep adds document-extract/business-breakdown/deep-report artifacts, searches official event/IR lookbacks, uses SSE fallback for SH listings, and never writes raw/ or formal wiki/ pages.
  daily-loop writes only data/brain and .llm-wiki/daily-research or .llm-wiki/wiki-feedback when --write is present.
  hygiene audit/plan are read-only; hygiene apply only removes old successful .llm-wiki/codex-ingest report dirs with --write.
  temporal-facts audit scans wiki/**/*.md and writes only .llm-wiki/temporal-facts when --write is present.
  apply is dry-run unless --write is present.
  raw/ is never written by this CLI.
`)
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "no-report", "allow-source-change", "help", "show-context", "show-sources", "include-invalidated", "validate-pending-only", "deep", "no-llm-rerank", "no-fallback"].includes(key)) {
      args[key] = true
      continue
    }
    const value = argv[i + 1]
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`)
    }
    args[key] = value
    i += 1
  }
  return args
}

function requireArg(args, name) {
  if (!args[name]) throw new Error(`Missing required --${name}`)
  return args[name]
}

function oneLine(value, limit = 220) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}...`
}

function renderHits(items, title, limit = 5) {
  if (!items?.length) return []
  const lines = ["", title]
  for (const [index, item] of items.slice(0, limit).entries()) {
    const score = Number.isFinite(Number(item.score)) ? ` | score ${Math.round(Number(item.score) * 1000) / 1000}` : ""
    lines.push(`${index + 1}. ${item.title ?? item.path ?? item.id}${score}`)
    if (item.path) lines.push(`   ${item.path}`)
    if (item.snippet) lines.push(`   ${oneLine(item.snippet)}`)
    if (item.why) lines.push(`   why: ${oneLine(item.why, 180)}`)
    if (item.reasons?.length) lines.push(`   reason: ${oneLine(item.reasons.slice(0, 2).join("; "), 180)}`)
  }
  return lines
}

function renderAskSearchText(result) {
  const calls = result.modelCalls ?? {}
  const lines = [
    `查询：${result.query}`,
    `检索：${result.backend} / ${result.preset}`,
    `模型：计划 ${calls.planner ? "是" : "否"}，路由 ${calls.sourceRouter ? "是" : "否"}，重排 ${calls.reranker ? "是" : "否"}，回答 ${calls.answer ? "是" : "否"}`,
  ]
  if (result.routeReason) lines.push(`路由原因：${result.routeReason}`)
  if (result.plan) {
    lines.push(`意图：${result.plan.intent}`)
    lines.push(`来源：${result.plan.sources}`)
    if (result.plan.queries?.length) {
      lines.push("子查询：")
      for (const item of result.plan.queries.slice(0, 5)) lines.push(`- ${item.query}（${oneLine(item.reason, 120)}）`)
    }
    if (result.plan.expandedTerms?.length) lines.push(`扩展词：${result.plan.expandedTerms.slice(0, 18).join(" / ")}`)
    if (result.plan.rankingRules?.length) lines.push(`排序规则：${result.plan.rankingRules.slice(0, 4).map((item) => oneLine(item, 80)).join("；")}`)
  }
  const counts = result.counts ?? {}
  lines.push(`命中：wiki ${counts.wikiMatches ?? 0}，raw ${counts.rawMatches ?? 0}，graph ${counts.graphMatches ?? 0}，facts ${counts.factsMatches ?? 0}，brain ${counts.brainMatches ?? 0}，SQL ${counts.sqlRows ?? 0}`)
  if (result.sourceRouting?.selectedSources?.length) {
    const usable = result.sourceRouting.selectedSources.filter((item) => item.available).map((item) => item.id)
    if (usable.length) lines.push(`来源：${usable.join(" / ")}`)
  }
  if (result.rankedEvidence?.length) {
    lines.push(...renderHits(result.rankedEvidence, "证据排序", 10))
  } else {
    const sections = [
      ["wiki", "正式 wiki"],
      ["raw", "原始证据"],
      ["graph", "关联扩展"],
      ["facts", "时序事实"],
      ["invalidatedFacts", "失效事实"],
      ["brain", "运行记忆"],
      ["stockDaily", "行情数据"],
      ["navigation", "导航"],
    ]
    for (const [key, title] of sections) lines.push(...renderHits(result.results?.[key] ?? [], title))
  }
  if (result.evidenceGaps?.length) {
    lines.push("", "证据缺口")
    for (const gap of result.evidenceGaps.slice(0, 8)) lines.push(`- ${oneLine(gap, 180)}`)
  }
  if (result.warnings?.length) {
    lines.push("", "警告")
    for (const warning of result.warnings.slice(0, 8)) lines.push(`- ${oneLine(warning, 180)}`)
  }
  if (result.fallback) {
    lines.push("", `兜底：${result.fallback.stage} -> ${oneLine(result.fallback.reason, 180)}`)
  }
  lines.push("", result.tier === "tier2" ? "下一步：smart-search 只排序证据，不生成结论；需要正式回答时用 ask。" : "下一步：打开上面的路径阅读全文；检索片段只是线索，不等于正式结论。")
  lines.push("需要机器格式时加：--output json")
  return `${lines.join("\n").trimEnd()}\n`
}

function buildAskRetrievalArgs(args) {
  return {
    query: requireArg(args, "query"),
    projectPath: args.project,
    provider: args.provider ?? "codex",
    model: args.model,
    apiKey: args["api-key"],
    endpoint: args.endpoint,
    reasoningEffort: args["reasoning-effort"],
    codexBin: args["codex-bin"],
    codexProfile: args["codex-profile"],
    codexProfileV2: args["codex-profile-v2"],
    codexTimeoutMs: args["codex-timeout-ms"],
    preset: args.preset,
    topWiki: args["top-wiki"],
    topRaw: args["top-raw"],
    graphNeighbors: args["graph-neighbors"],
    graphDepth: args["graph-depth"],
    topFacts: args["top-facts"],
    topBrain: args["top-brain"],
    includeInvalidated: Boolean(args["include-invalidated"]),
    sourceK: args["source-k"],
    sources: args.sources,
    sqlLimit: args["sql-limit"],
    rawScanLimit: args["raw-scan-limit"],
    maxRawBytes: args["max-raw-bytes"],
  }
}

function printSearchResult(result, args) {
  if (args.output === "json") console.log(JSON.stringify(result, null, 2))
  else console.log(renderAskSearchText(result).trimEnd())
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  if (!command || args.help || command === "help") {
    printHelp()
    return
  }

  if (command === "prepare") {
    const result = await prepareIngest({
      sourcePath: requireArg(args, "source"),
      projectPath: args.project,
      schemaPath: args.schema,
      noReport: Boolean(args["no-report"]),
    })
    console.log(`Prepared ingest context for ${result.sourceRelativePath}`)
    console.log(`Source hash: ${result.sourceHash}`)
    console.log(`Report: ${result.reportDir}`)
    console.log(`Top wiki candidates: ${result.candidates.wikiCandidates.slice(0, 5).map((c) => c.path).join(", ") || "(none)"}`)
    return
  }

  if (command === "api-run") {
    const provider = args.provider ?? "openai"
    const result = await apiRunIngest({
      sourcePath: requireArg(args, "source"),
      projectPath: args.project,
      schemaPath: args.schema,
      provider,
      model: provider === "openai" ? requireArg(args, "model") : args.model,
      apiKey: args["api-key"],
      endpoint: args.endpoint,
      reasoningEffort: args["reasoning-effort"],
      codexBin: args["codex-bin"],
      codexProfile: args["codex-profile"],
      codexProfileV2: args["codex-profile-v2"],
      codexTimeoutMs: args["codex-timeout-ms"],
      pageConcurrency: args["page-concurrency"],
      maxPlanItems: args["max-plan-items"],
      maxCreatePages: args["max-create-pages"],
      maxUpdatePages: args["max-update-pages"],
    })
    console.log(`Generated staged ingest artifacts:`)
    console.log(`Analysis: ${result.analysisPath}`)
    console.log(`Plan: ${result.planJsonPath}`)
    console.log(`Files: ${result.filesDir}`)
    console.log(`Manifest: ${result.manifestPath}`)
    console.log(`Dry-run report: ${result.dryRunReport.reportPath}`)
    return
  }

  if (command === "finalize") {
    const provider = args.provider ?? "codex"
    const result = await finalizeStagedIngest({
      reportDir: requireArg(args, "report"),
      projectPath: args.project,
      provider,
      model: provider === "openai" ? requireArg(args, "model") : args.model,
      apiKey: args["api-key"],
      endpoint: args.endpoint,
      reasoningEffort: args["reasoning-effort"],
      codexBin: args["codex-bin"],
      codexProfile: args["codex-profile"],
      codexProfileV2: args["codex-profile-v2"],
      codexTimeoutMs: args["codex-timeout-ms"],
    })
    console.log(`Finalized staged ingest artifacts:`)
    console.log(`Files: ${result.filesDir}`)
    console.log(`Manifest: ${result.manifestPath}`)
    console.log(`Dry-run report: ${result.dryRunReport.reportPath}`)
    return
  }

  if (command === "apply") {
    const result = await applyManifest({
      manifestPath: path.resolve(requireArg(args, "manifest")),
      projectPath: args.project,
      write: Boolean(args.write),
      allowSourceChange: Boolean(args["allow-source-change"]),
    })
    console.log(result.dryRun ? "Dry-run complete." : "Write complete.")
    console.log(`Report: ${result.reportPath}`)
    console.log(`Files ${result.dryRun ? "planned" : "written"}: ${result.diffs.map((d) => d.path).join(", ") || "(none)"}`)
    if (result.fatalIssues.length > 0) {
      console.log(`Fatal schema issues: ${result.fatalIssues.length}`)
      for (const issue of result.fatalIssues.slice(0, 10)) {
        console.log(`- ${issue.path} [${issue.field}] ${issue.message}`)
      }
    }
    return
  }

  if (command === "hygiene") {
    const result = await runHygiene({
      action: args._[1] ?? "audit",
      projectPath: args.project,
      keepDays: args["keep-days"],
      write: Boolean(args.write),
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === "temporal-facts") {
    const subcommand = args._[1] ?? "audit"
    if (subcommand !== "audit") throw new Error("Unknown temporal-facts command. Use audit.")
    const result = await runTemporalFactsAudit({
      projectPath: args.project,
      topN: args["top-n"],
      write: Boolean(args.write),
    })
    if (args.write) {
      console.log(`Temporal facts audit written.`)
      console.log(`Markdown: ${result.outputs.markdown}`)
      console.log(`JSON: ${result.outputs.json}`)
      console.log(`Predicate candidates: ${result.counts.predicateCandidates}`)
      console.log(`Alias candidates: ${result.counts.aliasCandidates}`)
      console.log(`Alias conflicts: ${result.counts.aliasConflicts}`)
      console.log(`Curated alias rulings: ${result.counts.curatedAliasRulings}`)
      console.log(`Tag candidates: ${result.counts.tagCandidates}`)
      console.log(`Abbreviation candidates: ${result.counts.abbreviationCandidates}`)
      console.log(`Concept hierarchy rules: ${result.counts.conceptHierarchyRules}`)
      return
    }
    console.log(JSON.stringify({
      schema: result.schema,
      generatedAt: result.generatedAt,
      projectPath: result.projectPath,
      counts: result.counts,
      predicateCandidates: result.predicateCandidates.slice(0, 20),
      aliasCandidates: result.aliasCandidates.slice(0, 20),
      aliasConflicts: result.aliasConflicts.slice(0, 20),
      curatedAliasRulings: result.curatedAliasRulings.slice(0, 20),
      tagCandidates: result.tagCandidates.slice(0, 20),
      abbreviationCandidates: result.abbreviationCandidates.slice(0, 20),
      conceptHierarchyRules: result.conceptHierarchyRules,
    }, null, 2))
    return
  }

  if (command === "brain") {
    const subcommand = args._[1]
    if (subcommand === "remember") {
      const result = await rememberBrainMemory({
        projectPath: args.project,
        type: requireArg(args, "type"),
        text: requireArg(args, "text"),
        title: args.title,
        status: args.status,
        source: args.source,
        tags: args.tags,
        related: args.related,
      })
      console.log(`Remembered brain memory: ${result.record.id}`)
      console.log(`File: ${result.relativePath}`)
      return
    }
    if (subcommand === "status") {
      const result = await getBrainStatus({ projectPath: args.project })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    if (subcommand === "resolve") {
      const result = await resolveBrainMemory({
        projectPath: args.project,
        id: requireArg(args, "id"),
        result: requireArg(args, "result"),
        note: args.note,
      })
      console.log(`Resolved brain memory: ${result.record.targetId} -> ${result.record.result}`)
      console.log(`Event: ${result.record.id}`)
      console.log(`File: ${result.relativePath}`)
      return
    }
    throw new Error("Unknown brain command. Use remember, status, or resolve.")
  }

  if (command === "market-validate") {
    const result = await marketValidatePrediction({
      projectPath: args.project,
      prediction: requireArg(args, "prediction"),
      stock: requireArg(args, "stock"),
      window: args.window,
      write: Boolean(args.write),
      sqlLimit: args["sql-limit"],
    })
    console.log(JSON.stringify({
      dryRun: result.dryRun,
      query: result.query,
      verdict: result.record.verdict,
      reason: result.record.reason,
      stockCode: result.record.stockCode,
      marketValidation: result.marketValidation,
      writeResult: result.writeResult ? { relativePath: result.writeResult.relativePath } : null,
    }, null, 2))
    return
  }

  if (command === "company-research") {
    const result = await runCompanyResearch({
      projectPath: args.project,
      stock: requireArg(args, "stock"),
      from: args.from,
      to: args.to,
      reportId: args["report-id"],
      deep: Boolean(args.deep),
      cninfoDownloadLimit: args["cninfo-download-limit"],
      cninfoDownloadTimeoutMs: args["cninfo-download-timeout-ms"],
      cninfoEventFrom: args["cninfo-event-from"],
      cninfoPeriodicFrom: args["cninfo-periodic-from"],
      sseTimeoutMs: args["sse-timeout-ms"],
      ssePageSize: args["sse-page-size"],
      disableSseFallback: Boolean(args["disable-sse-fallback"]),
      topWiki: args["top-wiki"],
      topRaw: args["top-raw"],
      graphNeighbors: args["graph-neighbors"],
      graphDepth: args["graph-depth"],
      sqlLimit: args["sql-limit"],
    })
    console.log(JSON.stringify({
      mode: result.mode,
      generatedAt: result.generatedAt,
      company: result.company,
      outputDir: result.outputDir,
      providers: result.providers,
      deep: result.deep,
      outputs: {
        report: result.outputs.report,
        modelXlsx: result.outputs.modelXlsx,
        evidenceLedger: result.outputs.evidenceLedger,
        wikiCandidates: result.outputs.wikiCandidates,
        deepReport: result.outputs.deepReport,
        deepModelXlsx: result.outputs.deepModelXlsx,
        documentExtract: result.outputs.documentExtract,
        businessBreakdown: result.outputs.businessBreakdown,
        financialModelV2Xlsx: result.outputs.financialModelV2Xlsx,
        financialModelV2Json: result.outputs.financialModelV2Json,
        financialModelV2Template: result.outputs.financialModelV2Template,
        deepChecklist: result.outputs.deepChecklist,
        deepQualityAudit: result.outputs.deepQualityAudit,
        runSummary: result.outputs.runSummary,
      },
      writePolicy: result.writePolicy,
    }, null, 2))
    return
  }

  if (command === "daily-loop") {
    const result = await runDailyLoop({
      projectPath: args.project,
      provider: args.provider ?? "codex",
      model: args.model,
      reasoningEffort: args["reasoning-effort"],
      codexBin: args["codex-bin"],
      codexProfile: args["codex-profile"],
      codexProfileV2: args["codex-profile-v2"],
      codexTimeoutMs: args["codex-timeout-ms"],
      mode: args.mode,
      questionCount: args["question-count"],
      lookbackDays: args["lookback-days"],
      maxStocksPerQuestion: args["max-stocks-per-question"],
      maxExistingValidations: args["max-existing-validations"],
      validationWindows: args["validation-windows"],
      marketValidate: args["market-validate"],
      sourceK: args["source-k"],
      topWiki: args["top-wiki"],
      topRaw: args["top-raw"],
      topBrain: args["top-brain"],
      graphNeighbors: args["graph-neighbors"],
      graphDepth: args["graph-depth"],
      sqlLimit: args["sql-limit"],
      validatePendingOnly: Boolean(args["validate-pending-only"]),
      write: Boolean(args.write),
      showContext: Boolean(args["show-context"]),
    })
    if (args["show-context"]) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    console.log(JSON.stringify({
      dryRun: result.dryRun,
      mode: result.mode,
      runId: result.runId,
      counts: result.counts,
      sql: result.sql,
      marketValidation: result.marketValidation,
      questionPlanner: result.questionPlanner,
      report: result.reportRelativePath,
      feedback: result.feedbackRelativePath,
      selfTrainingActions: result.selfTraining?.actions?.length ?? null,
    }, null, 2))
    return
  }

  if (command === "self-train") {
    const result = await runSelfTraining({
      projectPath: args.project,
      write: Boolean(args.write),
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === "export-samples") {
    const result = await exportTrainingSamples({
      projectPath: args.project,
      kind: requireArg(args, "kind"),
    })
    console.log(`Exported ${result.count} ${result.kind} samples`)
    console.log(`File: ${result.relativePath}`)
    return
  }

  if (command === "search" || command === "retrieve") {
    const result = await runAskSearch(buildAskRetrievalArgs(args))
    printSearchResult(result, args)
    return
  }

  if (command === "smart-search") {
    const result = await runAskSmartSearch({
      ...buildAskRetrievalArgs(args),
      llmRerank: !args["no-llm-rerank"],
      fallback: !args["no-fallback"],
      topRanked: args["top-ranked"],
    })
    printSearchResult(result, args)
    return
  }

  if (command === "ask" || command === "query") {
    if (args._[1] === "eval") {
      const result = await runAskEval({
        query: args.query,
        projectPath: args.project,
        sources: args.sources,
        topWiki: args["top-wiki"],
        topRaw: args["top-raw"],
        graphNeighbors: args["graph-neighbors"],
        graphDepth: args["graph-depth"],
        topFacts: args["top-facts"],
        topBrain: args["top-brain"],
        includeInvalidated: Boolean(args["include-invalidated"]),
        sourceK: args["source-k"],
        sqlLimit: args["sql-limit"],
        expectedPaths: args["expect-paths"] ?? args.expect,
        write: Boolean(args.write),
      })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    const result = await askWiki({
      query: requireArg(args, "query"),
      projectPath: args.project,
      provider: args.provider ?? "codex",
      model: args.model,
      apiKey: args["api-key"],
      endpoint: args.endpoint,
      reasoningEffort: args["reasoning-effort"],
      codexBin: args["codex-bin"],
      codexProfile: args["codex-profile"],
      codexProfileV2: args["codex-profile-v2"],
      codexTimeoutMs: args["codex-timeout-ms"],
      topWiki: args["top-wiki"],
      topRaw: args["top-raw"],
      graphNeighbors: args["graph-neighbors"],
      graphDepth: args["graph-depth"],
      topFacts: args["top-facts"],
      topBrain: args["top-brain"],
      includeInvalidated: Boolean(args["include-invalidated"]),
      sourceK: args["source-k"],
      sources: args.sources,
      sqlLimit: args["sql-limit"],
      rawScanLimit: args["raw-scan-limit"],
      maxRawBytes: args["max-raw-bytes"],
      showContext: Boolean(args["show-context"] || args["show-sources"]),
    })
    if (args["show-context"] || args["show-sources"]) {
      const compact = {
        query: result.query,
        projectPath: result.projectPath,
        generatedAt: result.generatedAt,
        retrievalMode: result.retrievalMode,
        tokens: result.tokens,
        counts: result.counts,
        sourceRouting: {
          mode: result.sourceRouting.route.mode,
          sourceK: result.sourceRouting.route.sourceK,
          selectedSources: result.sourceRouting.selectedSources.map(({ id, label, kind, nativeLanguage, available, ruleScore, routeReason, unavailableReason, config, columns }) => ({
            id,
            label,
            kind,
            nativeLanguage,
            available,
            ruleScore,
            routeReason,
            unavailableReason,
            config,
            columns: columns
              ? {
                  ticker: columns.ticker,
                  date: columns.date,
                  open: columns.open,
                  high: columns.high,
                  low: columns.low,
                  close: columns.close,
                  volume: columns.volume,
                  amount: columns.amount,
                  pctChange: columns.pctChange,
                }
              : undefined,
          })),
          rules: result.sourceRouting.route.rules,
          llmRanking: result.sourceRouting.route.llmRanking,
          warnings: result.sourceRouting.route.warnings,
        },
        nativeQueries: result.nativeQueries,
        retrievalWarnings: result.retrievalWarnings,
      }
      if (args["show-sources"] && !args["show-context"]) {
        console.log(JSON.stringify(compact, null, 2))
        return
      }
      Object.assign(compact, {
        navigation: result.navigation.map(({ ref, path, title, score, snippet }) => ({ ref, path, title, score, snippet })),
        wikiResults: result.wikiResults.map(({ ref, path, title, score, type, frontmatterMatches, frontmatterUpdated, frontmatterUpdatedField, staleDays, freshnessScore, snippet }) => ({
          ref,
          path,
          title,
          score,
          type,
          frontmatterMatches,
          frontmatterUpdated,
          frontmatterUpdatedField,
          staleDays,
          freshnessScore,
          snippet,
        })),
        rawResults: result.rawResults.map(({ ref, path, title, score, structuredSourceMatch, frontmatterUpdated, frontmatterUpdatedField, staleDays, freshnessScore, snippet }) => ({
          ref,
          path,
          title,
          score,
          structuredSourceMatch,
          frontmatterUpdated,
          frontmatterUpdatedField,
          staleDays,
          freshnessScore,
          snippet,
        })),
        graphExpansions: result.graphExpansions.map(({ ref, path, title, score, graphScore, type, hop, pathTrace, relationType, reasons, from, snippet }) => ({
          ref,
          path,
          title,
          score,
          graphScore,
          type,
          hop,
          pathTrace,
          relationType,
          reasons,
          from,
          snippet,
        })),
        factsResults: result.factsResults.map(({ ref, path, title, score, type, excerpt, nativeQuery }) => ({ ref, path, title, score, type, excerpt, nativeQuery })),
        invalidatedFactsResults: result.invalidatedFactsResults.map(({ ref, path, title, score, type, temporalStatus, statusReason, excerpt, nativeQuery }) => ({
          ref,
          path,
          title,
          score,
          type,
          temporalStatus,
          statusReason,
          excerpt,
          nativeQuery,
        })),
        brainResults: result.brainResults.map(({ ref, path, title, score, type, excerpt, nativeQuery }) => ({ ref, path, title, score, type, excerpt, nativeQuery })),
        stockDaily: {
          status: result.stockDaily.status,
          intent: result.stockDaily.intent,
          warning: result.stockDaily.warning,
          nativeQuery: result.stockDaily.nativeQuery
            ? {
                language: result.stockDaily.nativeQuery.language,
                summary: result.stockDaily.nativeQuery.summary,
                table: result.stockDaily.nativeQuery.table,
                limit: result.stockDaily.nativeQuery.limit,
                tickerCandidates: result.stockDaily.nativeQuery.tickerCandidates,
              }
            : null,
        },
        marketValidation: result.marketValidation,
        stockDailyResults: result.stockDailyResults.map(({ ref, path, title, score, type, excerpt, nativeQuery }) => ({ ref, path, title, score, type, excerpt, nativeQuery })),
      })
      console.log(JSON.stringify(compact, null, 2))
      return
    }
    console.log(result.answer.trim())
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
