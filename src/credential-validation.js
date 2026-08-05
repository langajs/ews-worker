const NEW_USERNAME_PATTERN = /^[A-Za-z0-9]{1,16}$/;
const NEW_PASSWORD_PATTERN = /^[A-Za-z0-9._@-]{6,32}$/;

function isValidNewUsername(value) {
  return typeof value === 'string' && NEW_USERNAME_PATTERN.test(value);
}

function isValidNewPassword(value) {
  return typeof value === 'string' && NEW_PASSWORD_PATTERN.test(value);
}

export { isValidNewPassword, isValidNewUsername };
