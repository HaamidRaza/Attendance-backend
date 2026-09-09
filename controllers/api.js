const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const { User, Student, Class, Attendance } = require("../models");
const { tokenFor, safeUser } = require("../utils/auth");
const { UPLOAD_DIR } = require("../utils/upload");
const ATTENDANCE_EDIT_WINDOW_DAYS = 30;

const ok = (res, data, message = "Operation successful", code = 200) =>
  res.status(code).json({ success: true, message, data });
const fail = (message, code = 400) =>
  Object.assign(new Error(message), { status: code });

const id = (v) => {
  if (!v || !/^[0-9a-f]{24}$/i.test(v)) throw fail("Invalid ID");
  return v;
};

const day = (v) => {
  const d = new Date(`${v}T00:00:00.000Z`);
  if (!v || Number.isNaN(d.getTime())) throw fail("Valid date is required");

  const today = new Date();
  const todayUTC = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );

  if (d.getTime() > todayUTC.getTime())
    throw fail("Attendance cannot be recorded for a future date");

  const earliestAllowed = new Date(todayUTC);
  earliestAllowed.setUTCDate(
    earliestAllowed.getUTCDate() - ATTENDANCE_EDIT_WINDOW_DAYS,
  );
  if (d.getTime() < earliestAllowed.getTime())
    throw fail(
      `Attendance can only be recorded or edited within the last ${ATTENDANCE_EDIT_WINDOW_DAYS} days`,
    );

  return d;
};

function stats(records) {
  const present = records.filter((r) => r.status === "present").length,
    total = records.length;
  return {
    present,
    absent: total - present,
    total,
    percentage: total ? Number(((present / total) * 100).toFixed(2)) : 0,
  };
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    const user = await User.findOne({ email }).select("+password");
    if (!user || !(await bcrypt.compare(password || "", user.password)))
      throw fail("Invalid email or password", 401);
    ok(
      res,
      { user: safeUser(user), token: tokenFor(user) },
      "Login successful",
    );
  } catch (e) {
    next(e);
  }
}

async function me(req, res, next) {
  try {
    ok(res, safeUser(req.user));
  } catch (e) {
    next(e);
  }
}

async function listUsers(req, res, next) {
  try {
    ok(res, await User.find().sort({ createdAt: -1 }));
  } catch (e) {
    next(e);
  }
}

async function createUser(req, res, next) {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password)
      throw fail("Name, email, and password are required");
    if (password.length < 6)
      throw fail("Password must be at least 6 characters");

    const normalizedEmail = email.toLowerCase().trim();
    if (await User.exists({ email: normalizedEmail }))
      throw fail("A user with this email already exists", 409);

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({
      name,
      email: normalizedEmail,
      password: hashed,
      role: "teacher", // admins can only create teacher accounts via this endpoint
    });
    ok(res, safeUser(user), "Teacher account created", 201);
  } catch (e) {
    if (e.code === 11000)
      return next(fail("A user with this email already exists", 409));
    next(e);
  }
}

async function listStudents(req, res, next) {
  try {
    const q = {};
    if (req.query.classId) q.classId = id(req.query.classId);
    if (req.query.search)
      q.$or = [
        { name: new RegExp(req.query.search, "i") },
        { rollNumber: new RegExp(req.query.search, "i") },
      ];
    ok(res, await Student.find(q).populate("classId", "name section"));
  } catch (e) {
    next(e);
  }
}

async function student(req, res, next) {
  try {
    const s = await Student.findById(id(req.params.id)).populate(
      "classId",
      "name section",
    );
    if (!s) throw fail("Student not found", 404);
    ok(res, s);
  } catch (e) {
    next(e);
  }
}

async function createStudent(req, res, next) {
  try {
    const { name, rollNumber, classId } = req.body || {};
    const photoFile = req.files?.photo?.[0];
    const aadharFile = req.files?.aadharCard?.[0];

    if (!name || !rollNumber || !classId)
      throw fail("Name, roll number, and class ID are required");
    if (!photoFile) throw fail("Student photo is required");
    if (!aadharFile) throw fail("Aadhar card (photo or PDF) is required");

    id(classId);
    if (!(await Class.exists({ _id: classId })))
      throw fail("Class not found", 404);

    const student = await Student.create({
      name,
      rollNumber,
      classId,
      photo: { filename: photoFile.filename, mimeType: photoFile.mimetype },
      aadharCard: {
        filename: aadharFile.filename,
        mimeType: aadharFile.mimetype,
      },
    });
    ok(res, student, "Student created", 201);
  } catch (e) {
    // Clean up any files multer already wrote to disk if creation failed.
    [req.files?.photo?.[0], req.files?.aadharCard?.[0]].forEach((f) => {
      if (f) fs.unlink(f.path, () => {});
    });
    next(e);
  }
}

async function updateStudent(req, res, next) {
  try {
    const existing = await Student.findById(id(req.params.id));
    if (!existing) throw fail("Student not found", 404);

    const photoFile = req.files?.photo?.[0];
    const aadharFile = req.files?.aadharCard?.[0];

    const update = {
      name: req.body.name,
      rollNumber: req.body.rollNumber,
      classId: req.body.classId,
    };
    if (photoFile)
      update.photo = {
        filename: photoFile.filename,
        mimeType: photoFile.mimetype,
      };
    if (aadharFile)
      update.aadharCard = {
        filename: aadharFile.filename,
        mimeType: aadharFile.mimetype,
      };

    const s = await Student.findByIdAndUpdate(existing._id, update, {
      new: true,
      runValidators: true,
    }).populate("classId", "name section");

    // Only delete old files after the update has actually succeeded.
    if (photoFile && existing.photo?.filename) {
      fs.unlink(path.join(UPLOAD_DIR, existing.photo.filename), () => {});
    }
    if (aadharFile && existing.aadharCard?.filename) {
      fs.unlink(path.join(UPLOAD_DIR, existing.aadharCard.filename), () => {});
    }

    ok(res, s, "Student updated");
  } catch (e) {
    [req.files?.photo?.[0], req.files?.aadharCard?.[0]].forEach((f) => {
      if (f) fs.unlink(f.path, () => {});
    });
    next(e);
  }
}

async function deleteStudent(req, res, next) {
  try {
    const s = await Student.findByIdAndDelete(id(req.params.id));
    if (!s) throw fail("Student not found", 404);
    [s.photo?.filename, s.aadharCard?.filename].forEach((f) => {
      if (f) fs.unlink(path.join(UPLOAD_DIR, f), () => {});
    });
    ok(res, null, "Student deleted");
  } catch (e) {
    next(e);
  }
}

async function studentPhoto(req, res, next) {
  try {
    const s = await Student.findById(id(req.params.id));
    if (!s?.photo?.filename) throw fail("Photo not found", 404);
    res.sendFile(path.join(UPLOAD_DIR, s.photo.filename));
  } catch (e) {
    next(e);
  }
}

async function studentAadhar(req, res, next) {
  try {
    const s = await Student.findById(id(req.params.id));
    if (!s?.aadharCard?.filename) throw fail("Aadhar document not found", 404);
    res.sendFile(path.join(UPLOAD_DIR, s.aadharCard.filename));
  } catch (e) {
    next(e);
  }
}

async function listClasses(req, res, next) {
  try {
    const data = await Class.aggregate([
      {
        $lookup: {
          from: "students",
          localField: "_id",
          foreignField: "classId",
          as: "students",
        },
      },
      {
        $project: {
          id: { $toString: "$_id" },
          name: 1,
          section: 1,
          createdAt: 1,
          updatedAt: 1,
          studentCount: { $size: "$students" },
        },
      },
    ]);
    ok(res, data);
  } catch (e) {
    next(e);
  }
}

async function oneClass(req, res, next) {
  try {
    const c = await Class.findById(id(req.params.id));
    if (!c) throw fail("Class not found", 404);
    ok(res, {
      ...c.toJSON(),
      studentCount: await Student.countDocuments({ classId: c._id }),
    });
  } catch (e) {
    next(e);
  }
}

async function createClass(req, res, next) {
  try {
    if (!req.body?.name) throw fail("Name is required");
    ok(res, await Class.create(req.body), "Class created", 201);
  } catch (e) {
    next(e);
  }
}

async function updateClass(req, res, next) {
  try {
    const c = await Class.findByIdAndUpdate(id(req.params.id), req.body, {
      new: true,
      runValidators: true,
    });
    if (!c) throw fail("Class not found", 404);
    ok(res, c, "Class updated");
  } catch (e) {
    next(e);
  }
}

async function deleteClass(req, res, next) {
  try {
    if (await Student.exists({ classId: id(req.params.id) }))
      throw fail("Cannot delete a class with students", 409);
    const c = await Class.findByIdAndDelete(req.params.id);
    if (!c) throw fail("Class not found", 404);
    ok(res, null, "Class deleted");
  } catch (e) {
    next(e);
  }
}

async function validateRecords(classId, records) {
  id(classId);
  if (!Array.isArray(records)) throw fail("Records must be an array");
  const ids = records.map((r) => r.studentId);
  if (
    records.some(
      (r) =>
        !ids.includes(r.studentId) || !["present", "absent"].includes(r.status),
    ) ||
    new Set(ids).size !== ids.length
  )
    throw fail("Invalid attendance records");
  const students = await Student.find({ _id: { $in: ids }, classId });
  if (students.length !== ids.length)
    throw fail("All students must belong to the selected class");
}

async function listAttendance(req, res, next) {
  try {
    const q = {};
    if (req.query.classId) q.classId = id(req.query.classId);
    if (req.query.date) q.date = day(req.query.date);
    const rows = await Attendance.find(q)
      .populate("classId", "name section")
      .populate("takenBy", "name email");
    ok(
      res,
      rows.map((r) => ({ ...r.toJSON(), statistics: stats(r.records) })),
    );
  } catch (e) {
    next(e);
  }
}

async function attendance(req, res, next) {
  try {
    const a = await Attendance.findById(id(req.params.id))
      .populate("classId", "name section")
      .populate("records.studentId", "name rollNumber")
      .populate("takenBy", "name email");
    if (!a) throw fail("Attendance not found", 404);
    ok(res, { ...a.toJSON(), statistics: stats(a.records) });
  } catch (e) {
    next(e);
  }
}

async function createAttendance(req, res, next) {
  try {
    const { classId, date, records } = req.body || {};
    await validateRecords(classId, records);
    ok(
      res,
      await Attendance.create({
        classId,
        date: day(date),
        records,
        takenBy: req.user._id,
      }),
      "Attendance created",
      201,
    );
  } catch (e) {
    if (e.code === 11000)
      return next(
        fail("Attendance already exists for this class and date.", 409),
      );
    next(e);
  }
}

async function updateAttendance(req, res, next) {
  try {
    const a = await Attendance.findById(id(req.params.id));
    if (!a) throw fail("Attendance not found", 404);
    await validateRecords(a.classId, req.body.records);
    a.records = req.body.records;
    if (req.body.date) a.date = day(req.body.date);
    a.takenBy = req.user._id; // record now reflects whoever last saved it
    await a.save();
    ok(res, a, "Attendance updated");
  } catch (e) {
    next(e);
  }
}

async function deleteAttendance(req, res, next) {
  try {
    const a = await Attendance.findByIdAndDelete(id(req.params.id));
    if (!a) throw fail("Attendance not found", 404);
    ok(res, null, "Attendance deleted");
  } catch (e) {
    next(e);
  }
}

async function dashboard(req, res, next) {
  try {
    const now = new Date();
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const a = await Attendance.findOne({ date });
    const all = a ? stats(a.records) : stats([]);
    ok(res, {
      totalStudents: await Student.countDocuments(),
      totalClasses: await Class.countDocuments(),
      todayAttendanceTaken: !!a,
      todayAttendancePercentage: all.percentage,
    });
  } catch (e) {
    next(e);
  }
}

module.exports = {
  login,
  me,
  listUsers,
  createUser,
  listStudents,
  student,
  createStudent,
  updateStudent,
  deleteStudent,
  studentPhoto,
  studentAadhar,
  listClasses,
  oneClass,
  createClass,
  updateClass,
  deleteClass,
  listAttendance,
  attendance,
  createAttendance,
  updateAttendance,
  deleteAttendance,
  dashboard,
};
