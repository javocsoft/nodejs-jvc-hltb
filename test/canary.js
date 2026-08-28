/**
 * jvc-hltb canary
 *
 * Checks the library against the LIVE HowLongToBeat site. Its job is to notice
 * when HLTB changes something on their side - which has happened four times so
 * far, each time silently - rather than to test our own logic (see
 * `npm test` for that).
 *
 * It writes a Markdown report to canary-report.md so CI can paste it into an
 * issue, and exits non-zero only when the breakage looks real.
 *
 * Usage: npm run canary
 */

const fs = require('fs');
const path = require('path');
const HLTBClient = require('../src/index');

// Game IDs are stable; completion times drift with every community submission,
// so we assert on the id and only report the times for context.
const REFERENCE_GAMES = [
  { name: 'Deadly Towers', gameId: 2356 },
  { name: "Castlevania III: Dracula's Curse", gameId: 1573 },
  { name: 'Mega Man', gameId: 5803 }
];

const REPORT_PATH = path.join(__dirname, '..', 'canary-report.md');

async function main() {
  const client = new HLTBClient();
  const rows = [];
  let captured = null;

  try {
    // Distinguish "we never got credentials" from "the search itself failed":
    // the first almost always means they moved the route again.
    captured = await client._getCredentials();

    for (const game of REFERENCE_GAMES) {
      let status;
      let detail = '';
      try {
        const duration = captured ? await client.getGameDuration(game.name) : null;
        if (!duration) {
          status = 'no-data';
        } else if (duration.gameId !== game.gameId) {
          status = 'wrong-id';
          detail = `got id ${duration.gameId}, expected ${game.gameId}`;
        } else {
          status = 'ok';
          detail = `main ${duration.mainStory ?? 'n/a'} h, plus ${duration.mainExtras ?? 'n/a'} h`;
        }
      } catch (error) {
        status = 'error';
        detail = error.message;
      }
      rows.push({ game: game.name, status, detail });
    }
  } finally {
    await client.destroy();
  }

  const ok = rows.filter(r => r.status === 'ok').length;
  const total = rows.length;

  // Only shout when it is really broken. A single game going missing is data
  // drift on their side, not an API change, and must not cry wolf every week.
  let verdict;
  if (!captured) {
    verdict = {
      broken: true,
      headline: 'Could not capture credentials from HowLongToBeat',
      hint: 'Most likely they moved the search route again. See the '
        + '"If HLTB moves the search route again" section in the README.'
    };
  } else if (ok === 0) {
    verdict = {
      broken: true,
      headline: 'Credentials were captured, but no reference game resolved',
      hint: 'The route still works but the request or response contract changed. '
        + 'Compare the payload built in src/index.js against the site\'s own fetch call.'
    };
  } else if (ok < total) {
    verdict = {
      broken: false,
      headline: `${ok}/${total} reference games resolved`,
      hint: 'Probably data drift on HLTB (a game renamed or merged), not an API change. '
        + 'Worth a look, but the library still works.'
    };
  } else {
    verdict = { broken: false, headline: `All ${total} reference games resolved`, hint: '' };
  }

  const report = [
    `**${verdict.headline}**`,
    '',
    `Checked \`${new Date().toISOString()}\` against <https://howlongtobeat.com>.`,
    '',
    '| Game | Status | Detail |',
    '| --- | --- | --- |',
    ...rows.map(r => `| ${r.game} | \`${r.status}\` | ${r.detail || '-'} |`),
    '',
    verdict.hint
  ].join('\n');

  fs.writeFileSync(REPORT_PATH, report + '\n');

  console.log('='.repeat(64));
  console.log(report);
  console.log('='.repeat(64));

  if (verdict.broken) {
    console.error('\n❌ Canary failed');
    process.exitCode = 1;
  } else {
    console.log('\n✅ Canary passed');
  }
}

main().catch(error => {
  console.error('❌ Canary crashed:', error.stack || error.message);
  fs.writeFileSync(REPORT_PATH,
    `**The canary itself crashed**\n\n\`\`\`\n${error.stack || error.message}\n\`\`\`\n`);
  process.exitCode = 1;
});
