const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const PHONE_REGEX = /^\+?[0-9 ()-]{7,15}$/;

// Lives next to the regex it describes so the rule and the sentence explaining it cannot
// drift apart — every caller that rejects a password should quote this exact text.
const STRONG_PASSWORD_MESSAGE =
  "Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character";

function isStrongPassword(password) {
  return typeof password === "string" && STRONG_PASSWORD_REGEX.test(password);
}

function isValidPhone(phone) {
  return typeof phone === "string" && PHONE_REGEX.test(phone.trim());
}

module.exports = { isStrongPassword, isValidPhone, STRONG_PASSWORD_MESSAGE };
