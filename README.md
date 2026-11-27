# sidenote

Read papers side by side with Claude. Select any passage, figure or table and ask about it.

![sidenote demo: select a passage and ask, then box a figure and ask](docs/demo.gif)

You can also ask from the terminal. Your library, conversations, highlights and reading position are saved.

The only requirement is [Claude Code](https://claude.com/claude-code), signed in. `sidenote` uses
your Claude Code login, so it needs no API key.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/themid6t/sidenote/main/install.sh | sh
```

On Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/themid6t/sidenote/main/install.ps1 | iex
```

## Use

```sh
sidenote 1706.03762               # add an arXiv paper (or a PDF path or URL) and open the reader
sidenote ls                       # your library
sidenote open attention           # reopen by any part of the title
sidenote ask attention "what is multi-head attention for?"   # answer streams in the terminal
sidenote history attention        # the whole conversation
sidenote new attention            # fresh chat; the old one is archived in the paper's chats/ folder
sidenote rm attention
```

In the reader:

- **Ask about text:** select it, then type a question.
- **Explain a passage:** select it and press `E`.
- **Figures and tables:** press `R` (or click **Region**) and drag a box over the figure or table.
- **Find a past question:** click a past question's quote to jump to its highlight, or click a highlight to jump to the conversation.

The terminal and the reader share one conversation per paper.

## How it works

- **The binary:** one self-contained file holds the CLI, a local web server and the reader UI (pdf.js).
- **The server:** it listens on `127.0.0.1` only. A random token is set per run, and it rejects foreign Host and Origin headers.
- **Questions:** each paper gets one live Claude Code session, started in the paper's folder and kept running while you read. It is a normal session: your tools, settings, hooks, `CLAUDE.md` and MCP servers all apply. Whenever Claude wants to do something that would normally ask for permission, an Allow / Deny card shows the exact command in the chat (or a y/N prompt in the terminal). sidenote always starts the session in the asking mode, even if your default is to bypass permissions, because a PDF is untrusted input. Anything your settings already allow runs without a card. After 30 minutes idle the process closes, and the next question resumes it. If the session can't be resumed, a new one starts with the saved history.
- **Your data:** it is plain files in `~/.local/share/sidenote` (`%APPDATA%\sidenote` on Windows). Each paper has its own folder with the PDF, its text, `meta.json`, `messages.json` and `highlights.json`. Set `SIDENOTE_HOME` to move it, or `SIDENOTE_MODEL` to choose a model.

## Develop

Development needs Node 24+ and pnpm; building the binaries also needs [Bun](https://bun.sh).

```sh
pnpm install
pnpm dev ls             # run from source
pnpm compile            # dist/sidenote-{linux,darwin}-{x64,arm64}, dist/sidenote-windows-x64.exe
pnpm e2e                # real binary + real browser + real Claude answers (~2 min)
```

## License

MIT, see [LICENSE](LICENSE).
