const jwt = require("jsonwebtoken");
const { User } = require("../models");
const multer = require("multer");

async function auth(req, res, next) {
  try {
    const raw = req.headers.authorization || "";
    if (!raw.startsWith("Bearer "))
      return res
        .status(401)
        .json({ success: false, message: "Authentication required" });
    const decoded = jwt.verify(raw.slice(7), process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user)
      return res.status(401).json({ success: false, message: "Invalid token" });
    req.user = user;
    next();
  } catch (e) {
    next(Object.assign(new Error("Invalid or expired token"), { status: 401 }));
  }
}

// Restricts a route to specific roles. Must run after `auth`, since it
// relies on req.user being set.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res
        .status(403)
        .json({
          success: false,
          message: "You don't have permission to do this.",
        });
    }
    next();
  };
}

function errors(err, req, res, next) {
  console.error(err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err.name === "CastError")
    return res.status(400).json({ success: false, message: "Invalid ID" });
  if (err.code === 11000)
    return res.status(409).json({
      success: false,
      message: "A record with these values already exists",
    });
  if (err.name === "ValidationError")
    return res.status(400).json({
      success: false,
      message: Object.values(err.errors).map((e) => e.message).join(", "),
    });
  res.status(err.status || 500).json({
    success: false,
    message: err.status ? err.message : "Internal server error",
  });
}

module.exports = { auth, requireRole, errors };
