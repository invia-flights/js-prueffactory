/* eslint-disable no-console */
// eslint-disable-next-line no-undef
const a = 1; // eslint-disable-line no-unused-vars
// biome-ignore lint/suspicious/noExplicitAny: legacy
// @ts-ignore
// @ts-expect-error intentional
// @ts-nocheck
/* c8 ignore next 2 */
/* istanbul ignore next */
// node:coverage ignore next
// jscpd:ignore-start
// Stryker disable next-line all
const text = "eslint-disable is only a word here"; // not a directive

// we never write eslint-disable in this file, and /* eslint-enable */ is no Suppression
/* c8 ignore stop */
