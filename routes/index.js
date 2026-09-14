const express = require("express");
const c = require("../controllers/api");
const { auth, requireRole } = require("../middleware");
const { studentUpload } = require("../utils/upload");
const router = express.Router();

const requireAdmin = requireRole("admin");

// Authentication routes
router.post("/auth/login", c.login);
router.get("/auth/me", auth, c.me);

// User management routes (admin only)
router.get("/users", auth, requireAdmin, c.listUsers);
router.get("/users/:id", auth, requireAdmin, c.oneUser);
router.post("/users", auth, requireAdmin, c.createUser);
router.put("/users/:id", auth, requireAdmin, c.updateUser);
router.delete("/users/:id", auth, requireAdmin, c.deleteUser);

// Student routes
router.get("/students", auth, c.listStudents);
router.get("/students/:id", auth, requireAdmin, c.student);
router.get("/students/:id/photo", auth, c.studentPhoto);
router.post("/students", auth, requireAdmin, studentUpload, c.createStudent);
router.put("/students/:id", auth, requireAdmin, studentUpload, c.updateStudent);
router.delete("/students/:id", auth, requireAdmin, c.deleteStudent);

// Class routes — same pattern as students.
router.get("/classes", auth, c.listClasses);
router.get("/classes/:id", auth, c.oneClass);
router.post("/classes", auth, requireAdmin, c.createClass);
router.put("/classes/:id", auth, requireAdmin, c.updateClass);
router.delete("/classes/:id", auth, requireAdmin, c.deleteClass);
router.post("/classes/:id/teachers", auth, requireAdmin, c.assignTeacher);
router.delete(
  "/classes/:id/teachers/:teacherId",
  auth,
  requireAdmin,
  c.unassignTeacher,
);

// Attendance routes — both admin and teacher can take and view attendance.
router.get("/attendance", auth, c.listAttendance);
router.get("/attendance/history", auth, c.listAttendance);
router.get("/attendance/export", auth, c.exportMonthlyAttendance);
router.get("/attendance/:id", auth, c.attendance);
router.post("/attendance", auth, c.createAttendance);
router.put("/attendance/:id", auth, c.updateAttendance);
router.delete("/attendance/:id", auth, requireAdmin, c.deleteAttendance);

// Dashboard route (admin only)
router.get("/dashboard/stats", auth, requireAdmin, c.dashboard);

module.exports = router;
