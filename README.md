# Local Dost 🤝

**A free, open-source AI coding agent for your terminal.**
It reads your code, edits files, runs your tests, and when one free AI provider hits its limit it **quietly switches to the next one**: no error screens, no interruptions.

```
 _     ___   ____    _    _        ____   ___  ____ _____
| |   / _ \ / ___|  / \  | |      |  _ \ / _ \/ ___|_   _|
| |  | | | | |     / _ \ | |      | | | | | | \___ \ | |
| |__| |_| | |___ / ___ \| |___   | |_| | |_| |___) || |
|_____\___/ \____/_/   \_\_____|  |____/ \___/|____/ |_|
```

- **100% free to use.** MIT licensed, zero dependencies, no server, no account with us. You bring free API keys from the providers below.
- **Never stops on a rate limit.** Groq → Gemini → Cerebras → OpenRouter → Mistral → NVIDIA → local Ollama. When a provider runs out, the next one takes over mid-task. If *everything* is resting, it waits and resumes by itself.
- **Does real work in your project.** Read, search, edit (with diffs), create files, run commands. It asks before changing anything, and `/undo` reverts the last change.
- **Runs on your machine.** Your code only goes to the AI provider you configured. Nothing goes through us.

---

## Install

**macOS / Linux / WSL**

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/local-dost/main/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/local-dost/main/install.ps1 | iex
```

**Or with npm**

```bash
npm install -g github:YOUR_GITHUB_USERNAME/local-dost
```

Requires **Node.js 18+** ([nodejs.org](https://nodejs.org)). Nothing else.

## First run

```bash
cd your-project
localdost          # or the short alias:  dost
```

The first run asks you to paste free API keys. **Add 2–3**; that's what makes switching seamless.

| Provider | Free key | Notes |
|---|---|---|
| **Groq** | https://console.groq.com/keys | Very fast. Strong default. |
| **Google Gemini** | https://aistudio.google.com/apikey | Generous limits, large context. |
| **Cerebras** | https://cloud.cerebras.ai | Fast open models. |
| **OpenRouter** | https://openrouter.ai/keys | Has `:free` models. |
| **Mistral** | https://console.mistral.ai/api-keys | Free "experiment" tier. |
| **NVIDIA NIM** | https://build.nvidia.com | Free credits / dev tier. |
| **Ollama** (local) | https://ollama.com | Auto-detected, **unlimited**, fully offline. Great last-resort backup. |

Keys are stored in `~/.localdost/config.json` (owner-only permissions). Environment variables such as `GROQ_API_KEY` also work. See [`.env.example`](.env.example).

Check everything works: `localdost doctor`

## Using it

Just talk to it, in English, Hindi, Hinglish, whatever you like:

```
❯ add input validation to signup.js and run the tests
❯ yeh function slow hai, optimize kar do
❯ explain how auth works in this project
```

It shows a diff and asks before each edit or command:

```
╭ Edit src/signup.js
│ - if (email) {
│ + if (email && EMAIL_RE.test(email)) {
╰ Allow? [y]es · [a]lways this session · [n]o ›
```

### Commands

| Command | What it does |
|---|---|
| `/help` | list commands |
| `/providers` | show providers, models and who is ready / resting |
| `/keys` | add or change API keys |
| `/model groq` or `/model groq/<model>` | prefer a provider/model first (others stay as backup) |
| `/models <provider>` | list the models a provider offers |
| `/yolo` | toggle auto-approve for edits & commands (dangerous commands always ask) |
| `/undo` | undo the last file change |
| `/init` | let the AI write `LOCALDOST.md` (project notes it reads every session) |
| `/clear` | reset the conversation |
| `!git status` | run a shell command yourself |
| `Ctrl+C` | interrupt the current task (twice at the prompt to exit) |

### One-shot / scripting

```bash
localdost -p "write a .gitignore for this node project" --yolo
```

Without `--yolo`, non-interactive runs **deny** edits and commands instead of hanging.

## How the automatic switching works

1. Providers are tried in your order; the last one that worked is kept so a task stays consistent.
2. On a rate limit, quota error, server error, timeout, or bad key, that **model** rests (for as long as the provider says, e.g. `retry-after`) and the **next one starts instantly**, mid-task, without a message.
3. "Request too large" errors shrink the conversation context and retry.
4. If every model is resting, Local Dost waits with a spinner and continues automatically. If the wait is over ~6 minutes (daily quota gone), it tells you when quotas reset instead of failing.
5. You only see a dim `↻ using gemini · …` note when it switches. Disable with `"showSwitch": false` in the config.

## Configuration (`~/.localdost/config.json`)

```jsonc
{
  "order": ["groq", "gemini", "cerebras"],            // preferred order
  "models": { "groq": ["openai/gpt-oss-120b"] },      // override model lists (names change over time!)
  "maxContextChars": 48000,                           // lower this if your free tier has tiny limits
  "yolo": false,
  "showSwitch": true,
  "custom": [                                         // any OpenAI-compatible endpoint
    { "id": "mine", "base": "https://example.com/v1", "key": "sk-...", "models": ["some-model"] }
  ]
}
```

## Honest notes about "free"

- **Local Dost costs nothing and has no hidden costs.** It's MIT-licensed code that runs on your computer.
- **The AI providers' free tiers are theirs**, not ours. Their limits, model names and terms can change at any time. That's exactly why Local Dost spreads across several of them, and why model lists are editable.
- **Privacy:** on some free tiers the provider may log prompts or use them to improve their models. Don't send code you aren't allowed to share. Local Dost asks before reading `.env`/key files, but anything the AI reads goes to the provider. For fully private work use Ollama.
- **Never commit your keys.** Don't put API keys in this repo. Each user uses their own free key.

## Safety

- Asks before every file change and command (unless you enable `/yolo`).
- Destructive commands (`rm -rf`, `sudo`, `git push --force`, `curl | sh`, …) **always** ask, even in yolo mode.
- Files outside the project folder, and secret-looking files, always ask.

## Uninstall

```bash
~/.localdost/app/uninstall.sh          # keeps your keys
~/.localdost/app/uninstall.sh --purge  # also deletes saved keys
```

## Development

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/local-dost && cd local-dost
npm test           # runs against a local mock provider; no network or keys needed
node bin/localdost.js
./install.sh       # installs from your checkout
```

Project layout: `src/providers.js` (provider list + failover router) · `src/agent.js` (tool loop) · `src/tools.js` (read/edit/search/run) · `src/cli.js` (terminal UI).

PRs welcome: new providers are ~6 lines in `BUILTIN`.

## License

MIT © Local Dost contributors
"# CLIagi" 
