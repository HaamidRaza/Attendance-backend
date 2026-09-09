const jwt = require("jsonwebtoken");
function tokenFor(user) {
  return jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
}
function safeUser(user) {
  const obj = user.toObject ? user.toObject() : { ...user };
  delete obj.password;
  return obj;
}
module.exports = { tokenFor, safeUser };
