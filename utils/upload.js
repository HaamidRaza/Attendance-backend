const multer = require("multer");
const path = require("path");
const fs = require("fs");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "students");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, unique);
  },
});

const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_AADHAR_TYPES = ["image/jpeg", "image/png", "application/pdf"];

function fileFilter(req, file, cb) {
  const allowed = file.fieldname === "photo" ? ALLOWED_PHOTO_TYPES : ALLOWED_AADHAR_TYPES;
  if (!allowed.includes(file.mimetype)) {
    return cb(
      Object.assign(
        new Error(
          file.fieldname === "photo"
            ? "Photo must be a JPEG, PNG, or WebP image"
            : "Aadhar document must be a JPEG/PNG image or a PDF",
        ),
        { status: 400 },
      ),
    );
  }
  cb(null, true);
}

const studentUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
}).fields([
  { name: "photo", maxCount: 1 },
  { name: "aadharCard", maxCount: 1 },
]);

module.exports = { studentUpload, UPLOAD_DIR };