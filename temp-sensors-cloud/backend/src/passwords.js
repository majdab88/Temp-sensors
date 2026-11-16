'use strict';

// Raised from 6. Length is what makes an online-guessable password expensive to
// guess; no composition rules, which mostly produce predictable variations.
// Applies when a password is set, so existing shorter ones keep working until
// they are next changed.
const MIN_PASSWORD_LENGTH = 10;

/** An error message, or null when the password is acceptable. */
function passwordProblem(password, field = 'password') {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `${field} must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

module.exports = { MIN_PASSWORD_LENGTH, passwordProblem };
