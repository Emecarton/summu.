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
