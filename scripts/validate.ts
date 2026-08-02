import { REPOSITORY_ROOT } from "../src/paths.js";
import { formatValidationIssues, validateSourceCatalog } from "../src/validate.js";

const result = await validateSourceCatalog(REPOSITORY_ROOT);
if (result.issues.length > 0) {
  console.error(formatValidationIssues(result.issues));
  process.exitCode = 1;
} else {
  console.log(
    `目录校验通过：${result.catalog.models.length} canonical models，${result.catalog.providers.length} providers，${result.catalog.offerings.length} offerings。`,
  );
}
