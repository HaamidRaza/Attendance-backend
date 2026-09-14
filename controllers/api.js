const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const { User, Student, Class, Attendance } = require("../models");
const { tokenFor, safeUser } = require("../utils/auth");
const {
  uploadToCloudinary,
  deleteFromCloudinary,
  signedUrlFor,
  streamAuthenticatedAsset,
} = require("../utils/upload");

const {
  encrypt,
  decrypt,
  hashAadhar,
  maskAadhar,
} = require("../utils/encryption");

const AADHAR_REGEX = /^\d{12}$/;
const ATTENDANCE_EDIT_WINDOW_DAYS = 30;

const ok = (res, data, message = "Operation successful", code = 200) =>
  res.status(code).json({ success: true, message, data });
const fail = (message, code = 400) =>
  Object.assign(new Error(message), { status: code });

async function assertClassAccess(user, classId) {
  if (user.role === "admin") return;
  const allowed = await Class.exists({ _id: classId, teachers: user._id });
  if (!allowed) throw fail("You are not assigned to this class", 403);
}

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

async function oneUser(req, res, next) {
  try {
    const u = await User.findById(id(req.params.id));
    if (!u) throw fail("User not found", 404);
    ok(res, safeUser(u));
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

async function updateUser(req, res, next) {
  try {
    const target = await User.findById(id(req.params.id));
    if (!target) throw fail("User not found", 404);

    const { name, email, password } = req.body || {};
    if (!name?.trim() || !email?.trim())
      throw fail("Name and email are required");

    const normalizedEmail = email.toLowerCase().trim();
    const emailTaken = await User.exists({
      email: normalizedEmail,
      _id: { $ne: target._id },
    });
    if (emailTaken) throw fail("A user with this email already exists", 409);

    target.name = name.trim();
    target.email = normalizedEmail;

    if (password) {
      if (password.length < 6)
        throw fail("Password must be at least 6 characters");
      target.password = await bcrypt.hash(password, 10);
    }

    await target.save();
    ok(res, safeUser(target), "User updated");
  } catch (e) {
    if (e.code === 11000)
      return next(fail("A user with this email already exists", 409));
    next(e);
  }
}

async function deleteUser(req, res, next) {
  try {
    const targetId = id(req.params.id);

    if (String(req.user._id) === targetId)
      throw fail("You can't delete your own account", 400);

    const target = await User.findById(targetId);
    if (!target) throw fail("User not found", 404);

    if (target.role === "admin") {
      const adminCount = await User.countDocuments({ role: "admin" });
      if (adminCount <= 1)
        throw fail("Cannot delete the last remaining admin account", 400);
    }

    await User.findByIdAndDelete(targetId);

    // Clean up any class assignments referencing this user, so `teachers`
    // arrays never hold a dangling reference to a deleted account.
    await Class.updateMany(
      { teachers: targetId },
      { $pull: { teachers: targetId } },
    );

    ok(res, null, "User deleted");
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

async function listStudents(req, res, next) {
  try {
    const q = {};
    if (req.query.classId) {
      q.classId = id(req.query.classId);
      await assertClassAccess(req.user, q.classId);
    } else if (req.user.role === "teacher") {
      const classes = await Class.find({ teachers: req.user._id }).select(
        "_id",
      );
      q.classId = { $in: classes.map((c) => c._id) };
    }
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
    // Details page is admin-only, so it's the one place the full,
    // decrypted number is returned.
    const obj = s.toJSON();
    delete obj.aadharHash;
    try {
      obj.aadharNumber = decrypt(s.aadharNumber);
    } catch {
      obj.aadharNumber = null;
    }
    ok(res, obj);
  } catch (e) {
    next(e);
  }
}

async function createStudent(req, res, next) {
  try {
    const { name, rollNumber, classId, aadharNumber } = req.body || {};
    const photoFile = req.files?.photo?.[0];

    if (!name || !rollNumber || !classId)
      throw fail("Name, roll number, and class ID are required");
    if (!photoFile) throw fail("Student photo is required");
    if (!AADHAR_REGEX.test(aadharNumber || ""))
      throw fail("Aadhar number must be exactly 12 digits");

    id(classId);
    if (!(await Class.exists({ _id: classId })))
      throw fail("Class not found", 404);

    const aadharHash = hashAadhar(aadharNumber);
    if (await Student.exists({ aadharHash }))
      throw fail("A student with this Aadhar number already exists", 409);

    const photoResult = await uploadToCloudinary(
      photoFile.buffer,
      "students/photos",
      "image",
      photoFile.mimetype,
    );

    const s = await Student.create({
      name,
      rollNumber,
      classId,
      photo: {
        publicId: photoResult.public_id,
        resourceType: "image",
        mimeType: photoFile.mimetype,
      },
      aadharNumber: encrypt(aadharNumber),
      aadharHash,
    });

    const obj = s.toJSON();
    delete obj.aadharHash;
    obj.aadharNumber = aadharNumber; // echo back what was just entered, no need to re-decrypt
    ok(res, obj, "Student created", 201);
  } catch (e) {
    if (e.code === 11000)
      return next(
        fail("A student with this Aadhar number already exists", 409),
      );
    next(e);
  }
}

async function updateStudent(req, res, next) {
  try {
    const existing = await Student.findById(id(req.params.id));
    if (!existing) throw fail("Student not found", 404);

    const photoFile = req.files?.photo?.[0];
    const { name, rollNumber, classId, aadharNumber } = req.body || {};

    const update = { name, rollNumber, classId };

    if (aadharNumber) {
      if (!AADHAR_REGEX.test(aadharNumber))
        throw fail("Aadhar number must be exactly 12 digits");
      const aadharHash = hashAadhar(aadharNumber);
      const clash = await Student.exists({
        aadharHash,
        _id: { $ne: existing._id },
      });
      if (clash)
        throw fail("A student with this Aadhar number already exists", 409);
      update.aadharNumber = encrypt(aadharNumber);
      update.aadharHash = aadharHash;
    }

    if (photoFile) {
      const result = await uploadToCloudinary(
        photoFile.buffer,
        "students/photos",
        "image",
        photoFile.mimetype,
      );
      update.photo = {
        publicId: result.public_id,
        resourceType: "image",
        mimeType: photoFile.mimetype,
      };
    }

    const s = await Student.findByIdAndUpdate(existing._id, update, {
      new: true,
      runValidators: true,
    }).populate("classId", "name section");

    if (photoFile && existing.photo?.publicId) {
      await deleteFromCloudinary(
        existing.photo.publicId,
        existing.photo.resourceType,
      );
    }

    const obj = s.toJSON();
    delete obj.aadharHash;
    try {
      obj.aadharNumber = decrypt(s.aadharNumber);
    } catch {
      obj.aadharNumber = null;
    }
    ok(res, obj, "Student updated");
  } catch (e) {
    if (e.code === 11000)
      return next(
        fail("A student with this Aadhar number already exists", 409),
      );
    next(e);
  }
}

async function deleteStudent(req, res, next) {
  try {
    const s = await Student.findByIdAndDelete(id(req.params.id));
    if (!s) throw fail("Student not found", 404);
    await deleteFromCloudinary(s.photo?.publicId, s.photo?.resourceType);
    ok(res, null, "Student deleted");
  } catch (e) {
    next(e);
  }
}

async function studentPhoto(req, res, next) {
  try {
    const s = await Student.findById(id(req.params.id));
    if (!s?.photo?.publicId) throw fail("Photo not found", 404);
    const url = signedUrlFor(
      s.photo.publicId,
      s.photo.resourceType,
      s.photo.mimeType,
    );
    await streamAuthenticatedAsset(url, res);
  } catch (e) {
    next(e);
  }
}

async function listClasses(req, res, next) {
  try {
    const match = {};
    if (req.user.role === "teacher") {
      match.teachers = req.user._id;
    }
    const data = await Class.aggregate([
      { $match: match },
      {
        $lookup: {
          from: "students",
          localField: "_id",
          foreignField: "classId",
          as: "students",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "teachers",
          foreignField: "_id",
          as: "teacherDetails",
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
          teachers: {
            $map: {
              input: "$teacherDetails",
              as: "t",
              in: {
                id: { $toString: "$$t._id" },
                name: "$$t.name",
                email: "$$t.email",
              },
            },
          },
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
    const c = await Class.findById(id(req.params.id)).populate(
      "teachers",
      "name email",
    );
    if (!c) throw fail("Class not found", 404);
    await assertClassAccess(req.user, c._id);
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
    if (req.query.classId) {
      q.classId = id(req.query.classId);
      await assertClassAccess(req.user, q.classId);
    } else if (req.user.role === "teacher") {
      const classes = await Class.find({ teachers: req.user._id }).select(
        "_id",
      );
      q.classId = { $in: classes.map((c) => c._id) };
    }
    if (req.query.date) q.date = day(req.query.date);
    const rows = await Attendance.find(q)
      .sort({ updatedAt: -1 })
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
    await assertClassAccess(req.user, a.classId._id);
    ok(res, { ...a.toJSON(), statistics: stats(a.records) });
  } catch (e) {
    next(e);
  }
}

async function createAttendance(req, res, next) {
  try {
    const { classId, date, records } = req.body || {};
    await assertClassAccess(req.user, classId);
    await validateRecords(classId, records);
    ok(
      res,
      await Attendance.create({
        classId,
        date: day(date),
        records,
        takenBy: req.user._id,
        takenByName: req.user.name,
        takenByEmail: req.user.email,
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
    await assertClassAccess(req.user, a.classId);
    await validateRecords(a.classId, req.body.records);
    a.records = req.body.records;
    if (req.body.date) a.date = day(req.body.date);
    a.takenBy = req.user._id;
    a.takenByName = req.user.name;
    a.takenByEmail = req.user.email;
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

async function assignTeacher(req, res, next) {
  try {
    const classId = id(req.params.id);
    const { teacherId } = req.body || {};
    id(teacherId);

    const [cls, teacher] = await Promise.all([
      Class.findById(classId),
      User.findById(teacherId),
    ]);
    if (!cls) throw fail("Class not found", 404);
    if (!teacher || teacher.role !== "teacher")
      throw fail("Teacher not found", 404);

    if (cls.teachers.some((t) => t.equals(teacher._id)))
      throw fail("This teacher is already assigned to this class", 409);

    cls.teachers.push(teacher._id);
    await cls.save();
    await cls.populate("teachers", "name email");
    ok(res, cls, "Teacher assigned");
  } catch (e) {
    next(e);
  }
}

async function unassignTeacher(req, res, next) {
  try {
    const classId = id(req.params.id);
    const teacherId = id(req.params.teacherId);

    const cls = await Class.findById(classId);
    if (!cls) throw fail("Class not found", 404);

    cls.teachers = cls.teachers.filter((t) => !t.equals(teacherId));
    await cls.save();
    await cls.populate("teachers", "name email");
    ok(res, cls, "Teacher unassigned");
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

async function exportMonthlyAttendance(req, res, next) {
  try {
    const classId = id(req.query.classId);
    await assertClassAccess(req.user, classId);

    const monthStr = req.query.month; // expected "YYYY-MM"
    if (!/^\d{4}-\d{2}$/.test(monthStr || ""))
      throw fail("A valid month (YYYY-MM) is required");

    const [year, monthNum] = monthStr.split("-").map(Number);
    const startDate = new Date(Date.UTC(year, monthNum - 1, 1));
    const lastDayOfMonth = new Date(Date.UTC(year, monthNum, 0));

    const today = new Date();
    const todayUTC = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    if (startDate.getTime() > todayUTC.getTime())
      throw fail("Cannot export a future month");

    // Don't include days beyond today if this is the current month.
    const endDate =
      lastDayOfMonth.getTime() > todayUTC.getTime() ? todayUTC : lastDayOfMonth;

    const [cls, students, records] = await Promise.all([
      Class.findById(classId),
      Student.find({ classId }),
      Attendance.find({ classId, date: { $gte: startDate, $lte: endDate } }),
    ]);
    if (!cls) throw fail("Class not found", 404);

    students.sort((a, b) => {
      const numA = parseInt(a.rollNumber, 10);
      const numB = parseInt(b.rollNumber, 10);
      // Falls back to a plain string comparison if a roll number isn't
      // purely numeric (e.g. "7A"), so the sort never silently breaks.
      if (!Number.isNaN(numA) && !Number.isNaN(numB) && numA !== numB)
        return numA - numB;
      return a.rollNumber.localeCompare(b.rollNumber);
    });

    const dates = [];
    for (
      let d = new Date(startDate);
      d.getTime() <= endDate.getTime();
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      dates.push(new Date(d));
    }

    // dateKey -> (studentId -> status), for fast lookup per row/column.
    const byDate = new Map();
    records.forEach((r) => {
      const key = r.date.toISOString().slice(0, 10);
      const statusMap = new Map();
      r.records.forEach((rec) =>
        statusMap.set(String(rec.studentId), rec.status),
      );
      byDate.set(key, statusMap);
    });

    const monthLabel = startDate.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    const className = cls.section ? `${cls.name} - ${cls.section}` : cls.name;

    const workbook = new ExcelJS.Workbook();
    const safeSheetName = `${className} ${monthLabel}`
      .replace(/[*?:\\/\[\]]/g, "-") // strip characters Excel forbids in sheet names
      .slice(0, 31);
    const sheet = workbook.addWorksheet(safeSheetName);

    const dateHeaders = dates.map((d) =>
      d.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        timeZone: "UTC",
      }),
    );
    sheet.addRow(["Roll No.", "Student Name", ...dateHeaders]);
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { horizontal: "center" };
    sheet.views = [{ state: "frozen", xSplit: 2, ySplit: 1 }];

    students.forEach((s) => {
      const row = [s.rollNumber, s.name];
      dates.forEach((d) => {
        const key = d.toISOString().slice(0, 10);
        const status = byDate.get(key)?.get(String(s._id));
        row.push(status ? (status === "present" ? "Present" : "Absent") : "");
      });
      sheet.addRow(row);
    });

    sheet.columns.forEach((col, i) => {
      col.width = i === 0 ? 12 : i === 1 ? 22 : 11;
      if (i >= 2) col.alignment = { horizontal: "center" };
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${className.replace(/[^\w-]/g, "_")}-${monthStr}.xlsx"`,
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    next(e);
  }
}

module.exports = {
  login,
  me,
  listUsers,
  createUser,
  oneUser,
  updateUser,
  deleteUser,
  listStudents,
  student,
  createStudent,
  updateStudent,
  deleteStudent,
  studentPhoto,
  listClasses,
  oneClass,
  createClass,
  updateClass,
  deleteClass,
  assignTeacher,
  unassignTeacher,
  listAttendance,
  attendance,
  createAttendance,
  updateAttendance,
  deleteAttendance,
  exportMonthlyAttendance,
  dashboard,
};
