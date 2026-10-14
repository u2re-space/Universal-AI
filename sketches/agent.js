import { createModelClient } from './models.js';
import { schemas, instructions } from './config.js';
import { runChecks, checksPassed, validateCheckIds, requiredCheckIds } from './runner.js';
import { createFsEngine } from './fs-engine.js';

const byteSize = (value) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const money = (tokens, rate) => tokens * rate / 1_000_000;
const message = (error) => error instanceof Error ? error.message : String(error);

/**
 * Native Responses transport lives in models-native.js behind models.js.
 * This gateway keeps role selection, reservation, and usage accounting local.
 * Reservations use a deliberately conservative byte-based input estimate plus
 * configurable overhead. This is NOT a provider-enforced billing cap.
 */
export function createModelGateway(config, { signal, emit = () => {} } = {}) {
  if (!process.env.OPENAI_API_KEY) throw new Error('Не задан OPENAI_API_KEY.');
  const client = createModelClient({
    timeoutMs: config.limits.apiTimeoutMs,
    maxRequestBytes: config.limits.maxRequestBytes,
  });
  const ledger = { calls: 0, accountedUsd: 0, reservedUsd: 0, knownUsd: 0,
    unknownCalls: 0, reservationExceeded: false, inputTokens: 0,
    cachedInputTokens: 0, outputTokens: 0 };

  const usage = () => ({ ...ledger, budgetUsd: config.limits.budgetUsd,
    remainingUsd: Math.max(0, config.limits.budgetUsd - ledger.accountedUsd - ledger.reservedUsd),
    note: 'Стоимость по доверенным тарифам; для неизвестного usage удержан резерв. Это не счёт провайдера.' });

  function getUsage(response) {
    const u = response?.usage;
    if (!u || !Number.isSafeInteger(u.input_tokens) || u.input_tokens < 0 ||
        !Number.isSafeInteger(u.output_tokens) || u.output_tokens < 0) return null;
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    if (!Number.isSafeInteger(cached) || cached < 0 || cached > u.input_tokens) return null;
    return { input: u.input_tokens, cached, output: u.output_tokens };
  }

  async function request(role, payload) {
    signal?.throwIfAborted();
    if (!Object.hasOwn(schemas, role)) throw new Error(`Неизвестная роль: ${role}`);
    if (ledger.unknownCalls || ledger.reservationExceeded) {
      throw new Error('Учёт расхода неполон либо резерв был превышен; дальнейшие API-вызовы остановлены.');
    }
    if (ledger.calls >= config.limits.maxModelCalls) throw new Error('Исчерпан лимит вызовов моделей.');
    const settings = config.models[role];
    const body = {
      model: settings.id, instructions: instructions[role],
      input: JSON.stringify(payload), store: false,
      max_output_tokens: settings.maxOutputTokens,
      text: { format: { type: 'json_schema', name: `agent_${role}`, strict: true, schema: schemas[role] } },
      stream: true,
    };
    const requestBytes = byteSize(body);
    if (requestBytes > config.limits.maxRequestBytes) {
      throw new Error(`Запрос ${role} превышает maxRequestBytes; сузьте задачу/контекст/логи.`);
    }
    const estimatedInputTokens = requestBytes + config.limits.inputTokenOverhead;
    const reservation = money(estimatedInputTokens, settings.inputUsdPerMillion) +
      money(settings.maxOutputTokens, settings.outputUsdPerMillion);
    if (ledger.accountedUsd + ledger.reservedUsd + reservation > config.limits.budgetUsd + 1e-12) {
      throw new Error(`Не хватает бюджета на резерв запроса ${role}: $${reservation.toFixed(6)}.`);
    }
    ledger.calls++;
    ledger.reservedUsd += reservation;
    let finalResponse, mayHaveBeenCharged = false, outputBytes = 0, lastProgress = 0;
    const report = (event) => { try { emit(event); } catch {} };
    try {
      report({ type: 'model.started', role, model: settings.id, call: ledger.calls,
        requestBytes, reservedUsd: reservation });
      finalResponse = await client.requestStructured({
        model: settings.id, instructions: instructions[role], payload,
        schema: schemas[role], schemaName: `agent_${role}`,
        maxOutputTokens: settings.maxOutputTokens, signal,
        emit: (event) => {
          if (event.type !== 'model.output.delta') return;
          outputBytes += byteSize(event.text);
          // Progress only; neither partial JSON nor private reasoning is printed.
          if (Date.now() - lastProgress > 1000) {
            report({ type: 'model.progress', role, outputBytes }); lastProgress = Date.now();
          }
        },
      });
      mayHaveBeenCharged = true;
      // Native transport has already parsed and locally validated this output.
      return JSON.parse(finalResponse.output_text);
    } catch (error) {
      finalResponse ??= error?.response;
      // A local preflight error is not charged. Dispatched requests without final
      // usage retain their reservation and block further calls, as before.
      mayHaveBeenCharged ||= Boolean(error?.unknownUsagePossible || getUsage(finalResponse));
      throw error;
    } finally {
      ledger.reservedUsd = Math.max(0, ledger.reservedUsd - reservation);
      const actual = getUsage(finalResponse);
      if (actual) {
        const actualUsd = money(actual.input - actual.cached, settings.inputUsdPerMillion) +
          money(actual.cached, settings.cachedInputUsdPerMillion) + money(actual.output, settings.outputUsdPerMillion);
        ledger.accountedUsd += actualUsd; ledger.knownUsd += actualUsd;
        ledger.inputTokens += actual.input; ledger.cachedInputTokens += actual.cached;
        ledger.outputTokens += actual.output;
        if (actualUsd > reservation + 1e-9 || ledger.accountedUsd > config.limits.budgetUsd + 1e-9) {
          ledger.reservationExceeded = true;
        }
      } else if (mayHaveBeenCharged) {
        // A dropped stream, aborted request or transport error is not assumed free.
        ledger.accountedUsd += reservation; ledger.unknownCalls++;
      }
      report({ type: 'model.completed', role, responseId: finalResponse?.id ?? null,
        outputBytes, usage: usage() });
    }
  }
  return { request, usage };
}

function compactChecks(results, budget = 48 * 1024) {
  const count = Math.max(1, results.length);
  const each = Math.max(0, Math.floor(budget / count) - 512);
  function clip(text, limit) {
    const data = Buffer.from(text ?? '', 'utf8');
    if (data.length <= limit) return data.toString('utf8');
    const half = Math.floor(limit / 2);
    return `${data.subarray(0, half).toString('utf8')}\n[log truncated]\n${data.subarray(data.length - half).toString('utf8')}`;
  }
  return results.map((r) => ({ id: r.id, status: r.status, exitCode: r.exitCode,
    durationMs: r.durationMs, error: r.error,
    stdout: clip(r.stdout, Math.floor(each / 2)), stderr: clip(r.stderr, Math.floor(each / 2)),
    outputTruncated: r.outputTruncated || byteSize(r.stdout ?? '') + byteSize(r.stderr ?? '') > each }));
}

/** Models propose; filesystem requests go through fs-engine to workspace. */
export async function runAgent({ task, config, workspace, signal, emit = () => {}, gateway }) {
  if (typeof task !== 'string' || !task.trim()) throw new Error('Задача пуста.');
  if (byteSize(task) > 32 * 1024) throw new Error('Задача превышает 32 KiB.');
  const models = gateway ?? createModelGateway(config, { signal, emit });
  const fsEngine = createFsEngine({ workspace, limits: config.limits, signal, emit,
    projectRoot: config.root });
  const contexts = new Map();
  let baseline = [], checks = [], plan = null, review = null, attempts = 0;
  let lastDiff = { files: [], text: '', truncated: false, bytes: 0 };
  const policy = {
    checks: Object.keys(config.checks), requiredChecks: requiredCheckIds(config),
    allowDelete: config.policy.allowDelete,
    limits: {
      maxChangedFilesPerAttempt: config.limits.maxChangedFilesPerAttempt,
      maxPatchBytesPerAttempt: config.limits.maxPatchBytesPerAttempt,
      maxReadBytesPerRequest: config.limits.maxReadBytesPerRequest,
      maxFileBytesWithoutApproval: config.limits.maxFileBytesWithoutApproval,
      maxContextBytesPerCall: config.limits.maxContextBytesPerCall,
    },
    operations: ['create_file', 'replace_text', 'delete_file'],
    note: 'Policy is immutable; test/configuration edits need human approval. Large-file approval never increases request/context limits.',
  };
  const context = () => [...contexts.values()];
  const result = (status, reason) => ({ status, reason, attempts, plan, review,
    baseline, checks, diff: lastDiff, usage: models.usage(), filesystem: fsEngine.stats() });

  async function collect(reads, searches) {
    if (reads.length > 20 || searches.length > 5) throw new Error('Слишком много запросов контекста.');
    const errors = [];
    for (const [kind, requests] of [['read', reads], ['search', searches]]) {
      for (const request of requests) {
        signal?.throwIfAborted();
        const key = kind === 'read'
          ? `read:${request.path}:${request.startLine}:${request.endLine}`
          : `search:${request.pathPrefix}:${request.query}`;
        const previous = contexts.get(key);
        contexts.delete(key);
        const remainingBytes = config.limits.maxContextBytesPerCall - byteSize(context()) - 2048;
        try {
          if (remainingBytes <= 0) throw new Error('Контекст заполнен; нужен более узкий запрос.');
          const data = kind === 'read'
            ? await fsEngine.request('read', request, { remainingBytes })
            : await fsEngine.request('search', request, { remainingBytes });
          contexts.set(key, { kind, request, data });
          if (byteSize(context()) > config.limits.maxContextBytesPerCall) {
            contexts.delete(key); throw new Error('Превышен общий размер контекста.');
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          if (previous) contexts.set(key, previous);
          errors.push({ kind, path: request.path ?? request.pathPrefix, error: message(error) });
          emit({ type: 'context.denied', kind, path: request.path ?? request.pathPrefix, reason: message(error) });
        }
      }
    }
    return errors;
  }

  async function refresh(changedPaths, changes) {
    const changed = new Set(changedPaths), requests = [];
    for (const [key, entry] of contexts) {
      if (entry.kind === 'search') { contexts.delete(key); continue; }
      if (!changed.has(entry.data.path)) continue;
      contexts.delete(key);
      if (changes.find((c) => c.path === entry.data.path)?.operation !== 'delete_file') requests.push(entry.request);
    }
    for (const change of changes) {
      if (change.operation === 'create_file') requests.push({ path: change.path, startLine: 1,
        endLine: 200, reason: 'Прочитать созданный файл для следующей проверки/попытки.' });
    }
    return collect(requests.slice(0, 20), []);
  }

  try {
    emit({ type: 'stage.started', stage: 'baseline' });
    baseline = await runChecks({ workspace, config, signal, emit, phase: 'baseline' });
    if (baseline.some((r) => ['error', 'timeout', 'cancelled'].includes(r.status))) {
      return result('blocked', 'Базовые проверки не удалось безопасно выполнить; исправьте окружение.');
    }
    emit({ type: 'stage.started', stage: 'planner' });
    plan = await models.request('planner', { task, tree: await fsEngine.request('tree'), policy,
      baseline: compactChecks(baseline) });
    validateCheckIds(plan.checks, config);
    emit({ type: 'plan.ready', summary: plan.summary, steps: plan.steps,
      acceptanceCriteria: plan.acceptanceCriteria });
    const initialErrors = await collect(plan.reads, plan.searches);
    let feedback = { issues: [], contextErrors: initialErrors };

    for (let attempt = 1; attempt <= config.limits.maxAttempts; attempt++) {
      signal?.throwIfAborted();
      attempts = attempt;
      review = null;
      let proposal, contextRounds = 0;
      for (;;) {
        emit({ type: 'stage.started', stage: 'coder', attempt, maxAttempts: config.limits.maxAttempts,
          contextRound: contextRounds });
        proposal = await models.request('coder', { task, plan, policy, tree: await fsEngine.request('tree'),
          context: context(), feedback, previousDiff: lastDiff,
          baseline: compactChecks(baseline), previousChecks: compactChecks(checks) });
        validateCheckIds(proposal.checks, config);
        if (proposal.reads.length || proposal.searches.length) {
          if (proposal.changes.length) throw new Error('Исполнитель смешал запрос контекста и изменения. Ничего не применено.');
          if (contextRounds >= config.limits.maxContextRoundsPerAttempt) {
            return result('blocked', 'Исчерпан лимит раундов контекста в попытке.');
          }
          contextRounds++;
          const contextErrors = await collect(proposal.reads, proposal.searches);
          feedback = { ...feedback, contextErrors };
          continue;
        }
        break;
      }
      emit({ type: 'patch.proposed', attempt, summary: proposal.summary, files: proposal.changes.length });
      let changed;
      try {
        const applied = await fsEngine.request('apply', { changes: proposal.changes });
        changed = applied.changedPaths;
      } catch (error) {
        if (signal?.aborted || workspace.broken) throw error;
        feedback = { issues: [{ severity: 'high', message: message(error),
          requestedChange: 'Исправить предложение, заново запросив актуальный контекст при необходимости.' }], contextErrors: [] };
        emit({ type: 'patch.rejected', attempt, reason: message(error) });
        continue;
      }
      lastDiff = await fsEngine.request('diff');
      if (lastDiff.truncated) return result('blocked', 'Diff превышает лимит: полноценная проверка и перенос запрещены.');
      const refreshErrors = await refresh(changed, proposal.changes);
      emit({ type: 'stage.started', stage: 'runner', attempt });
      checks = await runChecks({ workspace, config, ids: [...plan.checks, ...proposal.checks],
        signal, emit, phase: `attempt-${attempt}` });
      if (checks.some((r) => ['error', 'timeout', 'cancelled', 'skipped'].includes(r.status))) {
        return result('blocked', 'Не все проверки удалось выполнить; изменения не считаются проверенными.');
      }
      emit({ type: 'stage.started', stage: 'reviewer', attempt });
      review = await models.request('reviewer', { task, plan, policy, diff: lastDiff,
        context: context(), contextErrors: refreshErrors,
        baseline: compactChecks(baseline), checks: compactChecks(checks),
        requiredChecksPassed: checksPassed(checks, config) });
      emit({ type: 'review.completed', attempt, verdict: review.verdict,
        summary: review.summary, issues: review.issues, unverified: review.unverified });
      if (review.verdict === 'blocked') return result('blocked', review.summary);
      if (review.verdict === 'accept' && checksPassed(checks, config)) {
        const bill = models.usage();
        if (bill.unknownCalls || bill.reservationExceeded || bill.accountedUsd > config.limits.budgetUsd + 1e-9) {
          return result('blocked', 'Проверки пройдены, но учёт бюджета не позволяет принять результат автоматически.');
        }
        return result('accepted', review.summary);
      }
      feedback = { summary: review.summary, issues: review.issues,
        unverified: review.unverified, contextErrors: refreshErrors };
      if (!checksPassed(checks, config)) {
        feedback.issues = [...feedback.issues, { severity: 'high', path: null,
          message: 'Не все обязательные/запрошенные проверки прошли.',
          requestedChange: 'Исправить причину падения без ослабления тестов и повторить проверки.' }];
      }
    }
    return result('exhausted', 'Исчерпаны попытки. Результат не принят; изменения остались только в рабочей копии.');
  } catch (error) {
    // lastDiff was recorded immediately after edits, so cancellation can still show it.
    return result(signal?.aborted ? 'cancelled' : 'blocked', message(error));
  } finally {
    await fsEngine.close();
  }
}
