# Zappy AI on staging

Staging previously hard-coded `OPENAI_API_KEY: ""`, so Zappy could only give canned catalog replies there. The API service now reads
`OPENAI_API_KEY` from the protected staging env file. Production (`deploy/docker-compose.yml`) is unchanged.

## 1. Create a restricted staging key (OpenAI dashboard)

- Create a separate **project**, for example `myorder-staging`. Never reuse the production key.
- Give it a **monthly budget / usage limit**, and allow only the model Zappy uses (`gpt-4o-mini`).
- Create a **restricted** key in that project with only the Model capabilities (chat completions) permission.

## 2. Install it

On the staging host, add this line to the protected staging env file (the path in `MYORDER_STAGING_ENV_FILE`, mode 600, owned by the deploy user):

```
OPENAI_API_KEY=<staging key>
```

In GitHub, add the same key as **`STAGING_OPENAI_API_KEY`** in the `staging` environment. Only the manual live-eval workflow uses it.

Then redeploy staging (Actions → Deploy to staging). The key is read only by the API process. It is never a build argument or `VITE_`
variable, never sent to the browser, and never included in logs or error messages.

## 3. Verify real AI (not fallback)

- **Synthetic eval:** Actions → **Zappy live eval (staging key)**. It runs the real model against made-up data: tenant cash discount,
  members-only, no PayPal fee, own-order lookup, another customer's order denied, credit lookup, and prompt-injection resistance
  (including instructions planted in product text).
- **On staging.myorder.fun:** sign in as a staging test member and ask Zappy something. In the browser's network tab, the
  `/api/ai/chat` response header `X-Zappy-Source` is `ai` when the model answered and `fallback` when it didn't.
- Use only staging test members and test orders. Never use production customer data.

## Missing or invalid key

Zappy falls back to catalog suggestions (`X-Zappy-Source: fallback`). A missing key logs one warning at first use, not on every message.
A provider error logs only the HTTP status.
