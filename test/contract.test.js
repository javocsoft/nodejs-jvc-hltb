/**
 * Contract tests for jvc-hltb.
 *
 * These run offline and deterministically: they lock down the shape of the
 * request HowLongToBeat expects, and the behaviour that keeps a broken HLTB
 * from spawning a browser per lookup.
 *
 * They deliberately do NOT hit the network, so a HLTB outage cannot block a
 * release. For a real check against the live site use `npm run test:live`.
 *
 * Usage: npm test
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

const HLTBClient = require('../src/index');

const CREDS = { authToken: 'TOKEN123', hpKey: 'ign_0686331a', hpValue: 'abc123def4567890' };

/** Runs fn with the console silenced, so test output stays readable. */
async function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  const capture = (...args) => lines.push(args.join(' '));
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

describe('request contract', () => {
  const client = new HLTBClient();

  test('body carries a field NAMED after the rotating key (without it: 404)', () => {
    const payload = client._buildPayload('Deadly Towers', CREDS);
    assert.strictEqual(payload[CREDS.hpKey], CREDS.hpValue);
  });

  test('all three auth headers are sent (without x-hp-val: 403)', () => {
    const headers = client._buildHeaders(CREDS);
    assert.strictEqual(headers['x-auth-token'], CREDS.authToken);
    assert.strictEqual(headers['x-hp-key'], CREDS.hpKey);
    assert.strictEqual(headers['x-hp-val'], CREDS.hpValue);
  });

  test('User-Agent is the same one used to capture (it is inside the token)', () => {
    assert.strictEqual(client._buildHeaders(CREDS)['User-Agent'], client.userAgent);
  });

  test('searchTerms are the lowercased words of the title', () => {
    assert.deepStrictEqual(
      client._buildPayload('  Deadly   TOWERS ', CREDS).searchTerms,
      ['deadly', 'towers']
    );
  });

  test('body shape matches what the site sends', () => {
    const payload = client._buildPayload('x', CREDS);
    assert.strictEqual(payload.searchType, 'games');
    assert.strictEqual(payload.searchPage, 1);
    assert.strictEqual(payload.size, 20);
    assert.strictEqual(payload.useCache, true);
    assert.strictEqual(payload.searchOptions.games.sortCategory, 'popular');
    assert.strictEqual(payload.searchOptions.games.rangeCategory, 'main');
    assert.strictEqual(payload.searchOptions.users.sortCategory, 'postcount');
    assert.strictEqual(payload.searchOptions.lists.sortCategory, 'follows');
  });

  test('search route is the current one', () => {
    assert.strictEqual(client.searchPath, '/api/search/site');
  });
});

describe('time conversion', () => {
  const client = new HLTBClient();

  test('0 seconds means "no data", not "0 hours"', () => {
    assert.strictEqual(client.secondsToHours(0), null);
  });

  test('seconds are converted to hours with 2 decimals', () => {
    assert.strictEqual(client.secondsToHours(13757), 3.82);
    assert.strictEqual(client.secondsToHours(61200), 17);
  });

  test('durations are formatted for humans', () => {
    assert.strictEqual(client.formatDuration(12.5), '12h 30m');
    assert.strictEqual(client.formatDuration(8), '8h');
    assert.strictEqual(client.formatDuration(0), null);
  });
});

describe('failure cooldown', () => {
  test('ten failing searches launch exactly ONE browser', async () => {
    const client = new HLTBClient();
    let captures = 0;
    client._captureCredentials = async () => { captures++; return null; };

    const { lines } = await quiet(async () => {
      for (let i = 0; i < 10; i++) await client.searchGame('whatever');
    });

    assert.strictEqual(captures, 1, `expected 1 capture attempt, got ${captures}`);
    const warnings = lines.filter(l => l.includes('not retrying until'));
    assert.strictEqual(warnings.length, 1, 'the cooldown warning must be logged once, not per search');
  });

  test('searchGame returns null while the cooldown is open', async () => {
    const client = new HLTBClient();
    client._captureCredentials = async () => null;
    const { result } = await quiet(() => client.searchGame('whatever'));
    assert.strictEqual(result, null);
  });

  test('a successful capture clears a previous cooldown', async () => {
    const client = new HLTBClient();
    client.failureUntil = Date.now() - 1000; // expired
    client._captureCredentials = async () => CREDS;
    const { result } = await quiet(() => client._getCredentials());
    assert.deepStrictEqual(result, CREDS);
    assert.strictEqual(client.failureUntil, null);
  });
});

describe('stale credentials', () => {
  test('a 403 triggers exactly one recapture and retry', async (t) => {
    const client = new HLTBClient();
    let captures = 0;
    client._captureCredentials = async () => { captures++; return { ...CREDS }; };

    let calls = 0;
    t.mock.method(axios, 'post', async () => {
      calls++;
      if (calls === 1) {
        const error = new Error('Request failed with status code 403');
        error.response = { status: 403 };
        throw error;
      }
      return { data: { data: [{ game_id: 2356, game_name: 'Deadly Towers' }] } };
    });

    const { result } = await quiet(() => client.searchGame('Deadly Towers'));

    assert.strictEqual(calls, 2, 'should retry once');
    assert.strictEqual(captures, 2, 'should recapture credentials before retrying');
    assert.strictEqual(result[0].game_id, 2356);
  });

  test('a non-credential error is not retried', async (t) => {
    const client = new HLTBClient();
    client._captureCredentials = async () => ({ ...CREDS });

    let calls = 0;
    t.mock.method(axios, 'post', async () => {
      calls++;
      const error = new Error('Request failed with status code 500');
      error.response = { status: 500 };
      throw error;
    });

    const { result } = await quiet(() => client.searchGame('Deadly Towers'));

    assert.strictEqual(calls, 1, 'a 500 is a real error, not stale credentials');
    assert.strictEqual(result, null);
  });
});

describe('result matching', () => {
  const results = [
    { game_id: 1, game_name: 'Some Other Game', game_alias: '', comp_main: 100 },
    { game_id: 2356, game_name: 'Deadly Towers', game_alias: 'Mashou', comp_main: 13757, comp_plus: 61200, comp_100: 0 }
  ];

  function clientReturning(data) {
    const client = new HLTBClient();
    client.searchGame = async () => data;
    return client;
  }

  test('exact name match wins and fields are mapped to hours', async () => {
    const { result } = await quiet(() => clientReturning(results).getGameDuration('deadly towers'));
    assert.deepStrictEqual(result, {
      gameId: 2356,
      mainStory: 3.82,
      mainExtras: 17,
      completionist: null // comp_100 was 0: no data, not 0 hours
    });
  });

  test('alternative and regional titles match via game_alias', async () => {
    const { result } = await quiet(() => clientReturning(results).getGameDuration('Mashou'));
    assert.strictEqual(result.gameId, 2356);
  });

  test('a partial name is not accepted as a match', async () => {
    const { result } = await quiet(() => clientReturning(results).getGameDuration('Deadly'));
    assert.strictEqual(result, null);
  });

  test('no results yields null', async () => {
    const { result } = await quiet(() => clientReturning([]).getGameDuration('Nothing'));
    assert.strictEqual(result, null);
  });

  test('a disabled client does no work', async () => {
    const client = new HLTBClient({ enabled: false });
    client.searchGame = async () => { throw new Error('must not be called'); };
    const { result } = await quiet(() => client.getGameDuration('Deadly Towers'));
    assert.strictEqual(result, null);
  });
});
