# @stringbow/browser

The Stringbow SDK for the page. It summarises interaction into evidence windows and delivers them to Stringbow with a
short-lived token your backend mints. It also runs enrollment, passkey registration and challenges.

```bash
npm install @stringbow/browser
```

```ts
import { StringbowBrowser } from '@stringbow/browser';

const sb = new StringbowBrowser({
  apiUrl: 'https://identity-api.example',
  getToken: async () => (await (await fetch('/api/stringbow/token', { method: 'POST' })).json()).token,
});

const me = await sb.me();
if (me.subject.state === 'enrolled') await sb.observe();
```

An evidence window holds timings and movement summaries only. Which key was pressed, what was typed, where the pointer
was, what was clicked, the page URL and page content never leave the page.

Documentation: [browser SDK](https://stringbow.dev/docs/browser-sdk), [quickstart](https://stringbow.dev/docs/quickstart).
Source: [stringbowhq/stringbow-js](https://github.com/stringbowhq/stringbow-js). License: MIT.
