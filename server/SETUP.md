# Summu scan server: setup (about 10 minutes)

Summu needs a small free server that keeps one Google Gemini key hidden, so people can scan without pasting their own key.
These steps are for an adult. Nothing here costs money.

1. Go to https://dash.cloudflare.com/sign-up and make a free account.
2. In the left menu open **Workers & Pages**, then **Create**, then **Create Worker** (the "Hello World" one).
   Name it `summu` and press **Deploy**.
3. Press **Edit code**. Delete everything in the editor, paste the code from
   https://github.com/Emecarton/summu./blob/main/server/worker.js (use the copy button at the top right of the code),
   then press **Deploy**.
4. Go back to the Worker, open **Settings**, then **Variables and Secrets**, then **Add**.
   Type: **Secret**. Name: `GEMINI_KEY`. Value: a Gemini key from https://aistudio.google.com/apikey . Press **Deploy**.
5. Send Claude the Worker's address. It looks like `https://summu.YOUR-NAME.workers.dev`.
   The address is not secret. Never send the key itself.

Opening the address in a browser should say "Summu scan server is on."

## Accounts (one time, about 3 minutes)

Summu accounts and their cards are kept in a free Cloudflare D1 database. Until this is done, the website keeps cards on the phone only.

1. In the Cloudflare dashboard open **Storage & databases**, then **D1 SQL database**, then **Create**. Name it `summu` and press **Create**.
2. Open **Workers & Pages**, then the `summu` Worker, then **Bindings**, then **Add binding**. Pick **D1 database**.
   Variable name: `DB`. Database: `summu`. Press **Add binding** (or **Deploy**).
3. In the same Worker press **Edit code**, delete everything, paste the code from
   https://raw.githubusercontent.com/Emecarton/summu./main/server/worker.js (select all, copy), then press **Deploy**.

The Worker makes its own tables the first time someone signs up.
