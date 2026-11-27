// Stand-in for `claude -p --input-format stream-json`, so CI can test on every OS without an account.
// FAKE_ANSWER (a JSON array of chunks) scripts the answer: each chunk streams as a delta, 300 ms apart.
import readline from 'node:readline';

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const scripted = process.env.FAKE_ANSWER && JSON.parse(process.env.FAKE_ANSWER);
let turn = 0;
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (JSON.parse(line).type !== 'user') return;
  const chunks = scripted || [`FAKE ANSWER turn=${++turn}`];
  for (const text of chunks) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    if (scripted) await new Promise((r) => setTimeout(r, 300));
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: chunks.join('') });
});
