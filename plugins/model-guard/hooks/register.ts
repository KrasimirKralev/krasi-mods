import type { PluginOptions, Register } from 'claude-code';

// Two settings pick a subagent's model:
//   `default` answers a call that names no model (leaves `model` out, or passes `inherit`);
//   `rules`   answer a call that names one: the first rule whose `match` fits decides.
// Left empty, both pass every spawn through exactly as Claude Code would run it.
//
// A fork always runs on the main model (Claude Code ignores `model` for a fork), so the
// only choice for one is to let it start or refuse it. Claude Code lets a hook only refuse a
// workflow script's agents, never change them, so they pass through untouched.

type Rule = { readonly match: RegExp; readonly model: string };

type Config = {
  readonly fallback: string;
  readonly rules: readonly Rule[];
  readonly denyForks: boolean;
  readonly problem?: string;
};

const FORK_DENIED =
  'model-guard refuses forks here (its forks setting is deny): a fork always runs on the main model. ' +
  'Start a regular subagent instead, naming a model if it needs one.';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const namesNoModel = (requested: string | undefined): boolean => {
  const name = text(requested).toLowerCase();
  return name === '' || name === 'inherit';
};

// All or nothing: one broken rule turns every rule off, because skipping just that one
// would let a later catch-all take the requests it was meant to answer.
const parseRules = (raw: string): { rules: Rule[]; problem?: string } => {
  if (text(raw) === '') return { rules: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rules: [], problem: 'rules is not valid JSON, so no rule applies' };
  }
  if (!Array.isArray(parsed)) {
    return { rules: [], problem: 'rules must be a JSON array of {"match", "model"} objects, so no rule applies' };
  }
  const rules: Rule[] = [];
  for (const [index, entry] of parsed.entries()) {
    const where = `rule ${index + 1}`;
    const isObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry);
    const fields: Record<string, unknown> = isObject ? entry : {};
    const match = text(fields.match);
    const model = text(fields.model);
    if (match === '' || model === '') {
      return { rules: [], problem: `${where} needs a non-empty "match" and "model", so no rule applies` };
    }
    try {
      rules.push({ match: new RegExp(match, 'i'), model });
    } catch {
      return { rules: [], problem: `${where} has a "match" that is not a valid regular expression, so no rule applies` };
    }
  }
  return { rules };
};

const readConfig = (options: PluginOptions): Config => {
  const { rules, problem } = parseRules(text(options.rules));
  return { fallback: text(options.default), rules, denyForks: options.forks === 'deny', problem };
};

// The model to hand the spawn, or undefined to leave it exactly as it was.
const pick = (config: Config, requested: string | undefined): string | undefined => {
  if (namesNoModel(requested)) return config.fallback === '' ? undefined : config.fallback;
  return config.rules.find(rule => rule.match.test(text(requested)))?.model;
};

// No .catch on the spawn hook: should it ever fail, the spawn goes ahead as Claude Code
// would run it, which is the safe side for a router.
export const register: Register = (on, options) => {
  const config = readConfig(options);

  if (config.problem !== undefined) {
    on('session.start', ($, e, next) => {
      $.ui.log(`model-guard: ${config.problem}. Fix it in /config.`);
      return next(e);
    });
  }

  on('agent.spawn', ($, e, next) => {
    if (e.workflow) return next(e);
    if (e.fork) return config.denyForks ? { deny: FORK_DENIED } : next(e);
    const model = pick(config, e.model);
    return model === undefined ? next(e) : next({ ...e, model });
  });
};
