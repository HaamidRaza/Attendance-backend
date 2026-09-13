const multer = require("multer");
const crypto = require("crypto");
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_AADHAR_TYPES = ["image/jpeg", "image/png", "application/pdf"];

function extensionForMime(mimeType) {
  switch (mimeType) {
    case "application/pdf":
      return "pdf";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/jpeg":
    default:
      return "jpg";
  }
}

function fileFilter(req, file, cb) {
  const allowed =
    file.fieldname === "photo" ? ALLOWED_PHOTO_TYPES : ALLOWED_AADHAR_TYPES;
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
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
}).fields([
  { name: "photo", maxCount: 1 },
  { name: "aadharCard", maxCount: 1 },
]);

function uploadToCloudinary(buffer, folder, resourceType, mimeType) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        type: "authenticated",
        public_id: crypto.randomBytes(16).toString("hex"),
        format: extensionForMime(mimeType), // tells Cloudinary exactly what this file is
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      },
    );
    stream.end(buffer);
  });
}

async function deleteFromCloudinary(publicId, resourceType) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      type: "authenticated",
    });
  } catch (e) {
    console.error("Failed to delete Cloudinary asset:", publicId, e.message);
  }
}

function signedUrlFor(publicId, resourceType, mimeType) {
  const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60;
  const options = {
    resource_type: resourceType,
    type: "authenticated",
    sign_url: true,
    secure: true,
    expires_at: expiresAt,
  };

  if (resourceType !== "raw") {
    options.format = extensionForMime(mimeType);
  }

  return cloudinary.url(publicId, options);
}

module.exports = {
  studentUpload,
  uploadToCloudinary,
  deleteFromCloudinary,
  signedUrlFor,
};
