/**
 * full_flow.spec.ts
 *
 * This file is intentionally empty.
 * The full end-to-end flow is driven by the "full-flow" project in playwright.config.ts,
 * which runs the four spec files in order:
 *
 *   1. login_flow.spec.ts
 *   2. home_course_flow.spec.ts
 *   3. course_flow_explore.spec.ts
 *   4. certificate_download.spec.ts
 *
 * To run the full flow:
 *   npx playwright test --project=full-flow --headed
 *
 * To run a single file:
 *   npx playwright test tests/consumption_1/login_flow.spec.ts --headed --project=chromium
 */
