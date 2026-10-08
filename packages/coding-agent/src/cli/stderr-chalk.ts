import { chalkStderr } from "chalk";

/**
 * chalk's default instance detects color support from stdout only; error and
 * warning text goes to stderr, which has its own support. `prime-agent ... | cat`
 * would otherwise decolor stderr diagnostics that are still on a terminal.
 */
export { chalkStderr as stderrChalk };
