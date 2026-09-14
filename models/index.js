const mongoose = require("mongoose");

// Shared so every schema serializes the same way: adds a string `id`
// alongside `_id`, and strips internal fields the frontend doesn't need.
function applyJsonTransform(schema) {
  schema.set("toJSON", {
    virtuals: true,
    versionKey: false,
    transform: (doc, ret) => {
      delete ret.__v;
      return ret;
    },
  });
}

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ["admin", "teacher"], default: "teacher" },
  },
  { timestamps: true },
);
applyJsonTransform(userSchema);

const classSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    section: { type: String, trim: true },
    teachers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true },
);
classSchema.index({ name: 1, section: 1 }, { unique: true });
applyJsonTransform(classSchema);

const studentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    rollNumber: { type: String, required: true, trim: true },
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      required: true,
    },
    photo: {
      publicId: { type: String, required: true },
      resourceType: { type: String, default: "image" },
      mimeType: { type: String, required: true },
    },
    aadharNumber: { type: String, required: true }, // encrypted payload (iv:tag:ciphertext)
    aadharHash: { type: String, required: true, unique: true }, // deterministic hash, for duplicate detection only
  },
  { timestamps: true },
);
studentSchema.index({ classId: 1, rollNumber: 1 }, { unique: true });

studentSchema.virtual("photoUrl").get(function () {
  return this.photo?.publicId ? `/students/${this._id}/photo` : null;
});

applyJsonTransform(studentSchema);

const attendanceSchema = new mongoose.Schema(
  {
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      required: true,
    },
    date: { type: Date, required: true },
    records: [
      {
        studentId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Student",
          required: true,
        },
        status: { type: String, enum: ["present", "absent"], required: true },
      },
    ],
    takenBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    takenByName: { type: String, required: true },
    takenByEmail: { type: String, required: true },
  },
  { timestamps: true },
);
attendanceSchema.index({ classId: 1, date: 1 }, { unique: true });
applyJsonTransform(attendanceSchema);

module.exports = {
  User: mongoose.model("User", userSchema),
  Class: mongoose.model("Class", classSchema),
  Student: mongoose.model("Student", studentSchema),
  Attendance: mongoose.model("Attendance", attendanceSchema),
};
