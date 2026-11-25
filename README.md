# Stringbow SDKs for JavaScript

At the moment a risky action runs in your web app (changing a payout destination, exporting data, granting admin
rights), Stringbow checks that the person who signed in is still the one at the controls, and returns a decision plus
a signed, one-time permit bound to that exact action.

This repository holds the two SDKs you integrate with:

| Package | Runs in | What it does |
|---|---|---|
| [`@stringbow/browser`](packages/browser) | your page | Summarises interaction into evidence windows, runs enrollment, passkeys and challenges |
| [`@stringbow/node`](packages/node) | your backend | Subjects, browser tokens, decisions, permits, outcomes and webhook verification |

Documentation: [quickstart](https://stringbow.dev/docs/quickstart),
[browser SDK](https://stringbow.dev/docs/browser-sdk), [Node SDK](https://stringbow.dev/docs/node-sdk).

## Install

```bash
npm install @stringbow/browser
```

```bash
npm install @stringbow/node
```

## In short

On your backend, mint a short-lived token for the signed-in user. Never send a server key to a page.

```ts
import { Stringbow } from '@stringbow/node';
const sb = new Stringbow({ apiKey: process.env.STRINGBOW_KEY!, baseUrl: process.env.STRINGBOW_URL! });

const subject = await sb.upsertSubject(user.id);
const { token } = await sb.browserToken({ subject: subject.id, origin, region, allowPasskeyRegistration });
```

In the page, collect evidence with that token:

```ts
import { StringbowBrowser } from '@stringbow/browser';

const sb = new StringbowBrowser({
  apiUrl: STRINGBOW_URL,
  getToken: () => fetch('/api/stringbow/token', { method: 'POST' }).then((r) => r.json()).then((j) => j.token),
});

const me = await sb.me();
if (me.subject.state === 'enrolled') await sb.observe();
```

Before the action, ask for a decision on your backend and execute only behind the permit:

```ts
const d = await sb.authorize({ ...saved, idempotencyKey: id, session: observationSessionId });
if (d.decision === 'allow') {
  const ok = await sb.redeem(d.permit, saved);   // verify offline, then consume once online
  if (ok.valid) await changeDestination(destination);
}
```

The [quickstart](https://stringbow.dev/docs/quickstart) walks through the whole flow, including shadow mode and
challenges.

## What the browser SDK reads

It is the part that runs in your users' pages, so its source is here to read. An evidence window holds timings and
movement summaries only. Which key was pressed, what was typed, where the pointer was, what was clicked, the page URL
and page content never leave the page: see [`collector.ts`](packages/browser/src/collector.ts) and the window shape in
[`window.ts`](packages/core/src/window.ts).

## Layout

```
packages/browser   @stringbow/browser
packages/node      @stringbow/node
packages/core      code both SDKs share; bundled into each package, not published on its own
```

```bash
npm install
npm run typecheck
npm run build      # ESM, CommonJS and type declarations in packages/*/dist
```

## Contributing

This repository is a copy of the SDK sources from Stringbow's main repository, updated on each release. Issues are
welcome here. A pull request is welcome too, but it is applied to the main repository first and reaches this one with
the next release, so it will be closed here rather than merged.

Please report a security problem privately, through **Security → Report a vulnerability** on this repository, not in a
public issue.

## License

[MIT](LICENSE)
