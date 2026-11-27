// Stand-in for `claude -p --input-format stream-json`, so CI can test on every OS without an account.
import readline from 'node:readline';

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let turn = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type !== 'user') return;
  const text = `FAKE ANSWER turn=${++turn}`;
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text });
});
