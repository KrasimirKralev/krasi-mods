import type { AgentSpawnInput, On, PluginOptions } from 'claude-code';
import { describe, expect, test } from 'claude-code/testing';

const SPAWN: AgentSpawnInput = {
  tool_use_id: 'toolu_test',
  prompt: 'do the task',
  description: 'task',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
};

type Seen = (string | undefined)[];

// Stands in for the engine: records the model each spawn reached it with.
const engine = (on: On): Seen => {
  const seen: Seen = [];
  on('agent.spawn', ($, e) => {
    seen.push(e.model);
    return { model: e.model ?? 'inherit', agentId: 'agent-test' };
  });
  return seen;
};

// Stands in for the session: answers its start and records what the plugin writes to
// the transcript.
const logs = (on: On): string[] => {
  const lines: string[] = [];
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('ui.log', ($, e) => {
    lines.push(e.text);
    return { value: undefined };
  });
  return lines;
};

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const;

// Each case: what the call asked for, and the model the engine should receive.
const expectRoutes = (name: string, options: PluginOptions, cases: [string | undefined, string | undefined][]) => {
  for (const [requested, expected] of cases) {
    test(`${name}: a spawn asking for ${requested ?? 'nothing'} reaches the engine as ${expected ?? 'nothing'}`,
      { options }, async ($, on) => {
        const seen = engine(on);
        await $.agent.spawn({ ...SPAWN, model: requested });
        expect(seen).toEqual([expected]);
      });
  }
};

describe('unconfigured', () => {
  expectRoutes('no settings', {}, [
    [undefined, undefined],
    ['inherit', 'inherit'],
    ['opus', 'opus'],
    ['claude-sonnet-5-5', 'claude-sonnet-5-5'],
    ['haiku', 'haiku'],
  ]);

  test('no settings: a fork goes ahead unchanged', async ($, on) => {
    const seen = engine(on);
    const result = await $.agent.spawn({ ...SPAWN, subagentType: 'fork', fork: true });
    expect(result.deny).toBeUndefined();
    expect(seen).toEqual([undefined]);
  });

  test('no settings: nothing is written to the transcript', async ($, on) => {
    const lines = logs(on);
    await $.session.start(START);
    expect(lines).toEqual([]);
  });
});

describe('default', () => {
  expectRoutes('default sonnet', { default: 'sonnet' }, [
    [undefined, 'sonnet'],
    ['inherit', 'sonnet'],
    ['INHERIT', 'sonnet'],
    ['opus', 'opus'],
    ['haiku', 'haiku'],
  ]);

  expectRoutes('default inherit', { default: 'inherit' }, [
    [undefined, 'inherit'],
    ['haiku', 'haiku'],
  ]);

  expectRoutes('default of spaces', { default: '   ' }, [
    [undefined, undefined],
    ['inherit', 'inherit'],
  ]);
});

describe('rules', () => {
  const rules = JSON.stringify([
    { match: 'haiku', model: 'sonnet' },
    { match: '^claude-opus-4', model: 'opus' },
    { match: '.*', model: 'opus' },
  ]);

  expectRoutes('ordered rules', { rules }, [
    ['haiku', 'sonnet'],
    ['claude-haiku-4-5', 'sonnet'],
    ['HAIKU', 'sonnet'],
    ['claude-opus-4-8', 'opus'],
    ['sonnet', 'opus'],
    // Rules answer only calls that name a model; these two are `default`'s.
    [undefined, undefined],
    ['inherit', 'inherit'],
  ]);

  expectRoutes('the first matching rule wins', {
    rules: JSON.stringify([
      { match: 'sonnet', model: 'claude-sonnet-5-5' },
      { match: 'sonnet', model: 'opus' },
    ]),
  }, [['sonnet', 'claude-sonnet-5-5']]);

  expectRoutes('a request no rule matches', { rules: '[{"match": "^haiku$", "model": "sonnet"}]' }, [
    ['claude-haiku-4-5', 'claude-haiku-4-5'],
    ['opus', 'opus'],
  ]);

  expectRoutes('default and rules together', {
    default: 'sonnet',
    rules: '[{"match": "haiku", "model": "sonnet"}, {"match": ".*", "model": "opus"}]',
  }, [
    [undefined, 'sonnet'],
    ['inherit', 'sonnet'],
    ['haiku', 'sonnet'],
    ['claude-sonnet-5-5', 'opus'],
  ]);

  expectRoutes('an empty array', { rules: '[]' }, [['haiku', 'haiku']]);
});

describe('a broken rules setting', () => {
  const broken: [string, string, RegExp][] = [
    ['not JSON', '[{"match": "haiku", "model": "sonnet"', /not valid JSON/],
    ['an object, not an array', '{"match": "haiku", "model": "sonnet"}', /must be a JSON array/],
    ['a rule without a model', '[{"match": "haiku", "model": "sonnet"}, {"match": "opus"}]', /rule 2 needs/],
    ['a rule that is a string', '["haiku"]', /rule 1 needs/],
    ['a bad regular expression', '[{"match": "haiku(", "model": "sonnet"}]', /rule 1 .* not a valid regular expression/],
  ];

  for (const [name, rules, says] of broken) {
    test(`${name}: no rule applies, the default still does`, { options: { rules, default: 'opus' } }, async ($, on) => {
      const seen = engine(on);
      await $.agent.spawn({ ...SPAWN, model: 'haiku' });
      await $.agent.spawn({ ...SPAWN, model: undefined });
      expect(seen).toEqual(['haiku', 'opus']);
    });

    test(`${name}: the session start says what is wrong`, { options: { rules } }, async ($, on) => {
      const lines = logs(on);
      await $.session.start(START);
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(says);
      expect(lines[0]).toMatch(/^model-guard: /);
    });
  }
});

describe('forks', () => {
  test('forks passthrough: a fork starts and its model is left alone, whatever the rules say',
    { options: { default: 'haiku', rules: '[{"match": ".*", "model": "haiku"}]' } }, async ($, on) => {
      const seen = engine(on);
      const result = await $.agent.spawn({ ...SPAWN, subagentType: 'fork', fork: true });
      expect(result.deny).toBeUndefined();
      expect(seen).toEqual([undefined]);
    });

  test('forks deny: a fork is refused and never reaches the engine', { options: { forks: 'deny' } }, async ($, on) => {
    const seen = engine(on);
    const result = await $.agent.spawn({ ...SPAWN, subagentType: 'fork', fork: true });
    expect(result.deny).toMatch(/refuses forks/);
    expect(seen).toEqual([]);
  });

  test('forks deny: a regular subagent still starts', { options: { forks: 'deny', default: 'sonnet' } }, async ($, on) => {
    const seen = engine(on);
    const result = await $.agent.spawn({ ...SPAWN });
    expect(result.deny).toBeUndefined();
    expect(seen).toEqual(['sonnet']);
  });
});

describe('other spawns', () => {
  // Claude Code ignores a hook's change to a workflow agent anyway; passing it through
  // keeps the plugin from tripping the engine's "`model` was ignored" line.
  test('a workflow agent runs as its script asked', { options: { default: 'sonnet', forks: 'deny' } }, async ($, on) => {
    const seen = engine(on);
    const result = await $.agent.spawn({ ...SPAWN, workflow: { runId: 'wf_test', agentIndex: 1 } });
    expect(result.deny).toBeUndefined();
    expect(seen).toEqual([undefined]);
  });

  test('a teammate follows the rules like any subagent', { options: { rules: '[{"match": "haiku", "model": "sonnet"}]' } },
    async ($, on) => {
      const seen = engine(on);
      await $.agent.spawn({ ...SPAWN, model: 'haiku', name: 'scout', isTeammate: true, background: true });
      expect(seen).toEqual(['sonnet']);
    });
});

// The recipes the README gives, word for word.
describe('README recipes', () => {
  expectRoutes('keep subagents off your main model unless they name one', { default: 'sonnet' }, [
    [undefined, 'sonnet'],
    ['inherit', 'sonnet'],
    ['opus', 'opus'],
  ]);

  expectRoutes('lift haiku requests to sonnet', { rules: '[{"match": "haiku", "model": "sonnet"}]' }, [
    ['haiku', 'sonnet'],
    ['claude-haiku-4-5', 'sonnet'],
    ['opus', 'opus'],
    [undefined, undefined],
  ]);
});
