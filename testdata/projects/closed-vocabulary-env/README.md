# closed-vocabulary-env

Testdata for ticket 38. `.env` holds secret-named variables (`DB_PASSWORD`, `AUTH_REALM`, `SIGNING_KEY`, `SESSION_SECRET`, `API_TOKEN`) whose values are ordinary words that are also words of the Report's own vocabulary: `root` (inside `project_root`), `confirmed` (a confidence), `primary` (a location role), `parse` and `syntax` (inside the Check ID `syntax.parse`). A Run must keep the closed-vocabulary fields as they are and still redact the words in free text. `src/root-config.js` has a parse error on purpose, so the Run has a Finding. Every value is made up.
