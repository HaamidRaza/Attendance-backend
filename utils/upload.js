const multer = require("multer");
const crypto = require("crypto");
const cloudinary = require("cloudinary").v2;
const https = require("https");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Fetches a signed Cloudinary URL server-side and pipes the bytes straight
// through to the client. This avoids relying on Cloudinary returning CORS
// headers on redirect — the browser only ever talks to our own backend.
function streamAuthenticatedAsset(url, res) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (cloudinaryRes) => {
        if (cloudinaryRes.statusCode !== 200) {
          cloudinaryRes.resume(); // drain so the socket can close cleanly
          reject(
            Object.assign(new Error("Couldn't load file from storage"), {
              status: cloudinaryRes.statusCode,
            }),
          );
          return;
        }
        res.setHeader(
          "Content-Type",
          cloudinaryRes.headers["content-type"] || "application/octet-stream",
        );
        cloudinaryRes.pipe(res);
        cloudinaryRes.on("end", resolve);
        cloudinaryRes.on("error", reject);
      })
      .on("error", reject);
  });
}

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
  if (!ALLOWED_PHOTO_TYPES.includes(file.mimetype)) {
    return cb(
      Object.assign(new Error("Photo must be a JPEG, PNG, or WebP image"), {
        status: 400,
      }),
    );
  }
  cb(null, true);
}

const studentUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
}).fields([{ name: "photo", maxCount: 1 }]);

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
  streamAuthenticatedAsset,
};
