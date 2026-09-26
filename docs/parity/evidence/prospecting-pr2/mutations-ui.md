# Prospecting PR 2 — UI and public-whitelist mutation tests

Each guard was mutated, the named test file run, and the mutation reverted
(script-driven: copy, replace one literal, run, restore; `git diff` clean
afterwards). All 7 went RED. Line numbers are at the time of the run.

| File:line | Mutation | Red test |
|---|---|---|
| `src/components/contacts/contact-prospect-reports.tsx:59` | gate `=== true` → `!== false` | card: *treats a missing gate field as off* |
| `src/components/contacts/contact-prospect-reports.tsx:137` | `data.used >= data.quota` → `data.used > data.quota` | card: *enables Generate under quota and disables it at quota with the reason* |
| `src/components/contacts/contact-prospect-reports.tsx:150` | `atQuota` dropped from Generate's `disabled` | card: *enables Generate under quota and disables it at quota with the reason* |
| `src/components/contacts/contact-prospect-reports.tsx:84` | poll effect ignores `pending` | card: *polls while a report is running and stops once it is ready*; *does not poll when nothing is pending, and stops on unmount* |
| `src/components/contacts/contact-prospect-reports.tsx:86` | poll cleanup no longer clears the interval | card: *polls while … stops once it is ready*; *… stops on unmount* |
| `src/lib/prospecting/public-sections.ts:17` | `"phone"` added to the business_details whitelist | public-sections: *emits exactly the named keys per section*; *carries the values*; *leaks nothing identifying* |
| `src/lib/prospecting/public-sections.ts:58` | listings directory allowlist check deleted | public-sections: *emits exactly the named keys per section*; *carries the values* |
