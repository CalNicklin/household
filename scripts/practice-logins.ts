import { logins, PRACTICE_PASSWORD } from "../practice/data.ts";

/**
 * FB-5 / PRV-6: print the practice household's app logins, one `  <username>  <password>` per line,
 * for a PR's preview (household-preview runs this in the preview's own container). They are not
 * secrets: the practice household is made up and holds nothing real.
 */
for (const l of logins) process.stdout.write(`  ${l.username}  ${PRACTICE_PASSWORD}\n`);
