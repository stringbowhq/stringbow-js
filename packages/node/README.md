# @stringbow/node

The Stringbow SDK for your backend: subjects, browser tokens, decisions, permits, outcomes and webhook verification.
Needs Node 20 or newer.

```bash
npm install @stringbow/node
```

```ts
import { Stringbow } from '@stringbow/node';
const sb = new Stringbow({ apiKey: process.env.STRINGBOW_KEY!, baseUrl: process.env.STRINGBOW_URL! });

const d = await sb.authorize({ ...saved, idempotencyKey: id, session: observationSessionId });
if (d.decision === 'allow') {
  const ok = await sb.redeem(d.permit, saved);   // verify offline, then consume once online
  if (ok.valid) await changeDestination(destination);
}
```

Documentation: [Node SDK](https://stringbow.dev/docs/node-sdk), [quickstart](https://stringbow.dev/docs/quickstart).
Source: [stringbowhq/stringbow-js](https://github.com/stringbowhq/stringbow-js). License: MIT.
